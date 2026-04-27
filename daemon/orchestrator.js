import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { writeFile as writeFileAsync } from "node:fs/promises";
import path from "node:path";
import { ChannelMemory } from "../lib/channel-memory.js";

/**
 * @typedef {Object} SceneConfig
 * @property {string} name
 * @property {{ cron?: string, rng?: { chance: number, interval: number }, search?: { query: string, schedule: string } }} trigger
 * @property {string} speaker - Which instance speaks (e.g., instance name)
 * @property {string} prompt - Prompt for scene generation
 * @property {number} [turns=1] - For future inter-bot scenes
 */

/**
 * @typedef {Object} SliceOfBreadConfig
 * @property {boolean} enabled
 * @property {string} channelId - Discord channel ID
 * @property {string} primaryInstance - Which instance runs orchestrator
 * @property {SceneConfig[]} scenes
 * @property {number} [cooldown=3600000] - Min time between scenes (default 1h)
 * @property {Object} [botFollowup] - Bot message followup settings
 * @property {boolean} botFollowup.enabled - Enable responding to other bots
 * @property {number} [botFollowup.cooldown=60000] - Min time between bot responses (default 1m)
 * @property {string[]} botFollowup.responders - Instance names that can respond
 * @property {number} [botFollowup.chance=0.5] - Probability of responding (default 50%)
 * @property {string} [botFollowup.promptTemplate] - Prompt template with {speaker}, {content}
 */

/**
 * @typedef {Object} OrchestratorState
 * @property {string} [lastScene]
 * @property {number} [lastSceneTime]
 * @property {Record<string, number>} lastTriggers
 * @property {string[]} recentTopics
 */

const DEFAULT_COOLDOWN = 3600000; // 1 hour
const STATE_FILE = "orchestrator-state.json";

export class SliceOfBreadOrchestrator {
	/**
	 * @param {{
	 *   config: SliceOfBreadConfig,
	 *   discordClient: import('discord.js').Client,
	 *   getSession?: () => Promise<{ send: (prompt: string) => Promise<{ text: string }> }>,
	 *   paths: { workspaceDir: string },
	 *   logger: { info: (event: string, data?: object) => Promise<void>, error: (event: string, data?: object) => Promise<void> },
	 *   instanceName: string,
	 * }} options
	 */
	constructor(options) {
		this.config = options.config;
		this.discordClient = options.discordClient;
		this.getSession = options.getSession;
		this.paths = options.paths;
		this.logger = options.logger;
		this.instanceName = options.instanceName;
		this.presenceManager = options.presenceManager;
		this.presenceConfig = options.presenceConfig;

		this.memory = new ChannelMemory({
			path: `${options.paths.workspaceDir}/../shared-routes/slice-of-bread/memory.json`,
			maxTokens: 8192,
			getSession: options.getSession,
		});

		this.state = this.loadState();
		this.checkInterval = null;
		this.sceneTriggerInterval = null;
		this.cronTimers = new Map();
	}

	/**
	 * Load orchestrator state from disk.
	 * @returns {OrchestratorState}
	 */
	loadState() {
		try {
			const data = readFileSync(`${this.paths.workspaceDir}/${STATE_FILE}`, "utf8");
			return JSON.parse(data);
		} catch {
			return {
				lastScene: undefined,
				lastSceneTime: 0,
				lastTriggers: {},
				recentTopics: [],
			};
		}
	}

	/**
	 * Save orchestrator state to disk.
	 */
	async saveState() {
		await writeFileAsync(
			`${this.paths.workspaceDir}/${STATE_FILE}`,
			JSON.stringify(this.state, null, "\t")
		);
	}

