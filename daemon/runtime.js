import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
	ChannelType,
	Client,
	Events,
	GatewayIntentBits,
	Partials,
} from "discord.js";
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { ensureDir, pathExists, removeIfExists, writeJson } from "../lib/fs.js";
import { getRoutePaths } from "../lib/paths.js";
import { authorizeInteraction } from "./authz.js";
import { ChannelMemory } from "../lib/channel-memory.js";
import { JournalStore } from "./journal.js";
import { Logger } from "./logger.js";
import { SliceOfBreadOrchestrator } from "./orchestrator.js";
import { PresenceManager } from "./presence-manager.js";
import { buildPromptText } from "./prompt-shaper.js";
import { RouteQueueStore } from "./queue-store.js";
import { createRouteManifest, RouteRegistry } from "./registry.js";
import { DiscordRenderer, splitDiscordText } from "./renderer.js";
import { makeRouteKey } from "./route-key.js";
import { RouteSessionHost } from "./session-host.js";

function stripBotMention(content, botId) {
	return content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim();
}

async function toImageContent(filePath, mediaType) {
	const data = await readFile(filePath);
	return {
		type: "image",
		source: {
			type: "base64",
			mediaType,
			data: data.toString("base64"),
		},
	};
}

export class PiDiscordDaemon {
	/**
	 * @param {{
	 *   paths: ReturnType<import('../lib/paths.js').getPaths>,
	 *   config: import('../lib/config.js').PiDiscordConfig,
	 * }} options
	 */
	constructor(options) {
		this.paths = options.paths;
		this.config = options.config;
		this.logger = new Logger(this.paths.daemonLogPath);
		this.registry = new RouteRegistry(this.paths);
		this.client = new Client({
			intents: [
				GatewayIntentBits.Guilds,
				GatewayIntentBits.GuildMessages,
				GatewayIntentBits.GuildMessageReactions,
				GatewayIntentBits.MessageContent,
				GatewayIntentBits.DirectMessages,
			],
			partials: [Partials.Channel, Partials.Message, Partials.Reaction],
		});
		this.routeContexts = new Map();
		this.routePromises = new Map();
		this.currentRuns = new Map();
		this.workerId = `daemon-${process.pid}`;
		this.heartbeat = undefined;
		this.triggerInterval = undefined;
		this.stopping = false;
		this.status = {};
		this.orchestrator = undefined; // Initialized on client ready
		this.presenceManager = undefined; // Initialized on client ready
	}

	runInBackground(label, task, details = {}) {
		void Promise.resolve()
			.then(task)
			.catch(async (error) => {
				await this.logger.error(label, { ...details, error: String(error) });
			});
	}

	async start() {
		await ensureDir(this.paths.workspaceDir);
		await ensureDir(this.paths.runDir);
		await ensureDir(this.paths.logsDir);
		await this.registry.load();
		this.attachEventHandlers();
		await this.writeStatus({ phase: "starting" });
		await this.client.login(this.config.botToken);
		this.heartbeat = setInterval(() => {
			this.runInBackground("status-write-failed", async () => {
				await this.writeStatus({ phase: "running" });
			});
		}, 15_000);
		this.triggerInterval = setInterval(() => {
			this.processTriggers().catch((err) =>
				this.logger.error("trigger-poll-failed", { error: String(err) }),
			);
		}, 30_000);
	}

	async processTriggers() {
		const triggersDir = path.join(this.paths.workspaceDir, "triggers");
		if (!existsSync(triggersDir)) return;
		const files = readdirSync(triggersDir).filter((f) => f.endsWith(".json"));
		for (const file of files) {
			const triggerPath = path.join(triggersDir, file);
			try {
				const trigger = JSON.parse(readFileSync(triggerPath, "utf8"));
				unlinkSync(triggerPath);
				const scope = this.resolveScope(
					trigger.guildId ?? null,
					trigger.channelId,
					null,
				);
				const route = await this.ensureRoute(scope);
				await route.queue.enqueue({
					source: {
						kind: "trigger",
						sourceId: file,
						userId: "",
						guildId: trigger.guildId ?? null,
						channelId: trigger.channelId,
						threadId: null,
						trigger: "proactive",
					},
					payload: {
						rawText: "",
						promptText: trigger.prompt,
						attachments: [],
					},
				});
				await this.scheduleWork();
			} catch (err) {
				this.logger.error("trigger-process-failed", {
					file,
					error: String(err),
				});
				try {
					unlinkSync(triggerPath);
				} catch {}
			}
		}
	}

	attachEventHandlers() {
		this.client.once(Events.ClientReady, async (client) => {
			try {
				await this.logger.info("discord-ready", {
					userId: client.user.id,
					tag: client.user.tag,
				});
				await this.writeStatus({ phase: "ready", userTag: client.user.tag });
				await this.reconcileKnownRoutes();
				await this.processMissedMentions();
				await this.scheduleWork();
				
				// Initialize presence manager if configured
				if (this.config.presence?.enabled) {
					await this.initPresenceManager();
				}

				// Initialize orchestrator if configured
				if (this.config.sliceOfBread?.enabled) {
					await this.initOrchestrator();
				}
				
				// Run route cleanup if enabled
				if (this.config.routeCleanup?.enabled && this.config.routeCleanup.onStartup) {
					await this.cleanupStaleRoutes();
			}
			} catch (err) {
				await this.logger.error("client-ready-error", { error: String(err) });
			}
		});

		this.client.on(Events.MessageCreate, async (message) => {
			try {
				await this.handleMessageCreate(message);
			} catch (error) {
				await this.logger.error("message-create-failed", {
					error: String(error),
				});
			}
		});

		this.client.on(
			Events.MessageUpdate,
			async (_previousMessage, nextMessage) => {
				let message = nextMessage;
				try {
					if (!message?.id || !message.channelId) return;
					if (message.partial) {
						try {
							message = await message.fetch();
						} catch {
							return;
						}
					}
					if (message.author?.bot) return;
					if (
						message.guildId &&
						this.config.allowedGuildIds.length > 0 &&
						!this.config.allowedGuildIds.includes(message.guildId)
					) {
						return;
					}
					if (
						!authorizeInteraction(message, this.config, message.channel).allowed
					)
						return;

					const scope = this.resolveScopeFromChannel(
						message.guildId ?? null,
						message.channelId,
						message.channel,
					);
					const route = await this.getExistingRoute(scope);
					if (!route) return;
					if (
						!route.journal.hasSource(message.id) &&
						!route.queue.hasSource(message.id)
					) {
						return;
					}

					await route.journal.append({
						kind: "edit",
						sourceId: message.id,
						timestamp: Date.now(),
						routeKey: route.manifest.routeKey,
						text: message.content ?? "",
						authorId: message.author?.id,
						authorName:
							message.member?.displayName ?? message.author?.displayName,
					});
					const replyContext = message.reference?.messageId
						? await this.fetchReplyContext(message)
						: undefined;
					await route.queue.replaceQueuedBySource(message.id, (item) => {
						const rawText =
							item.source.trigger === "mention" && this.client.user
								? stripBotMention(
										message.content ?? item.payload.rawText,
										this.client.user.id,
									)
								: (message.content ?? item.payload.rawText);
						item.payload.rawText = rawText;
						item.payload.promptText = buildPromptText({
							routeKey: route.manifest.routeKey,
							scope: route.manifest.scope,
							requester: {
								id: item.source.userId,
								name:
									message.member?.displayName ??
									message.author?.displayName ??
									item.source.userId,
							},
							trigger: item.source.trigger,
							rawText,
							replyContext,
							savedAttachments: item.payload.attachments ?? [],
						});
					});
				} catch (error) {
					await this.logger.error("message-update-failed", {
						error: String(error),
					});
				}
			},
		);

		this.client.on(Events.MessageDelete, async (message) => {
			try {
				if (!message.id || !message.channelId) return;
				if (
					message.guildId &&
					this.config.allowedGuildIds.length > 0 &&
					!this.config.allowedGuildIds.includes(message.guildId)
				) {
					return;
				}
				const scope = this.resolveScopeFromChannel(
					message.guildId ?? null,
					message.channelId,
					message.channel,
				);
				const route = await this.getExistingRoute(scope);
				if (!route) return;
				if (
					!route.journal.hasSource(message.id) &&
					!route.queue.hasSource(message.id)
				) {
					return;
				}
				await route.journal.append({
					kind: "delete",
					sourceId: message.id,
					timestamp: Date.now(),
					routeKey: route.manifest.routeKey,
				});
				await route.queue.cancelQueuedBySource(
					message.id,
					"Source message was deleted before execution.",
				);
			} catch (error) {
				await this.logger.error("message-delete-failed", {
					error: String(error),
				});
			}
		});

		this.client.on(Events.InteractionCreate, async (interaction) => {
			try {
				if (!interaction.isChatInputCommand() && !interaction.isButton())
					return;
				await this.handleInteraction(interaction);
			} catch (error) {
				await this.logger.error("interaction-failed", {
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
				});
				if (interaction.isRepliable()) {
					const responder =
						interaction.deferred || interaction.replied
							? interaction.followUp.bind(interaction)
							: interaction.reply.bind(interaction);
					await responder({ content: String(error), ephemeral: true }).catch(
						() => undefined,
					);
				}
			}
		});

		this.client.on(Events.MessageReactionAdd, async (reaction, user) => {
			try {
				if (user.bot) return;
				if (reaction.partial) await reaction.fetch();
				if (user.partial) await user.fetch();
				const message = reaction.message;
				if (!message.guildId) return;
				const scope = this.resolveScopeFromChannel(
					message.guildId,
					message.channelId,
					message.channel,
				);
				const route = await this.getExistingRoute(scope);
				if (!route) return;
				const member = message.guild?.members?.cache?.get(user.id);
				await route.journal.append({
					kind: "reaction",
					sourceId: `reaction-${message.id}-${user.id}-${reaction.emoji.identifier}`,
					routeKey: route.manifest.routeKey,
					timestamp: Date.now(),
					emoji: reaction.emoji.name ?? reaction.emoji.toString(),
					authorId: user.id,
					authorName: member?.displayName ?? user.displayName ?? user.username,
					targetMessageId: message.id,
				});
			} catch (error) {
				await this.logger.error("reaction-add-failed", {
					error: String(error),
				});
			}
		});
	}

