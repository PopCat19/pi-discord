import { readFileSync } from "node:fs";
import { writeFile as writeFileAsync } from "node:fs/promises";
import { ChannelMemory } from "../lib/channel-memory.js";

/**
 * @typedef {Object} SceneConfig
 * @property {string} name
 * @property {{ cron?: string, rng?: { chance: number, interval: number }, search?: { query: string, schedule: string } }} trigger
 * @property {string} speaker - Which instance speaks ("plana" | "arona")
 * @property {string} prompt - Prompt for scene generation
 * @property {number} [turns=1] - For future inter-bot scenes
 */

/**
 * @typedef {Object} SliceOfLifeConfig
 * @property {boolean} enabled
 * @property {string} channelId - Discord channel ID
 * @property {string} primaryInstance - Which instance runs orchestrator
 * @property {SceneConfig[]} scenes
 * @property {number} [cooldown=3600000] - Min time between scenes (default 1h)
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

export class SliceOfLifeOrchestrator {
	/**
	 * @param {{
	 *   config: SliceOfLifeConfig,
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

		this.memory = new ChannelMemory({
			path: `${options.paths.workspaceDir}/../shared-routes/slice-of-life/memory.json`,
			maxTokens: 8192,
			getSession: options.getSession,
		});

		this.state = this.loadState();
		this.checkInterval = null;
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
		}, 60000); // Check every minute
	}

	/**
	 * Stop the orchestrator.
	 */
	async stop() {
		if (this.checkInterval) {
			clearInterval(this.checkInterval);
			this.checkInterval = null;
		}
		for (const timer of this.cronTimers.values()) {
			clearTimeout(timer);
		}
		this.cronTimers.clear();
		await this.logger.info("orchestrator-stopped");
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
	 * Trigger a scene by name.
	 * @param {string} sceneName
	 * @param {string} triggerType - "cron" | "rng" | "manual"
	 */
	async triggerScene(sceneName, triggerType = "manual") {
		const scene = this.config.scenes.find(s => s.name === sceneName);
		if (!scene) {
			await this.logger.error("scene-not-found", { sceneName });
			return;
		}

		// Check cooldown
		const cooldown = this.config.cooldown ?? DEFAULT_COOLDOWN;
		if (Date.now() - (this.state.lastSceneTime ?? 0) < cooldown) {
			await this.logger.info("scene-cooldown", {
				sceneName,
				remaining: cooldown - (Date.now() - (this.state.lastSceneTime ?? 0)),
			});
			return;
		}

		// Check if this instance should speak
		if (scene.speaker !== this.instanceName) {
			await this.logger.info("scene-skipped-wrong-speaker", {
				sceneName,
				speaker: scene.speaker,
				thisInstance: this.instanceName,
			});
			return;
		}

		await this.logger.info("scene-triggered", {
			sceneName,
			triggerType,
			speaker: scene.speaker,
		});

		try {
			// Get channel
			const channel = await this.discordClient.channels.fetch(this.config.channelId);
			if (!channel || !channel.isTextBased()) {
				throw new Error(`Channel ${this.config.channelId} not found or not text-based`);
			}

			// Build prompt with memory context
			const memoryContext = this.memory.getContext();
			const fullPrompt = this.buildScenePrompt(scene, memoryContext);

			// Generate or use template
			let content;
			if (this.getSession) {
				const session = await this.getSession();
				const result = await session.send(fullPrompt);
				content = typeof result === "string" ? result : result.text ?? String(result);
			} else {
				// Fallback: use prompt directly as content (template mode)
				content = scene.prompt;
			}

			// Post to Discord
			await channel.send(content);

			// Log to memory
			this.memory.append({
				scene: scene.name,
				topic: scene.name,
				turns: [{ speaker: scene.speaker, text: content }],
			});

			// Update state
			this.state.lastScene = scene.name;
			this.state.lastSceneTime = Date.now();
			this.state.lastTriggers[scene.name] = Date.now();
			await this.saveState();

			await this.logger.info("scene-completed", {
				sceneName,
				contentLength: content.length,
			});
		} catch (error) {
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