	/**
	 * Start the orchestrator.
	 */
	async start() {
		if (!this.config.enabled) {
			await this.logger.info("orchestrator-disabled", { reason: "config.enabled=false" });
			return;
		}

		await this.logger.info("orchestrator-started", {
			channelId: this.config.channelId,
			scenes: this.config.scenes.map(s => s.name),
		});

		// Start cron timers
		for (const scene of this.config.scenes) {
			if (scene.trigger.cron) {
				this.setupCron(scene);
			}
		}

		// Start periodic RNG checks
		this.checkInterval = setInterval(() => {
			this.checkRngTriggers().catch(err =>
				this.logger.error("rng-check-failed", { error: String(err) })
			);
		}, 60000); // Check RNG every minute

		// Check scene triggers more frequently for responsiveness
		this.sceneTriggerInterval = setInterval(() => {
			this.checkSceneTriggers().catch(err =>
				this.logger.error("scene-trigger-check-failed", { error: String(err) })
			);
		}, 5000); // Check every 5 seconds
	}

	/**
	 * Handle a message from another bot in the slice-of-bread channel.
	 * @param {import('discord.js').Message} message
	 */
	async handleBotMessage(message) {
		// Check if bot followup is enabled
		if (!this.config.botFollowup?.enabled) return;

		// Check cooldown for bot messages (shorter than regular cooldown)
		const botCooldown = this.config.botFollowup.cooldown ?? 60000; // 1 minute default
		if (Date.now() - (this.state.lastBotMessageTime ?? 0) < botCooldown) {
			return;
		}

		// Check if this bot instance should respond
		const respondable = this.config.botFollowup.responders ?? [this.instanceName];
		if (!respondable.includes(this.instanceName)) return;

		// RNG check for response chance
		const chance = this.config.botFollowup.chance ?? 0.5; // 50% chance default
		if (Math.random() > chance) return;

		// Build prompt with context of the other bot's message
		const speakerName = message.author.username;
		const content = message.content || "(no text content)";
		const prompt = this.config.botFollowup.promptTemplate ??
			"Another bot ({speaker}) posted: {content}\n\nReact or respond in character.";

		const fullPrompt = prompt
			.replace("{speaker}", speakerName)
			.replace("{content}", content);

		// Trigger the response
		await this.triggerScene("bot-followup", "bot-message", fullPrompt);

		// Update state
		this.state.lastBotMessageTime = Date.now();
		await this.saveState();
	}

	/**
	 * Stop the orchestrator.
	 */
	async stop() {
		if (this.checkInterval) {
			clearInterval(this.checkInterval);
			this.checkInterval = null;
		}
		if (this.sceneTriggerInterval) {
			clearInterval(this.sceneTriggerInterval);
			this.sceneTriggerInterval = null;
		}
		for (const timer of this.cronTimers.values()) {
			clearTimeout(timer);
		}
		this.cronTimers.clear();
		await this.logger.info("orchestrator-stopped");
	}

	/**
	 * Generate presence schedule based on memory context and scenes.
	 * Called at day refresh (00:00) to create contextual schedule.
	 * @returns {Promise<Array>}
	 */
	async generatePresenceSchedule() {
		const memory = this.memory.getContext();
		const baseSchedule = this.presenceConfig?.base ?? this.getDefaultPresenceBase();
		const sceneEffects = this.getScenePresenceEffects();
		
		// Apply scene effects to base schedule
		const contextualSchedule = baseSchedule.map(marker => {
			// Check if any scene effect modifies this marker
			const effect = sceneEffects.find(e => e.targetMarker === marker.name);
			if (effect) {
				return { ...marker, ...effect.override };
			}
			return marker;
		});
		
		await this.logger.info("presence-schedule-generated", {
			markers: contextualSchedule.map(m => m.name),
		});
		
		return contextualSchedule;
	}
	
	/**
	 * Get default presence base schedule.
	 */
	getDefaultPresenceBase() {
		return [
			{ name: "sleep", status: "idle", activity: "Standby", time: "00:00" },
			{ name: "morning", status: "online", activity: "Online", time: "07:00" },
			{ name: "work", status: "online", activity: "Active", time: "09:00" },
			{ name: "free", status: "online", activity: "Idle", time: "17:00" },
			{ name: "evening", status: "idle", activity: "Power save", time: "22:00" },
		];
	}
	