	resolveScope(guildId, channelId, threadId) {
		return {
			guildId,
			channelId,
			threadId,
			routeKey: makeRouteKey({ guildId, channelId, threadId }),
		};
	}

	resolveScopeFromChannel(guildId, channelId, channel) {
		const isThread = channel?.isThread?.() ?? false;
		return this.resolveScope(
			guildId,
			isThread ? (channel.parentId ?? channelId) : channelId,
			isThread ? channel.id : null,
		);
	}

	async getExistingRoute(scope) {
		if (this.routeContexts.has(scope.routeKey)) {
			return this.routeContexts.get(scope.routeKey);
		}
		if (!(await this.registry.loadManifest(scope.routeKey))) {
			return undefined;
		}
		return this.ensureRoute(scope);
	}

	async ensureRoute(scope) {
		if (this.routeContexts.has(scope.routeKey)) {
			return this.routeContexts.get(scope.routeKey);
		}
		if (!this.routePromises.has(scope.routeKey)) {
			const routePromise = this.createRouteContext(scope).finally(() => {
				if (this.routePromises.get(scope.routeKey) === routePromise) {
					this.routePromises.delete(scope.routeKey);
				}
			});
			this.routePromises.set(scope.routeKey, routePromise);
		}
		return this.routePromises.get(scope.routeKey);
	}

	async createRouteContext(scope) {
		if (this.routeContexts.has(scope.routeKey)) {
			return this.routeContexts.get(scope.routeKey);
		}

		const routePaths = getRoutePaths(this.paths, scope.routeKey);
		let manifest = await this.registry.loadManifest(scope.routeKey);
		if (!manifest) {
			const override = this.config.routeOverrides[scope.routeKey] ?? {};
			const workspaceMode = override.mode ?? this.config.workspaceMode;
			const executionRoot =
				workspaceMode === "shared"
					? (override.executionRoot ?? this.config.sharedExecutionRoot)
					: routePaths.dedicatedExecutionRoot;
			if (!executionRoot)
				throw new Error(`No execution root configured for ${scope.routeKey}`);
			const memoryPath =
				workspaceMode === "dedicated"
					? path.join(executionRoot, "discord-memory.md")
					: routePaths.sharedMemoryPath;
			manifest = createRouteManifest({
				routeKey: scope.routeKey,
				scope: {
					guildId: scope.guildId,
					channelId: scope.channelId,
					threadId: scope.threadId,
				},
				workspaceMode,
				executionRoot,
				memoryPath,
				contextLimits: override.contextLimits,
			});
			await ensureDir(executionRoot);
			await ensureDir(path.dirname(memoryPath));
			if (!(await pathExists(memoryPath))) {
				await writeFile(memoryPath, "", "utf8");
			}
			await this.registry.saveManifest(manifest);
		}

		await ensureDir(manifest.executionRoot);
		await ensureDir(path.dirname(manifest.memoryPath));
		if (!(await pathExists(manifest.memoryPath))) {
			await writeFile(manifest.memoryPath, "", "utf8");
		}
		await ensureDir(routePaths.routeDir);
		await ensureDir(routePaths.sessionsDir);
		await ensureDir(routePaths.inboundAttachmentsDir);

		const queue = new RouteQueueStore(
			routePaths.queuePath,
			this.config.queueLeaseMs,
		);
		await queue.load();
		await queue.recoverExpiredLeases();
		const journal = new JournalStore(routePaths.journalPath);
		await journal.load();
		const memory = this.config.enableChannelMemory
			? new ChannelMemory({
				path: routePaths.sharedMemoryPath.replace(".md", ".json"),
				maxTokens: 8192,
			})
			: undefined;
		const renderer = new DiscordRenderer({
			client: this.client,
			manifest,
			logger: this.logger,
			persistManifest: async () => {
				await this.registry.saveManifest(manifest);
			},
			flushMs: this.config.primaryFlushMs,
			enableDetailsThreads: this.config.enableDetailsThreads,
		});
		const host = new RouteSessionHost({
			agentDir: this.paths.agentDir,
			config: this.config,
			manifest,
			routePaths,
			journal,
			memory,
			logger: this.logger,
			uploadFile: (filePath, options) => renderer.uploadFile(filePath, options),
			addReaction: async (emoji) => {
				const sourceId = host.currentSourceId;
				if (!sourceId) throw new Error("No source message to react to");
				const channel = await renderer.getTargetChannel();
				if (!("messages" in channel))
					throw new Error("Channel does not support messages");
				const msg = await channel.messages.fetch(sourceId);
				await msg.react(emoji);
			},
			createThread: async (name, options) => {
				const channel = await renderer.getTargetChannel();
				if (channel.type !== ChannelType.GuildText) {
					throw new Error("Can only create threads in text channels");
				}
				const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
				const threadName = name.includes(dateStr) ? name : `${dateStr}-${name}`;
				const thread = await channel.threads.create({
					name: threadName,
					autoArchiveDuration: 60,
				});
				if (options?.message)
					await thread.send({
						content: options.message,
						allowedMentions: { parse: [] },
					});
				return {
					threadId: thread.id,
					threadUrl: `https://discord.com/channels/${manifest.scope.guildId}/${thread.id}`,
				};
			},
			persistManifest: async () => {
				await this.registry.saveManifest(manifest);
			},
		});

		const context = { manifest, routePaths, queue, journal, memory, renderer, host };
		this.routeContexts.set(scope.routeKey, context);
		this.runInBackground("status-write-failed", async () => {
			await this.writeStatus();
		});
		return context;
	}

	/** Check if a non-mention message is a continuation of an active conversation. */
	isConversationFollowup(route, message) {
		// Reply to a bot message (cache-only check, no API call)
		if (message.reference?.messageId) {
			const ref = message.channel.messages?.cache?.get(
				message.reference.messageId,
			);
			if (ref?.author?.id === this.client.user?.id) return true;
		}

		// Same user who last talked to the bot, and bot responded within 2 minutes
		const entries = route.journal.entries;
		const lastResponse = entries.findLast(
			(e) => e.kind === "assistant-final" || e.kind === "trigger-sent",
		);
		if (!lastResponse || Date.now() - lastResponse.timestamp > 2 * 60 * 1000)
			return false;
		const lastInbound = entries.findLast(
			(e) => e.kind === "inbound" || e.kind === "interaction",
		);
		return lastInbound?.authorId === message.author.id;
	}