	/**
	 * Get presence effects from scenes that have them.
	 */
	getScenePresenceEffects() {
		const effects = [];
		const now = Date.now();
		
		for (const scene of this.config.scenes) {
			if (scene.presenceEffect) {
				const lastTrigger = this.state.lastTriggers[scene.name] ?? 0;
				// Effect persists for 24 hours or until next scene
				if (now - lastTrigger < 86400000) {
					effects.push({
						sceneName: scene.name,
						targetMarker: scene.presenceEffect.targetMarker,
						override: scene.presenceEffect.override,
					});
				}
			}
		}
		
		return effects;
	}

	/**
	 * Call on day refresh to update presence schedule.
	 */
	async onDayRefresh() {
		if (!this.presenceManager) return;
		
		const schedule = await this.generatePresenceSchedule();
		await this.presenceManager.setBase(schedule);
		
		await this.logger.info("orchestrator-day-refresh", {
			markers: schedule.map(m => m.name),
		});
	}

	/**
	 * Setup cron trigger for a scene.
	 * @param {SceneConfig} scene
	 */
	setupCron(scene) {
		// Simple cron parser - supports basic patterns like "0 7 * * *"
		const scheduleNext = () => {
			const next = this.getNextCronTime(scene.trigger.cron);
			if (!next) return;

			const delay = next.getTime() - Date.now();
			if (delay < 0) return;

			const timer = setTimeout(async () => {
				await this.triggerScene(scene.name, "cron");
				scheduleNext(); // Schedule next occurrence
			}, delay);

			this.cronTimers.set(scene.name, timer);
		};

		scheduleNext();
	}

	/**
	 * Get next occurrence of cron pattern.
	 * @param {string} pattern
	 * @returns {Date | null}
	 */
	getNextCronTime(pattern) {
		// Simple implementation: only handles "minute hour * * *"
		const parts = pattern.split(" ");
		if (parts.length !== 5) return null;

		const minute = parseInt(parts[0], 10);
		const hour = parseInt(parts[1], 10);

		if (isNaN(minute) || isNaN(hour)) return null;

		const now = new Date();
		const next = new Date();
		next.setHours(hour, minute, 0, 0);

		// If time has passed today, schedule for tomorrow
		if (next <= now) {
			next.setDate(next.getDate() + 1);
		}

		return next;
	}

	/**
	 * Check RNG triggers.
	 */
	async checkRngTriggers() {
		for (const scene of this.config.scenes) {
			if (!scene.trigger.rng) continue;

			const { chance, interval } = scene.trigger.rng;
			const lastTrigger = this.state.lastTriggers[scene.name] ?? 0;

			// Check if interval has passed
			if (Date.now() - lastTrigger < interval) continue;

			// RNG check
			if (Math.random() < chance) {
				await this.triggerScene(scene.name, "rng");
			}
		}
	}

	/**
	 * Check for manual scene trigger files.
	 */
	async checkSceneTriggers() {
		const triggersDir = path.join(this.paths.workspaceDir, "scene-triggers");
		if (!existsSync(triggersDir)) return;

		const files = readdirSync(triggersDir).filter(f => f.endsWith(".json"));
		for (const file of files) {
			const triggerPath = path.join(triggersDir, file);
			try {
				const trigger = JSON.parse(readFileSync(triggerPath, "utf8"));
				unlinkSync(triggerPath);
				await this.triggerScene(trigger.scene, "manual");
			} catch (err) {
				await this.logger.error("scene-trigger-parse-failed", { file, error: String(err) });
				try { unlinkSync(triggerPath); } catch {}
			}
		}
	}