	async handleMessageCreate(message) {
		if (!this.client.user) return;
		
		// Handle bot messages for followup (any channel)
		if (message.author?.bot) {
			// Skip self messages
			if (message.author.id === this.client.user.id) return;
			// Pass to followup handler
			if (this.config.botFollowup?.enabled) {
				await this.handleBotFollowup(message);
			}
			// Also pass to orchestrator for board channel
			if (this.orchestrator && message.channelId === this.config.sliceOfBread?.channelId) {
				await this.orchestrator.handleBotMessage(message);
			}
			// Journal other bot messages as ambient context for this bot
			const scope = this.resolveScopeFromChannel(
				message.guildId ?? null,
				message.channelId,
				message.channel,
			);
			const route = await this.getExistingRoute(scope);
			if (route) {
				await route.journal.append({
					kind: "ambient",
					sourceId: message.id,
					routeKey: route.manifest.routeKey,
					timestamp: Date.now(),
					text: message.content ?? "",
					authorId: message.author.id,
					authorName: message.member?.displayName ?? message.author.displayName,
				});
			}
			return;
		}
		const authorization = authorizeInteraction(
			message,
			this.config,
			message.channel,
		);
		if (!authorization.allowed) return;

		const botMentioned =
			message.mentions.users.has(this.client.user.id) ||
			(message.guildId &&
				message.mentions.roles?.some((role) => {
					const botMember = message.guild?.members?.me;
					return botMember?.roles?.cache?.has(role.id);
				}));
		const isDm = !message.guildId;
		
		// If another bot is mentioned and we're not mentioned, skip entirely
		const otherBotMentioned = message.mentions.users?.some?.(user => user.bot && user.id !== this.client.user.id) ?? false;
		if (otherBotMentioned && !botMentioned) return;
		
		if (!botMentioned && !isDm) {
			const scope = this.resolveScopeFromChannel(
				message.guildId ?? null,
				message.channelId,
				message.channel,
			);
			const route = await this.getExistingRoute(scope);
			if (!route) return;
			if (!this.isConversationFollowup(route, message)) {
				await route.journal.append({
					kind: "ambient",
					sourceId: message.id,
					routeKey: route.manifest.routeKey,
					timestamp: Date.now(),
					text: message.content ?? "",
					authorId: message.author.id,
					authorName: message.member?.displayName ?? message.author.displayName,
				});
				return;
			}
			// Followup — fall through to normal processing
		}

		const scope = this.resolveScopeFromChannel(
			message.guildId ?? null,
			message.channelId,
			message.channel,
		);
		const route = await this.ensureRoute(scope);
		if (
			route.journal.hasSource(message.id) ||
			route.queue.hasSource(message.id)
		)
			return;

		const savedAttachments = await this.saveInboundAttachments(
			route,
			message.attachments.values(),
			message.id,
		);
		const replyContext = message.reference?.messageId
			? await this.fetchReplyContext(message)
			: undefined;
		const rawText = botMentioned
			? stripBotMention(message.content ?? "", this.client.user.id)
			: (message.content ?? "");
		const trigger = isDm ? "dm" : botMentioned ? "mention" : "followup";
		
		// Pulse thinking status
		if (typeof message.channel.sendTyping === "function") {
			await message.channel.sendTyping().catch(() => undefined);
		}

		// Self-destructing status message for pings/followups (optional)
		let statusMessageId = undefined;
		if (!isDm && this.config.showThinkingStatus) {
			try {
				const statusMsg = await message.reply({ 
					content: "*Thinking...*", 
					allowedMentions: { repliedUser: false } 
				});
				statusMessageId = statusMsg.id;
			} catch {}
		}

		const promptText = buildPromptText({
			routeKey: route.manifest.routeKey,
			scope: route.manifest.scope,
			requester: {
				id: message.author.id,
				name: message.member?.displayName ?? message.author.displayName,
			},
			trigger,
			rawText,
			replyContext,
			savedAttachments,
		});

		route.manifest.primaryMessageId = undefined;

		await route.journal.append({
			kind: "inbound",
			sourceId: message.id,
			routeKey: route.manifest.routeKey,
			timestamp: Date.now(),
			text: rawText,
			promptText,
			authorId: message.author.id,
			authorName: message.member?.displayName ?? message.author.displayName,
			attachments: savedAttachments,
		});

		await route.queue.enqueue({
			source: {
				kind: "message",
				sourceId: message.id,
				userId: message.author.id,
				guildId: message.guildId ?? null,
				channelId: scope.channelId,
				threadId: scope.threadId,
				trigger,
				isAdmin: authorization.canControl,
				statusMessageId,
				showPrompt: this.config.showThinkingStatus,
			},
			payload: {
				rawText,
				promptText,
				attachments: savedAttachments,
			},
		});
		await this.scheduleWork();
	}