	/**
	 * Trigger a scene by name.
	 * @param {string} sceneName
	 * @param {string} triggerType - "cron" | "rng" | "manual" | "bot-message"
	 * @param {string} [customPrompt] - Optional custom prompt (for ad-hoc triggers)
	 */
	async triggerScene(sceneName, triggerType = "manual", customPrompt = null) {
		const scene = this.config.scenes.find(s => s.name === sceneName);
		
		// For ad-hoc triggers with custom prompt, scene config is optional
		if (!scene && !customPrompt) {
			await this.logger.error("scene-not-found", { sceneName });
			return;
		}

		// Check cooldown (skip for manual and bot-message triggers)
		if (triggerType !== "manual" && triggerType !== "bot-message") {
			const cooldown = this.config.cooldown ?? DEFAULT_COOLDOWN;
			if (Date.now() - (this.state.lastSceneTime ?? 0) < cooldown) {
				await this.logger.info("scene-cooldown", {
					sceneName,
					remaining: cooldown - (Date.now() - (this.state.lastSceneTime ?? 0)),
				});
				return;
			}
		}

		// Check if this instance should speak (skip for ad-hoc triggers)
		if (scene && scene.speaker !== this.instanceName) {
			await this.logger.info("scene-skipped-wrong-speaker", {
				sceneName,
				speaker: scene.speaker,
				thisInstance: this.instanceName,
			});
			return;
		}

		const speaker = scene?.speaker ?? this.instanceName;

		await this.logger.info("scene-triggered", {
			sceneName,
			triggerType,
			speaker,
		});

		try {
			// Set dynamic presence for scene
			if (this.presenceManager && scene?.presence) {
				await this.presenceManager.setActivity(scene.presence, { ttl: 120000 });
			}

			// Get channel (board or regular slice-of-bread)
			const targetChannelId = scene?.board ? this.config.boardChannelId : this.config.channelId;
			if (!targetChannelId) {
				throw new Error(`No channel configured for ${scene?.board ? 'board' : 'slice-of-bread'}`);
			}
			const channel = await this.discordClient.channels.fetch(targetChannelId);
			if (!channel || !channel.isTextBased()) {
				throw new Error(`Channel ${this.config.channelId} not found or not text-based`);
			}

			// Build prompt with memory context (or use custom prompt)
			const memoryContext = this.memory.getContext();
			const fullPrompt = customPrompt ?? this.buildScenePrompt(scene, memoryContext);

			// Generate or use template
			let content;
			if (this.getSession) {
				const session = await this.getSession();
				const result = await session.send(fullPrompt);
				content = typeof result === "string" ? result : result.text ?? String(result);
			} else {
				// Fallback: use prompt directly as content (template mode)
				content = customPrompt ?? scene.prompt;
			}

			// Post to Discord
			await channel.send(content);

			// Log to memory
			this.memory.append({
				scene: sceneName,
				topic: sceneName,
				turns: [{ speaker, text: content }],
			});

			// Update state
			this.state.lastScene = sceneName;
			this.state.lastSceneTime = Date.now();
			if (scene) this.state.lastTriggers[scene.name] = Date.now();
			await this.saveState();

			await this.logger.info("scene-completed", {
				sceneName,
				contentLength: content.length,
			});
			
			// Clear dynamic presence, return to schedule
			await this.presenceManager?.clear();
		} catch (error) {
			await this.presenceManager?.clear();
			await this.logger.error("scene-failed", {
				sceneName,
				error: String(error),
			});
		}
	}

	/**
	 * Build scene prompt with context.
	 * @param {SceneConfig} scene
	 * @param {string} memoryContext
	 * @returns {string}
	 */
	buildScenePrompt(scene, memoryContext) {
		const lines = [];

		lines.push(`Scene: ${scene.name}`);
		lines.push(`Instruction: ${scene.prompt}`);
		lines.push("");

		if (memoryContext) {
			lines.push("## Previous Context");
			lines.push(memoryContext);
			lines.push("");
		}

		lines.push("Respond naturally as your character. Keep it concise (1-3 sentences).");

		return lines.join("\n");
	}

	/**
	 * Get orchestrator status.
	 * @returns {{ enabled: boolean, running: boolean, lastScene: string | undefined, memory: object }}
	 */
	getStatus() {
		return {
			enabled: this.config.enabled,
			running: this.checkInterval !== null,
			lastScene: this.state.lastScene,
			lastSceneTime: this.state.lastSceneTime,
			memory: this.memory.getStats(),
			scenes: this.config.scenes.map(s => ({
				name: s.name,
				trigger: Object.keys(s.trigger)[0],
				speaker: s.speaker,
			})),
		};
	}
}