	async handleInteraction(interaction) {
		if (interaction.isButton()) {
			const [namespace, action, routeKey] = interaction.customId.split(":");
			if (namespace !== "pi-discord" || action !== "stop" || !routeKey) {
				return;
			}
			const authorization = authorizeInteraction(
				interaction,
				this.config,
				interaction.channel,
			);
			if (!authorization.allowed) {
				await interaction.reply({
					content: authorization.reason ?? "Not allowed.",
					ephemeral: true,
				});
				return;
			}
			if (!authorization.canControl) {
				await interaction.reply({
					content: "Only admin Discord user ids may stop active runs.",
					ephemeral: true,
				});
				return;
			}
			const stopped = await this.abortRoute(routeKey);
			await interaction.reply({
				content: stopped
					? `Stop requested for ${routeKey}.`
					: `No active run for ${routeKey}.`,
				ephemeral: true,
			});
			return;
		}

		if (!interaction.isChatInputCommand()) return;
		if (interaction.commandName !== this.config.commandName) return;

		const authorization = authorizeInteraction(
			interaction,
			this.config,
			interaction.channel,
		);
		if (!authorization.allowed) {
			if (interaction.isRepliable()) {
				const responder =
					interaction.deferred || interaction.replied
						? interaction.followUp.bind(interaction)
						: interaction.reply.bind(interaction);
				await responder({
					content: authorization.reason ?? "Not allowed.",
					ephemeral: true,
				});
			}
			return;
		}

		const subcommand = interaction.options.getSubcommand();
		if (subcommand === "status") {
			const scope = this.resolveScopeFromChannel(
				interaction.guildId ?? null,
				interaction.channelId,
				interaction.channel,
			);
			const route = await this.getExistingRoute(scope);
			if (!route) {
				await interaction.reply({
					content: `Route ${scope.routeKey} has no saved state yet.`,
					ephemeral: true,
				});
				return;
			}
			const queued = route.queue
				.list()
				.filter((item) => item.state === "queued").length;
			const running = route.queue
				.list()
				.filter(
					(item) => item.state === "running" || item.state === "leased",
				).length;
			await interaction.reply({
				content: `Route ${route.manifest.routeKey}\nQueued: ${queued}\nRunning: ${running}`,
				ephemeral: true,
			});
			return;
		}

		if (subcommand === "stop") {
			if (!authorization.canControl) {
				await interaction.reply({
					content: "Only admin Discord user ids may stop active runs.",
					ephemeral: true,
				});
				return;
			}
			const scope = this.resolveScopeFromChannel(
				interaction.guildId ?? null,
				interaction.channelId,
				interaction.channel,
			);
			const stopped = await this.abortRoute(scope.routeKey);
			await interaction.reply({
				content: stopped
					? `Stop requested for ${scope.routeKey}.`
					: `No active run for ${scope.routeKey}.`,
				ephemeral: true,
			});
			return;
		}

		if (subcommand === "new") {
			if (!authorization.canControl) {
				await interaction.reply({
					content: "Only admin Discord user ids may reset routes.",
					ephemeral: true,
				});
				return;
			}
			const scope = this.resolveScopeFromChannel(
				interaction.guildId ?? null,
				interaction.channelId,
				interaction.channel,
			);
			await this.abortRoute(scope.routeKey);
			const route = await this.getExistingRoute(scope);
			if (!route) {
				await interaction.reply({
					content: `Route ${scope.routeKey} has no saved state to reset.`,
					ephemeral: true,
				});
				return;
			}
			await route.host.dispose();
			route.manifest.sessionFile = undefined;
			await this.registry.saveManifest(route.manifest);
			await interaction.reply({
				content: `Reset route ${scope.routeKey}.`,
				ephemeral: true,
			});
			return;
		}

		if (subcommand === "halt") {
			if (!authorization.canControl) {
				await interaction.reply({
					content: "Only admin Discord user ids may halt.",
					ephemeral: true,
				});
				return;
			}
			const scope = this.resolveScopeFromChannel(
				interaction.guildId ?? null,
				interaction.channelId,
				interaction.channel,
			);
			await this.abortRoute(scope.routeKey);
			const route = await this.getExistingRoute(scope);
			if (route) {
				await route.queue.clear();
				await interaction.reply({
					content: `Halted route ${scope.routeKey} (aborted run + cleared queue).`,
					ephemeral: true,
				});
			} else {
				await interaction.reply({
					content: `Route ${scope.routeKey} not found.`,
					ephemeral: true,
				});
			}
			return;
		}

		if (subcommand === "backup") {
			if (!authorization.canControl) {
				await interaction.reply({
					content: "Only admin Discord user ids may backup memory.",
					ephemeral: true,
				});
				return;
			}
			const scope = this.resolveScopeFromChannel(
				interaction.guildId ?? null,
				interaction.channelId,
				interaction.channel,
			);
			const route = await this.getExistingRoute(scope);
			if (!route) {
				await interaction.reply({
					content: `Route ${scope.routeKey} has no saved state.`,
					ephemeral: true,
				});
				return;
			}
			const routePaths = getRoutePaths(this.paths, route.manifest.routeKey);
			const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
			const memoryJsonPath = routePaths.sharedMemoryPath.replace(".md", ".json");
			try {
				// Backup memory file (.json is actual format)
				if (await pathExists(memoryJsonPath)) {
					const backupPath = path.join(routePaths.routeDir, `memory-backup-${timestamp}.json`);
					const memoryContent = await readFile(memoryJsonPath, "utf8");
					await writeFile(backupPath, memoryContent, "utf8");
					await interaction.reply({
						content: `Backed up memory to ${path.basename(backupPath)}.`,
						ephemeral: true,
					});
				} else if (await pathExists(routePaths.sharedMemoryPath)) {
					const backupPath = path.join(routePaths.routeDir, `memory-backup-${timestamp}.md`);
					const memoryContent = await readFile(routePaths.sharedMemoryPath, "utf8");
					await writeFile(backupPath, memoryContent, "utf8");
					await interaction.reply({
						content: `Backed up memory to ${path.basename(backupPath)}.`,
						ephemeral: true,
					});
				} else {
					await interaction.reply({
						content: "No memory file found to backup.",
						ephemeral: true,
					});
				}
			} catch (err) {
				await interaction.reply({
					content: `Backup failed: ${String(err)}`,
					ephemeral: true,
				});
			}
			return;
		}

		if (subcommand === "wipe") {
			if (!authorization.canControl) {
				await interaction.reply({
					content: "Only admin Discord user ids may wipe routes.",
					ephemeral: true,
				});
				return;
			}
			const doBackup = interaction.options.getBoolean("backup") ?? false;
			const keepMessages = interaction.options.getBoolean("keep-messages") ?? false;
			const targetChannel = interaction.options.getChannel("channel");
			
			// Use target channel or current channel
			const channelId = targetChannel?.id ?? interaction.channelId;
			const guildId = targetChannel?.guildId ?? interaction.guildId;
			const channel = targetChannel ?? interaction.channel;
			
			const scope = this.resolveScopeFromChannel(
				guildId ?? null,
				channelId,
				channel,
			);
			await this.abortRoute(scope.routeKey);
			const route = await this.getExistingRoute(scope);
			
			// Allow wipe on orchestrator channel even without route
			const isOrchChannel = this.config.sliceOfBread?.channelId === channelId;
			if (!route && !isOrchChannel) {
				await interaction.reply({
					content: `Route ${scope.routeKey} has no saved state to wipe.`,
					ephemeral: true,
				});
				return;
			}
			
			await interaction.reply({
				content: "Wiping...",
					ephemeral: true,
			});
			
			let message = "";
			try {
				if (route) {
					await route.host.dispose();
				route.manifest.sessionFile = undefined;
				await this.registry.saveManifest(route.manifest);
				
				const routePaths = getRoutePaths(this.paths, route.manifest.routeKey);
				
				// Optional backup
					if (doBackup) {
						const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
						const memoryJsonPath = routePaths.sharedMemoryPath.replace(".md", ".json");
						if (await pathExists(memoryJsonPath)) {
							const backupPath = path.join(routePaths.routeDir, `memory-backup-${timestamp}.json`);
							const memoryContent = await readFile(memoryJsonPath, "utf8");
							await writeFile(backupPath, memoryContent, "utf8");
							message += `Backed up to ${path.basename(backupPath)}. `;
						}
					}
				
				// Clear journal and memory
				await Promise.all([
					removeIfExists(routePaths.journalPath),
					removeIfExists(routePaths.sharedMemoryPath),
					removeIfExists(routePaths.sharedMemoryPath.replace(".md", ".json")),
				]);
				route.journal.entries.length = 0;
					if (route.memory) {
						route.memory.clear();
					}
					}
				
				// Clear shared memory (orchestrator)
				if (this.orchestrator?.sharedMemoryPath) {
					try {
						await writeFile(this.orchestrator.sharedMemoryPath, JSON.stringify({ entries: [], dismissed: {} }, null, "\t"), "utf8");
						message += "Shared memory cleared. ";
					} catch (e) {}
				}
				
				// Delete bot messages (skip if keep-messages)
				if (!keepMessages) {
					try {
						const messages = await channel.messages.fetch({ limit: 50 });
						const botMsgs = messages.filter(m => m.author.id === this.client.user.id);
						for (const msg of botMsgs.values()) {
							try { await msg.delete(); } catch (e) {}
						}
						message += `Cleared ${botMsgs.size} messages. `;
					} catch (e) {}
				}
				
				// Send separator
				await channel.send({
					content: "[fresh start]",
					allowedMentions: { parse: [] },
				});
				
				await interaction.editReply({
					content: `Wiped. ${message}` || "Done.",
					ephemeral: true,
				});
			} catch (err) {
				await interaction.editReply({
					content: `Wipe failed: ${String(err)}`,
					ephemeral: true,
				});
			}
			return;
		}

		if (subcommand === "regen") {
			const scope = this.resolveScopeFromChannel(
				interaction.guildId ?? null,
				interaction.channelId,
				interaction.channel,
			);
			const route = await this.getExistingRoute(scope);
			if (!route) {
				await interaction.reply({
					content: `Route ${scope.routeKey} has no saved state.`,
					ephemeral: true,
				});
				return;
			}
			
			// Find last bot message in channel
			const channel = interaction.channel;
			const messages = await channel.messages.fetch({ limit: 20 });
			const lastBotMsg = messages.find(m => m.author.id === this.client.user.id);
			
			// Find the last user message that triggered or should have triggered a response
			const lastUserMsg = messages.find(m => !m.author.bot && m.id !== interaction.id);
			
			// If no bot message, we can still "regenerate" (generate for the first time) 
			// if there's a recent user message that mentions the bot or was in DM
			const isDm = !interaction.guildId;
			const mentionsBot = lastUserMsg && (
				lastUserMsg.mentions.users.has(this.client.user.id) ||
				(lastUserMsg.guildId && lastUserMsg.mentions.roles?.some(role => 
					this.client.user.id in (lastUserMsg.guild?.members.me?.roles.cache ?? {})
				))
			);

			if (!lastBotMsg && !(lastUserMsg && (isDm || mentionsBot))) {
				await interaction.reply({
					content: "No bot message or recent mention found to regenerate.",
					ephemeral: true,
				});
				return;
			}
			
			// Check authorization: admin or original caller
			const isOriginalCaller = lastUserMsg && lastUserMsg.author.id === interaction.user.id;
			const canRegenerate = authorization.canControl || isOriginalCaller;
			
			if (!canRegenerate) {
				await interaction.reply({
					content: "Only the original caller or admin may regenerate.",
					ephemeral: true,
				});
				return;
			}
			
			// Get the prompt from the last user message
			let rawText = lastUserMsg?.content ?? "Continue.";
			if (mentionsBot) {
				// Strip bot mention like in handleMessageCreate
				rawText = rawText.replace(/<@!?(\d+)>/g, "").trim();
			}
			const promptText = rawText || "Continue.";
			
			// Queue regeneration
			const queuedItem = await route.queue.enqueue({
				source: {
					kind: "regenerate",
					sourceId: interaction.id,
					isAdmin: authorization.canControl,
					userId: interaction.user.id,
				},
				payload: {
					promptText,
					attachments: [],
					targetMessageId: lastBotMsg?.id,
				},
			});
			
			await interaction.reply({
				content: lastBotMsg ? "Regenerating response..." : "Generating response for recent mention...",
				ephemeral: true,
			});
			
			// Trigger immediate processing
			this.runInBackground("regenerate-queue", async () => {
				await this.scheduleWork();
			});
			
			// Wait for completion with 30s timeout
			const startTime = Date.now();
			const timeout = 30000;
			let completed = false;
			
			this.runInBackground("regen-feedback", async () => {
				while (Date.now() - startTime < timeout) {
					const item = route.queue.list().find(i => i.id === queuedItem.id);
					if (!item || item.state !== "queued") {
						completed = true;
						break;
					}
					await new Promise(r => setTimeout(r, 500));
				}
				
				try {
					if (completed) {
						await interaction.editReply({ content: "Regenerated." });
					} else {
						await interaction.editReply({ content: "Check status" });
					}
				} catch {}
			});
			return;
		}

		if (subcommand === "routes") {
			if (!authorization.canControl) {
				await interaction.reply({
					content: "Only admin Discord user ids may manage routes.",
					ephemeral: true,
				});
				return;
			}

			const wipeOption = interaction.options.getString("wipe");
			const routes = await this.registry.load();
			const routeList = Object.entries(routes);

			if (routeList.length === 0) {
				await interaction.reply({
					content: "No routes found.",
					ephemeral: true,
				});
				return;
			}

			// Filter stale routes if wipe option specified
			const now = Date.now();
			const staleRoutes = [];

			for (const [routeKey, route] of routeList) {
				const manifest = await this.registry.loadManifest(routeKey);
				if (!manifest) continue;

				// Check last activity from manifest
				let lastActivity = 0;
				try {
					const routePaths = getRoutePaths(this.paths, routeKey);
					const journal = new JournalStore(routePaths.journalPath);
					await journal.load();
					const entries = journal.list();
					if (entries.length > 0) {
						lastActivity = Math.max(...entries.map(e => e.timestamp || 0));
					}
				} catch {}

				const daysSinceActive = (now - lastActivity) / (1000 * 60 * 60 * 24);
				const isStale = wipeOption === "all" ||
					(wipeOption && daysSinceActive >= parseInt(wipeOption));

				if (isStale) {
					staleRoutes.push({ routeKey, lastActivity, daysSinceActive });
				}
			}

			if (!wipeOption) {
				// Just list routes
				const lines = routeList.map(([key, route]) => {
					const scope = route.scope;
					const location = scope.guildId ? `guild/${scope.guildId}` : "DM";
					const channel = scope.channelId;
					return `${key.split("root")[0] || key} (${location} ${channel})`;
				});
				await interaction.reply({
					content: `**Routes (${routeList.length})**:\n${lines.slice(0, 20).join("\n")}${lines.length > 20 ? `\n... and ${lines.length - 20} more` : ""}`,
					ephemeral: true,
				});
				return;
			}

			if (staleRoutes.length === 0) {
				await interaction.reply({
					content: `No stale routes found (older than ${wipeOption === "all" ? "any time" : `${wipeOption} days`}).`,
					ephemeral: true,
				});
				return;
			}

			// Wipe stale routes
			let wiped = 0;
			for (const { routeKey } of staleRoutes) {
				try {
					await this.abortRoute(routeKey);
					await this.registry.deleteManifest(routeKey);
					wiped++;
				} catch {}
			}

			await interaction.reply({
				content: `Wiped ${wiped} stale route(s).`,
				ephemeral: true,
			});
			return;
		}

		if (subcommand === "scene") {
			const prompt = interaction.options.getString("prompt", true);
			const context = interaction.options.getString("context") ?? "";
			const participantsStr = interaction.options.getString("participants") ?? "";
			const turns = interaction.options.getInteger("turns") ?? 2;
			
			// Parse participants
			const participants = participantsStr
				.split(",")
				.map(p => p.trim().toLowerCase())
				.filter(p => p.length > 0);
			
			// Create ephemeral reply first
			await interaction.reply({
				content: "Triggering scene...",
				ephemeral: true,
			});
			
			// Trigger scene via orchestrator
			if (this.orchestrator && this.config.sliceOfBread?.enabled) {
				const scenePrompt = context ? `${prompt}\n\nContext: ${context}` : prompt;
				await this.orchestrator.triggerScene("manual", scenePrompt, {
					participants,
					turns,
					startedBy: interaction.user.id,
				});
				await interaction.editReply({
					content: `Scene triggered (${turns} turns${participants.length > 0 ? `, participants: ${participants.join(", ")}` : ""}): ${prompt.slice(0, 80)}${prompt.length > 80 ? "..." : ""}`,
					ephemeral: true,
				});
			} else {
				// Write trigger file for daemon to pick up
				const triggersDir = path.join(this.paths.workspaceDir, "scene-triggers");
				if (!existsSync(triggersDir)) {
					mkdirSync(triggersDir, { recursive: true });
				}
				const triggerFile = path.join(triggersDir, `manual-${Date.now()}.json`);
				writeFileSync(triggerFile, JSON.stringify({
					scene: "manual",
					prompt: context ? `${prompt}\n\nContext: ${context}` : prompt,
					participants,
					turns,
					triggeredAt: Date.now(),
					startedBy: interaction.user.id,
				}), "utf8");
				await interaction.editReply({
					content: `Scene queued (${turns} turns${participants.length > 0 ? `, participants: ${participants.join(", ")}` : ""}): ${prompt.slice(0, 80)}${prompt.length > 80 ? "..." : ""}`,
					ephemeral: true,
				});
			}
			return;
		}

		if (subcommand !== "ask" && subcommand !== "routes") return;

		const rawText = interaction.options.getString("text", true).trim();
		const scope = this.resolveScopeFromChannel(
			interaction.guildId ?? null,
			interaction.channelId,
			interaction.channel,
		);
		const route = await this.ensureRoute(scope);
		if (
			route.journal.hasSource(interaction.id) ||
			route.queue.hasSource(interaction.id)
		) {
			await interaction.reply({
				content: "That interaction was already queued.",
				ephemeral: true,
			});
			return;
		}

		const promptText = buildPromptText({
			routeKey: route.manifest.routeKey,
			scope: route.manifest.scope,
			requester: {
				id: interaction.user.id,
				name: interaction.user.displayName,
			},
			trigger: "slash-command",
			rawText,
			savedAttachments: [],
		});

		await interaction.deferReply({ ephemeral: true });
		const reply = await interaction.editReply({
			content: this.config.showThinkingStatus ? "Processing..." : "...",
		});
		route.manifest.primaryMessageId = reply.id;
		await this.registry.saveManifest(route.manifest);

		await route.journal.append({
			kind: "interaction",
			sourceId: interaction.id,
			routeKey: route.manifest.routeKey,
			timestamp: Date.now(),
			text: rawText,
			promptText,
			authorId: interaction.user.id,
			authorName: interaction.user.displayName,
		});

		// Also append to compressed memory
		if (route.memory) {
			route.memory.append({
				turns: [{ speaker: interaction.user.displayName ?? "user", text: rawText }],
			});
		}

		const queuedItem = await route.queue.enqueue({
			source: {
				kind: "interaction",
				sourceId: interaction.id,
				userId: interaction.user.id,
				guildId: interaction.guildId ?? null,
				channelId: scope.channelId,
				threadId: scope.threadId,
				trigger: "slash-command",
				isAdmin: authorization.canControl,
				showPrompt: this.config.showThinkingStatus,
			},
			payload: {
				rawText,
				promptText,
				attachments: [],
			},
		});
		await this.scheduleWork();
		
		// Wait for completion with 30s timeout
		const startTime = Date.now();
		const timeout = 30000;
		let completed = false;
		
		this.runInBackground("ask-feedback", async () => {
			while (Date.now() - startTime < timeout) {
				const item = route.queue.list().find(i => i.id === queuedItem.id);
				if (!item || item.state !== "queued") {
					completed = true;
					break;
				}
				await new Promise(r => setTimeout(r, 500));
			}
			
			try {
				if (completed) {
					await interaction.editReply({ content: "Done." });
				} else {
					await interaction.editReply({ content: "Check status" });
				}
			} catch {}
		});
	}

	async saveInboundAttachments(route, attachments, sourceId) {
		const saved = [];
		for (const attachment of attachments) {
			const extension = path.extname(attachment.name ?? "") || ".bin";
			const filePath = path.join(
				route.routePaths.inboundAttachmentsDir,
				`${sourceId}-${attachment.id}${extension}`,
			);
			const response = await fetch(attachment.url);
			if (!response.ok) {
				throw new Error(
					`Failed to download attachment ${attachment.url}: ${response.status}`,
				);
			}
			const buffer = Buffer.from(await response.arrayBuffer());
			await writeFile(filePath, buffer);
			saved.push({
				id: attachment.id,
				path: filePath,
				name: attachment.name ?? path.basename(filePath),
				contentType: attachment.contentType ?? undefined,
				isImage: (attachment.contentType ?? "").startsWith("image/"),
			});
		}
		return saved;
	}

	async fetchReplyContext(message) {
		try {
			const replied = await message.fetchReference();
			return `${replied.member?.displayName ?? replied.author?.displayName ?? "unknown"}: ${(replied.content ?? "").slice(0, 400)}`;
		} catch {
			return undefined;
		}
	}

	async scheduleWork() {
		if (this.stopping) return;
		for (const route of this.routeContexts.values()) {
			if (this.currentRuns.size >= this.config.globalConcurrency) return;
			if (this.currentRuns.has(route.manifest.routeKey)) continue;
			const leased = await route.queue.leaseNext(this.workerId);
			if (!leased) continue;
			this.currentRuns.set(route.manifest.routeKey, {
				abort: async () => {
					const session = await route.host.ensureSession();
					await session.abort();
				},
			});
			this.runInBackground(
				"status-write-failed",
				async () => {
					await this.writeStatus();
				},
				{ routeKey: route.manifest.routeKey },
			);
			void this.processQueueItem(route, leased)
				.catch(async (error) => {
					await this.logger.error("queue-item-processing-failed", {
						routeKey: route.manifest.routeKey,
						itemId: leased.id,
						error: String(error),
					});
				})
				.finally(() => {
					this.currentRuns.delete(route.manifest.routeKey);
					this.runInBackground(
						"status-write-failed",
						async () => {
							await this.writeStatus();
						},
						{ routeKey: route.manifest.routeKey },
					);
					this.runInBackground(
						"schedule-work-failed",
						async () => {
							await this.scheduleWork();
						},
						{ routeKey: route.manifest.routeKey },
					);
				});
		}
	}

	async processQueueItem(route, leasedItem) {
		let heartbeat;
		let typingHeartbeat;
		let unsubscribe = () => undefined;
		const isTrigger = leasedItem.source.kind === "trigger";
		let assistantText = "";

		try {
			// Set dynamic presence while processing
			if (this.presenceManager) {
				await this.presenceManager.setActivity("processing", { ttl: 300000 });
			}
			
			await route.queue.markRunning(leasedItem.id);
			await route.renderer.renderRunning(leasedItem);
			
			// Pulse typing indicator during processing (Discord expires after ~10s)
			if (!this.config.showThinkingStatus && leasedItem.source.kind !== "interaction") {
				const channel = await route.renderer.getTargetChannel().catch(() => undefined);
				if (channel && typeof channel.sendTyping === "function") {
					await channel.sendTyping().catch(() => undefined);
					typingHeartbeat = setInterval(() => {
						channel.sendTyping().catch(() => undefined);
					}, 8000);
				}
			}
			
			route.host.currentSourceId = leasedItem.source.sourceId;
			const session = await route.host.ensureSession();
			await this.registry.saveManifest(route.manifest);

			heartbeat = setInterval(
				() => {
					this.runInBackground(
						"queue-heartbeat-failed",
						async () => {
							await route.queue.heartbeat(leasedItem.id);
						},
						{ routeKey: route.manifest.routeKey, itemId: leasedItem.id },
					);
				},
				Math.max(1_000, Math.floor(this.config.queueLeaseMs / 3)),
			);

			unsubscribe = session.subscribe((event) => {
				if (
					event.type === "message_update" &&
					event.assistantMessageEvent?.type === "text_delta"
				) {
					assistantText += event.assistantMessageEvent.delta;
				}
			});

			const modelSupportsImages =
				this.config.enableImageInput &&
				(session.model?.input?.includes?.("image") ?? false);
			const images = modelSupportsImages
				? await Promise.all(
						leasedItem.payload.attachments
							.filter(
								(attachment) => attachment.isImage && attachment.contentType,
							)
							.map((attachment) =>
								toImageContent(attachment.path, attachment.contentType),
							),
					)
				: [];

			// Set permissions for this request
			const isAdmin = leasedItem.source.isAdmin ?? false;
			const toolPermissions = this.config.toolPermissions ?? {
				adminOnly: ["bash", "edit", "write"],
				disabled: [],
			};
			route.host.currentIsAdmin = isAdmin;
			route.host.currentToolPermissions = toolPermissions;

			// Apply tool permissions (disable/remove tools)
			const allTools = session.getActiveToolNames();
			const adminOnly = toolPermissions.adminOnly ?? [];
			const disabled = toolPermissions.disabled ?? [];
			const allowedTools = allTools.filter((name) => {
				if (disabled.includes(name)) return false;
				// Admin-only tools are kept but will return permission error on execution
				return true;
			});
			if (allowedTools.length !== allTools.length) {
				session.setActiveToolsByName(allowedTools);
			}

			await session.prompt(leasedItem.payload.promptText, {
				expandPromptTemplates: false,
				source: "extension",
				images,
			});
			route.manifest.sessionFile = session.sessionFile;
			await this.registry.saveManifest(route.manifest);
			await route.queue.finish(leasedItem.id, "completed");

			const shouldPost =
				assistantText.trim() &&
				!(isTrigger && assistantText.includes("[NO_OUTREACH]"));
			const isRegenerate = leasedItem.source.kind === "regenerate";
			
			if (shouldPost || isRegenerate) {
				const channel = await route.renderer.getTargetChannel();
			
				if (isRegenerate && leasedItem.payload.targetMessageId) {
					// Edit existing message for regenerate
					try {
						const targetMsg = await channel.messages.fetch(leasedItem.payload.targetMessageId);
						const chunks = splitDiscordText(assistantText.trim() || "(empty response)");
						await targetMsg.edit({ content: chunks[0] ?? "(empty)" });
						// If multiple chunks, post additional messages
						for (const chunk of chunks.slice(1)) {
							await channel.send({
								content: chunk,
								allowedMentions: { parse: [] },
							});
						}
					} catch (editErr) {
						// Message might be deleted, send as new
						for (const chunk of splitDiscordText(assistantText)) {
							await channel.send({
								content: chunk,
								allowedMentions: { parse: [] },
							});
						}
					}
				} else {
					// Normal send
					for (const chunk of splitDiscordText(assistantText)) {
						await channel.send({
							content: chunk,
							allowedMentions: { parse: [] },
						});
					}
				}
			}

			let journalKind = "assistant-final";
			if (isTrigger) {
				journalKind = assistantText.includes("[NO_OUTREACH]")
					? "trigger-suppressed"
					: "trigger-sent";
			}
			await route.journal.append({
				kind: journalKind,
				routeKey: route.manifest.routeKey,
				timestamp: Date.now(),
				sourceId: leasedItem.id,
				text: assistantText,
			});
			
			// Also append to compressed memory
			if (route.memory && assistantText.trim()) {
				route.memory.append({
					turns: [{ speaker: "assistant", text: assistantText }],
				});
			}
		} catch (error) {
			const text = String(error);
			const nextState = /abort/i.test(text) ? "cancelled" : "failed";
			await route.queue.finish(leasedItem.id, nextState, text);
			await this.registry.saveManifest(route.manifest);
			await route.journal.append({
				kind:
					nextState === "cancelled" ? "assistant-cancelled" : "assistant-error",
				routeKey: route.manifest.routeKey,
				timestamp: Date.now(),
				sourceId: leasedItem.id,
				error: text,
			});
			if (!isTrigger) {
				const errorMsg =
					nextState === "cancelled"
						? "Run stopped."
						: `Something went wrong. (${text.slice(0, 200)})`;
				const channel = await route.renderer
					.getTargetChannel()
					.catch(() => undefined);
				if (channel) {
					await channel
						.send({ content: errorMsg, allowedMentions: { parse: [] } })
						.catch(() => undefined);
				}
			}
		} finally {
			route.host.currentSourceId = undefined;
			if (heartbeat) clearInterval(heartbeat);
			if (typingHeartbeat) clearInterval(typingHeartbeat);
			unsubscribe();
			
			// Clear dynamic presence, return to schedule
			await this.presenceManager?.clear();
		}
	}

	async abortRoute(routeKey) {
		const active = this.currentRuns.get(routeKey);
		if (active) {
			await active.abort();
			return true;
		}
		return false;
	}

	async cleanupStaleRoutes() {
		const maxAgeDays = this.config.routeCleanup?.maxAgeDays ?? 30;
		const now = Date.now();
		const cutoffMs = maxAgeDays * 24 * 60 * 60 * 1000;
		const routes = await this.registry.load();
		let wiped = 0;

		for (const [routeKey] of Object.entries(routes)) {
			try {
				const manifest = await this.registry.loadManifest(routeKey);
				if (!manifest) continue;

				// Check last activity from journal
				let lastActivity = 0;
				const routePaths = getRoutePaths(this.paths, routeKey);
				try {
					const journal = new JournalStore(routePaths.journalPath);
					await journal.load();
					const entries = journal.list();
					if (entries.length > 0) {
						lastActivity = Math.max(...entries.map(e => e.timestamp || 0));
					}
				} catch {}

				if (now - lastActivity > cutoffMs) {
					await this.abortRoute(routeKey);
					await this.registry.deleteManifest(routeKey);
					wiped++;
				}
			} catch {}
		}

		if (wiped > 0) {
			await this.logger.info("route-cleanup", { wiped, maxAgeDays });
		}
	}

	async reconcileKnownRoutes() {
		for (const summary of this.registry.list()) {
			try {
				const route = await this.ensureRoute({
					...summary.scope,
					routeKey: summary.routeKey,
				});
				const channel = await this.client.channels.fetch(
					route.manifest.scope.threadId ?? route.manifest.scope.channelId,
				);
				if (!channel || !("messages" in channel)) continue;
				const recent = await channel.messages.fetch({ limit: 15 });
				for (const message of [...recent.values()].reverse()) {
					if (message.author?.bot) continue;
					if (!authorizeInteraction(message, this.config, channel).allowed)
						continue;
					if (route.journal.hasSource(message.id)) continue;
					await route.journal.append({
						kind: "ambient",
						sourceId: message.id,
						routeKey: route.manifest.routeKey,
						timestamp: message.createdTimestamp,
						text: message.content ?? "",
						authorId: message.author?.id,
						authorName:
							message.member?.displayName ?? message.author?.displayName,
					});
				}
			} catch (error) {
				await this.logger.warn("route-reconcile-failed", {
					routeKey: summary.routeKey,
					error: String(error),
				});
			}
		}
	}

	async processMissedMentions() {
		// Process the most recent mention for each route that happened while offline
		for (const summary of this.registry.list()) {
			try {
				const route = await this.getExistingRoute({ routeKey: summary.routeKey });
				if (!route) continue;

				const channel = await this.client.channels.fetch(
					route.manifest.scope.threadId ?? route.manifest.scope.channelId,
				);
				if (!channel || !("messages" in channel)) continue;

				// Fetch recent messages
				const recent = await channel.messages.fetch({ limit: 20 });
				
				// Find the most recent message that mentions the bot
				let lastMention = null;
				for (const message of recent.values()) {
					if (message.author?.bot) continue;
					const isMention = message.mentions.users.has(this.client.user.id) ||
						(message.guildId && message.mentions.roles?.some(role =>
							this.client.user.id in (message.guild?.members.me?.roles.cache ?? {})
						));
					if (!isMention) continue;
					if (route.journal.hasSource(message.id)) continue;
					lastMention = message;
					break; // Only get the most recent
				}

				if (lastMention) {
					await this.logger.info("processing-missed-mention", {
						routeKey: summary.routeKey,
						messageId: lastMention.id,
					});
					// Process it like a normal mention
					await this.handleMessageCreate(lastMention);
				}
			} catch (error) {
				await this.logger.warn("missed-mention-failed", {
					routeKey: summary.routeKey,
					error: String(error),
				});
			}
		}
	}

	async writeStatus(extra = {}) {
		this.status = {
			...this.status,
			...extra,
			pid: process.pid,
			routeCount: this.registry.list().length,
			activeRuns: [...this.currentRuns.keys()],
		};
		await writeJson(this.paths.statusPath, this.status);
	}

	async initPresenceManager() {
		this.presenceManager = new PresenceManager({
			config: this.config.presence ?? {},
			client: this.client,
			workspaceDir: this.paths.workspaceDir,
			logger: this.logger,
		});
		this.presenceManager.start();
		await this.logger.info("presence-manager-started");
	}

	async initOrchestrator() {
		const instanceName = this.config.sliceOfBread?.primaryInstance ?? this.client.user?.tag?.split('#')[0] ?? "unknown";
		
		// Session will be created lazily
		this.orchestratorSession = null;
		
		// Create session getter for orchestrator
		const getSession = async () => {
			if (!this.orchestratorSession) {
				this.orchestratorSession = await this.createOrchestratorSession();
			}
			// Wrap session to provide simple send interface
			return {
				send: async (promptText) => {
					let result = "";
					const unsubscribe = this.orchestratorSession.subscribe((event) => {
						if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
							result += event.assistantMessageEvent.delta;
						}
					});
					await this.orchestratorSession.prompt(promptText);
					unsubscribe();
					return { text: result || promptText };
				},
			};
		};

		this.orchestrator = new SliceOfBreadOrchestrator({
			config: this.config.sliceOfBread,
			discordClient: this.client,
			getSession,
			paths: this.paths,
			logger: this.logger,
			instanceName,
			presenceManager: this.presenceManager,
			presenceConfig: this.config.presence,
		});
		
		// Wire orchestrator's day refresh to presence manager
		if (this.presenceManager) {
			this.presenceManager.onDayRefresh = () => this.orchestrator.onDayRefresh();
		}

		await this.orchestrator.start();
		await this.logger.info("orchestrator-initialized", {
			instanceName,
			scenes: this.config.sliceOfBread?.scenes?.map(s => s.name) ?? [],
		});
	}

	async createOrchestratorSession() {
		const agentDir = this.paths.agentDir;
		const authStorage = AuthStorage.create(`${agentDir}/auth.json`);
		const modelRegistry = await ModelRegistry.create(authStorage, `${agentDir}/models.json`);
		const settingsManager = SettingsManager.create(this.paths.workspaceDir, agentDir);

		// Get system prompt from config
		let systemPrompt = this.config.systemPrompt ?? "";
		
		// Inject lore context if available
		const loreContext = this.loadLoreContext();
		if (loreContext) {
			systemPrompt = systemPrompt + "\n\n" + loreContext;
		}

		// Check if search is enabled for orchestrator
		const searchEnabled = this.config.sliceOfBread?.searchEnabled ?? false;

		const resourceLoader = new DefaultResourceLoader({
			cwd: this.paths.workspaceDir,
			agentDir,
			settingsManager,
			noExtensions: !searchEnabled,
			noPromptTemplates: true,
			noThemes: true,
			systemPrompt,
		});
		await resourceLoader.reload();

		const sessionsDir = path.join(this.paths.workspaceDir, "orchestrator-sessions");
		await ensureDir(sessionsDir);
		const sessionManager = SessionManager.create(this.paths.workspaceDir, sessionsDir);

		// Get model from config
		let model;
		const agentModel = this.config.defaultModel;
		if (agentModel) {
			const [provider, ...rest] = agentModel.split("/");
			if (provider && rest.length > 0) {
				model = modelRegistry.find(provider, rest.join("/"));
			}
		}

		const { session } = await createAgentSession({
			cwd: this.paths.workspaceDir,
			agentDir,
			authStorage,
			modelRegistry,
			sessionManager,
			settingsManager,
			resourceLoader,
			model,
			thinkingLevel: this.config.defaultThinkingLevel ?? "medium",
		});

		return session;
	}

	/**
	 * Load lore context from the lorebook file.
	 * @returns {string | null}
	 */
	loadLoreContext() {
		const lorePaths = [
			path.join(this.paths.workspaceDir, "lore/blue-archive-lore.json"),
			path.join(homedir(), ".pi/agent/pi-discord-instances/plana/workspace/lore/blue-archive-lore.json"),
			path.join(homedir(), ".pi/agent/pi-discord-instances/arona/workspace/lore/blue-archive-lore.json"),
		];

		for (const lorePath of lorePaths) {
			if (existsSync(lorePath)) {
				try {
					const data = readFileSync(lorePath, "utf8");
					const lore = JSON.parse(data);
					return this.formatLoreContext(lore);
				} catch {
					// Continue to next path
				}
			}
		}
		return null;
	}

	/**
	 * Format lore object into context string.
	 * @param {object} lore
	 * @returns {string}
	 */
	formatLoreContext(lore) {
		const lines = ["## Blue Archive Lore Reference"];

		// Characters
		if (lore.characters) {
			lines.push("\n### Characters");
			for (const [name, data] of Object.entries(lore.characters)) {
				lines.push(`**${name}**:`);
				if (data.role) lines.push(`  Role: ${data.role}`);
				if (data.affiliation) lines.push(`  Affiliation: ${data.affiliation}`);
				if (data.personality) lines.push(`  Personality: ${data.personality.join(", ")}`);
				if (data.loreNotes) lines.push(`  Notes: ${data.loreNotes.join("; ")}`);
			}
		}

		// Locations
		if (lore.locations) {
			lines.push("\n### Locations");
			for (const [name, data] of Object.entries(lore.locations)) {
				lines.push(`**${name}**: ${data.description || data.fullName || ""}`);
			}
		}

		// Schools
		if (lore.schools) {
			lines.push("\n### Schools");
			for (const [name, data] of Object.entries(lore.schools)) {
				lines.push(`**${name}**: ${data.theme || ""}. ${data.characteristics || ""}`);
			}
		}

		// Terminology
		if (lore.terminology) {
			lines.push("\n### Key Terms");
			for (const [term, def] of Object.entries(lore.terminology)) {
				lines.push(`**${term}**: ${def}`);
			}
		}

		return lines.join("\n");
	}

	/**
	 * Handle followup to another bot's message.
	 * @param {import('discord.js').Message} message
	 */
	async handleBotFollowup(message) {
		const config = this.config.botFollowup;

		// Check if bot is available for followup (online presence)
		if (this.presenceManager) {
			const info = this.presenceManager.getInfo();
			if (info.status !== "online") return; // Skip if not available
		}

		// Check cooldown
		const cooldown = config.cooldown ?? 60000;
		if (Date.now() - (this.lastBotFollowup ?? 0) < cooldown) return;

		// Determine if this bot should respond
		const instanceTag = this.client.user?.tag?.split('#')[0]?.toLowerCase() ?? 'unknown';
		const responders = config.responders ?? [];
		
		// Check for active scene turn first
		let sceneTurn = null;
		if (this.orchestrator) {
			const turnCheck = this.orchestrator.checkSceneTurn();
			if (turnCheck.shouldRespond) {
				sceneTurn = turnCheck.turnState;
			}
		}
		
		// If scene turn, bypass normal followup checks
		if (sceneTurn) {
			try {
				const session = await this.createOrchestratorSession();
				const sharedContext = this.orchestrator.getSharedMemoryContext(10);
				const prompt = `Continue the conversation. Recent messages:\n${sharedContext}\n\nRespond as your character. Keep it brief.`;
				
				let response = "";
				const unsubscribe = session.subscribe((event) => {
					if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
						response += event.assistantMessageEvent.delta;
					}
				});
				await session.prompt(prompt);
				unsubscribe();

				if (response) {
					await message.channel.send(response);
					this.lastBotFollowup = Date.now();
					await this.orchestrator.advanceSceneTurn();
				}
			} catch (err) {
				await this.logger.error("scene-turn-failed", { error: String(err) });
			}
			return;
		}
		
		// Normal followup logic
		if (responders.length > 0 && !responders.includes(instanceTag)) return;

		// Check for explicit mentions (name or patterns)
		const content = message.content ?? "";
		const mentionPatterns = config.mentionPatterns ?? [];
		const isMentioned = mentionPatterns.some(pattern => {
			try {
				// Support /pattern/i format
				if (pattern.startsWith('/') && pattern.endsWith('/i')) {
					const regexStr = pattern.slice(1, -2);
					return new RegExp(regexStr, 'i').test(content);
				}
				// Support plain strings
				return content.toLowerCase().includes(pattern.toLowerCase());
			} catch {
				return false;
			}
		});

		// Determine if we should respond
		let shouldRespond = false;
		let responsePrompt = config.promptTemplate ?? "{speaker} posted: {content}\n\nReact or respond in character.";

		if (isMentioned) {
			// Mentioned by name - guaranteed response
			shouldRespond = true;
			// Use stronger prompt for mentions
			if (config.mentionPromptTemplate) {
				responsePrompt = config.mentionPromptTemplate;
			}
		} else if (config.requireMention) {
			// Only respond to mentions, skip
			return;
		} else {
			// Chance-based response
			if (Math.random() > (config.chance ?? 0.5)) return;
			shouldRespond = true;
		}

		// Build response prompt
		const speaker = message.author.username;
		const fullPrompt = responsePrompt
			.replace(/{speaker}/g, speaker)
			.replace(/{content}/g, content)
			.replace(/{self}/g, instanceTag);

		// Generate response
		try {
			const session = await this.createOrchestratorSession();
			let response = "";
			const unsubscribe = session.subscribe((event) => {
				if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
					response += event.assistantMessageEvent.delta;
				}
			});
			await session.prompt(fullPrompt);
			unsubscribe();

			if (response) {
				await message.channel.send(response);
				this.lastBotFollowup = Date.now();
			}
		} catch (err) {
			await this.logger.error("bot-followup-failed", { error: String(err) });
		}
	}

	async stop() {
		this.stopping = true;
		if (this.heartbeat) clearInterval(this.heartbeat);
		if (this.triggerInterval) clearInterval(this.triggerInterval);
		if (this.presenceManager) this.presenceManager.stop();
		if (this.orchestrator) await this.orchestrator.stop();
		for (const active of this.currentRuns.values()) {
			await active.abort().catch(() => undefined);
		}
		this.currentRuns.clear();
		for (const route of this.routeContexts.values()) {
			await route.host.dispose();
		}
		await this.writeStatus({ phase: "stopping" });
		this.client.destroy();
		await removeIfExists(this.paths.pidPath);
		await removeIfExists(this.paths.lockPath);
	}
}
