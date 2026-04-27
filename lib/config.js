import { readFile } from "node:fs/promises";
import path from "node:path";
import {
	CONFIG_VERSION,
	DEFAULT_COMMAND_NAME,
	DEFAULT_GLOBAL_CONCURRENCY,
	DEFAULT_PRIMARY_FLUSH_MS,
	DEFAULT_QUEUE_LEASE_MS,
} from "./constants.js";
import { ensureDir, readJson, writeJson } from "./fs.js";

const THINKING_LEVELS = new Set([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
]);

function toStringArray(value) {
	if (!Array.isArray(value)) return [];
	return [
		...new Set(
			value
				.filter((entry) => typeof entry === "string")
				.map((entry) => entry.trim())
				.filter(Boolean),
		),
	];
}

function normalizeOptionalString(value) {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized || undefined;
}

function normalizeRouteOverrides(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}

	const normalized = {};
	for (const [routeKey, override] of Object.entries(value)) {
		if (!override || typeof override !== "object" || Array.isArray(override))
			continue;
		const executionRoot = normalizeOptionalString(override.executionRoot);
		const mode =
			override.mode === "shared" || override.mode === "dedicated"
				? override.mode
				: undefined;
		if (!executionRoot && !mode) continue;
		normalized[routeKey] = { executionRoot, mode };
	}
	return normalized;
}

function normalizeAgents(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}

	const normalized = {};
	for (const [agentName, agent] of Object.entries(value)) {
		if (!agent || typeof agent !== "object" || Array.isArray(agent)) continue;
		const systemPrompt = normalizeOptionalString(agent.systemPrompt);
		if (!systemPrompt) continue;
		normalized[agentName] = {
			systemPrompt,
			systemPromptFile: normalizeOptionalString(agent.systemPromptFile),
			defaultModel: normalizeOptionalString(agent.defaultModel),
			defaultThinkingLevel:
				typeof agent.defaultThinkingLevel === "string" &&
				THINKING_LEVELS.has(agent.defaultThinkingLevel)
					? agent.defaultThinkingLevel
					: undefined,
		};
	}
	return normalized;
}

function normalizeToolPermissions(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { adminOnly: ["bash", "edit", "write"], disabled: [] };
	}
	return {
		adminOnly: toStringArray(value.adminOnly),
		disabled: toStringArray(value.disabled),
	};
}

function normalizeSliceOfLife(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { enabled: false };
	}
	return {
		enabled: Boolean(value.enabled),
		channelId: typeof value.channelId === "string" ? value.channelId : "",
		primaryInstance: typeof value.primaryInstance === "string" ? value.primaryInstance : "",
		cooldown: typeof value.cooldown === "number" ? value.cooldown : 3600000,
		scenes: Array.isArray(value.scenes) ? value.scenes.map(normalizeScene) : [],
	};
}

function normalizeScene(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { name: "", trigger: {}, speaker: "", prompt: "" };
	}
	return {
		name: typeof value.name === "string" ? value.name : "",
		trigger: normalizeTrigger(value.trigger),
		speaker: typeof value.speaker === "string" ? value.speaker : "",
		prompt: typeof value.prompt === "string" ? value.prompt : "",
		turns: typeof value.turns === "number" ? value.turns : 1,
	};
}

function normalizeTrigger(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}
	const trigger = {};
	if (typeof value.cron === "string") {
		trigger.cron = value.cron;
	}
	if (value.rng && typeof value.rng === "object") {
		trigger.rng = {
			chance: typeof value.rng.chance === "number" ? value.rng.chance : 0,
			interval: typeof value.rng.interval === "number" ? value.rng.interval : 3600000,
		};
	}
	if (value.search && typeof value.search === "object") {
		trigger.search = {
			query: typeof value.search.query === "string" ? value.search.query : "",
			schedule: typeof value.search.schedule === "string" ? value.search.schedule : "0 9 * * *",
		};
	}
	return trigger;
}

/**
 * @typedef {Object} AgentDefinition
 * @property {string} systemPrompt
 * @property {string | undefined} [systemPromptFile]
 * @property {string | undefined} [defaultModel]
 * @property {"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined} [defaultThinkingLevel]
 */

/**
 * @typedef {Object} DiscordRouteOverride
 * @property {string | undefined} [executionRoot]
 * @property {"dedicated" | "shared" | undefined} [mode]
 */

/**
 * @typedef {Object} ToolPermissions
 * @property {string[]} adminOnly - Tools restricted to admin users
 * @property {string[]} disabled - Tools disabled for all users
 */

/**
 * @typedef {Object} PiDiscordConfig
 * @property {number} version
 * @property {string} botToken
 * @property {string} applicationId
 * @property {string[]} allowedGuildIds
 * @property {string[]} adminUserIds
 * @property {string[]} dmAllowlistUserIds

 * @property {string} commandName
 * @property {boolean} registerCommandsGlobally
 * @property {boolean} syncCommandsOnStart
 * @property {"dedicated" | "shared"} workspaceMode
 * @property {string | undefined} sharedExecutionRoot
 * @property {Record<string, DiscordRouteOverride>} routeOverrides
 * @property {boolean} allowProjectExtensions
 * @property {boolean} enableImageInput
 * @property {boolean} enableDetailsThreads
 * @property {number} globalConcurrency
 * @property {number} queueLeaseMs
 * @property {number} primaryFlushMs
 * @property {string | undefined} defaultModel
 * @property {"off" | "minimal" | "low" | "medium" | "high" | "xhigh"} defaultThinkingLevel
 * @property {string | undefined} systemPrompt
 * @property {string | undefined} systemPromptFile
 * @property {boolean} useThreadPersona
 * @property {ToolPermissions} toolPermissions
 * @property {Record<string, AgentDefinition>} agents
 * @property {string} defaultAgent
 * @property {SliceOfLifeConfig} sliceOfLife
 */

/**
 * @typedef {Object} SliceOfLifeConfig
 * @property {boolean} enabled
 * @property {string} channelId
 * @property {string} primaryInstance
 * @property {number} cooldown
 * @property {SceneConfig[]} scenes
 */

/**
 * @typedef {Object} SceneConfig
 * @property {string} name
 * @property {{ cron?: string, rng?: { chance: number, interval: number }, search?: { query: string, schedule: string } }} trigger
 * @property {string} speaker
 * @property {string} prompt
 * @property {number} [turns]
 */

/**
 * Builds the default config.
 * @param {ReturnType<import('./paths.js').getPaths>} paths
 * @returns {PiDiscordConfig}
 */
export function createDefaultConfig(paths) {
	return {
		version: CONFIG_VERSION,
		botToken: "",
		applicationId: "",
		allowedGuildIds: [],
		adminUserIds: [],
		dmAllowlistUserIds: [],

		commandName: DEFAULT_COMMAND_NAME,
		registerCommandsGlobally: false,
		syncCommandsOnStart: true,
		workspaceMode: "dedicated",
		sharedExecutionRoot: path.join(paths.workspaceDir, "shared-workspace"),
		routeOverrides: {},
		allowProjectExtensions: false,
		enableImageInput: true,
		enableDetailsThreads: true,
		globalConcurrency: DEFAULT_GLOBAL_CONCURRENCY,
		queueLeaseMs: DEFAULT_QUEUE_LEASE_MS,
		primaryFlushMs: DEFAULT_PRIMARY_FLUSH_MS,
		defaultModel: undefined,
		defaultThinkingLevel: "medium",
		systemPrompt: undefined,
		systemPromptFile: undefined,
		useThreadPersona: false,
		toolPermissions: {
			adminOnly: ["bash", "edit", "write"],
			disabled: [],
		},
		agents: {},
		defaultAgent: "default",
		sliceOfLife: { enabled: false },
	};
}

/**
 * Normalizes an arbitrary config object into the supported shape.
 * @param {ReturnType<import('./paths.js').getPaths>} paths
 * @param {Record<string, unknown>} loaded
 * @returns {PiDiscordConfig}
 */
export function normalizeConfig(paths, loaded) {
	const fallback = createDefaultConfig(paths);
	const input =
		loaded && typeof loaded === "object" && !Array.isArray(loaded)
			? loaded
			: {};
	return {
		version:
			typeof input.version === "number" ? input.version : fallback.version,
		botToken: normalizeOptionalString(input.botToken) ?? fallback.botToken,
		applicationId:
			normalizeOptionalString(input.applicationId) ?? fallback.applicationId,
		allowedGuildIds: toStringArray(input.allowedGuildIds),
		adminUserIds: toStringArray(input.adminUserIds),
		dmAllowlistUserIds: toStringArray(input.dmAllowlistUserIds),

		commandName:
			normalizeOptionalString(input.commandName) ?? fallback.commandName,
		registerCommandsGlobally:
			typeof input.registerCommandsGlobally === "boolean"
				? input.registerCommandsGlobally
				: fallback.registerCommandsGlobally,
		syncCommandsOnStart:
			typeof input.syncCommandsOnStart === "boolean"
				? input.syncCommandsOnStart
				: fallback.syncCommandsOnStart,
		workspaceMode:
			input.workspaceMode === "shared" ? "shared" : fallback.workspaceMode,
		sharedExecutionRoot:
			normalizeOptionalString(input.sharedExecutionRoot) ??
			fallback.sharedExecutionRoot,
		routeOverrides: normalizeRouteOverrides(input.routeOverrides),
		allowProjectExtensions:
			typeof input.allowProjectExtensions === "boolean"
				? input.allowProjectExtensions
				: fallback.allowProjectExtensions,
		enableImageInput:
			typeof input.enableImageInput === "boolean"
				? input.enableImageInput
				: fallback.enableImageInput,
		enableDetailsThreads:
			typeof input.enableDetailsThreads === "boolean"
				? input.enableDetailsThreads
				: fallback.enableDetailsThreads,
		globalConcurrency:
			typeof input.globalConcurrency === "number"
				? input.globalConcurrency
				: fallback.globalConcurrency,
		queueLeaseMs:
			typeof input.queueLeaseMs === "number"
				? input.queueLeaseMs
				: fallback.queueLeaseMs,
		primaryFlushMs:
			typeof input.primaryFlushMs === "number"
				? input.primaryFlushMs
				: fallback.primaryFlushMs,
		defaultModel:
			normalizeOptionalString(input.defaultModel) ?? fallback.defaultModel,
		defaultThinkingLevel:
			typeof input.defaultThinkingLevel === "string" &&
			THINKING_LEVELS.has(input.defaultThinkingLevel)
				? input.defaultThinkingLevel
				: fallback.defaultThinkingLevel,
		systemPrompt:
			normalizeOptionalString(input.systemPrompt) ?? fallback.systemPrompt,
		systemPromptFile:
			normalizeOptionalString(input.systemPromptFile) ?? fallback.systemPromptFile,
		useThreadPersona:
			typeof input.useThreadPersona === "boolean"
				? input.useThreadPersona
				: fallback.useThreadPersona,
		toolPermissions: normalizeToolPermissions(input.toolPermissions),
		agents: normalizeAgents(input.agents),
		defaultAgent:
			normalizeOptionalString(input.defaultAgent) ?? fallback.defaultAgent,
		sliceOfLife: normalizeSliceOfLife(input.sliceOfLife),
	};
}

/**
 * Resolves systemPrompt from systemPromptFile if specified.
 * When systemPromptFile is set, its contents override the inline systemPrompt.
 * The file path is resolved relative to the config directory.
 * Agent-level systemPromptFile is also resolved.
 * @param {ReturnType<import('./paths.js').getPaths>} paths
 * @param {PiDiscordConfig} config
 * @returns {Promise<PiDiscordConfig>}
 */
async function resolvePromptFiles(paths, config) {
	const configDir = path.dirname(paths.configPath);

	// Resolve top-level systemPromptFile
	if (config.systemPromptFile) {
		const filePath = path.resolve(configDir, config.systemPromptFile);
		try {
			const content = await readFile(filePath, "utf8");
			config = { ...config, systemPrompt: content.trim() };
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
			// File not found — keep inline systemPrompt as fallback
		}
	}

	// Resolve agent-level systemPromptFile
	if (config.agents && typeof config.agents === "object") {
		const resolvedAgents = {};
		for (const [name, agent] of Object.entries(config.agents)) {
			if (agent.systemPromptFile) {
				const filePath = path.resolve(configDir, agent.systemPromptFile);
				try {
					const content = await readFile(filePath, "utf8");
					resolvedAgents[name] = { ...agent, systemPrompt: content.trim() };
				} catch (error) {
					if (error?.code !== "ENOENT") throw error;
					resolvedAgents[name] = agent;
				}
			} else {
				resolvedAgents[name] = agent;
			}
		}
		config = { ...config, agents: resolvedAgents };
	}

	return config;
}

/**
 * Loads config from disk, applies normalization, and resolves prompt files.
 * @param {ReturnType<import('./paths.js').getPaths>} paths
 * @returns {Promise<PiDiscordConfig>}
 */
export async function loadConfig(paths) {
	const loaded = await readJson(paths.configPath, {});
	const config = normalizeConfig(paths, loaded);
	return resolvePromptFiles(paths, config);
}

/**
 * Persists config to disk.
 * systemPromptFile is preserved in the output so the file reference survives round-trips.
 * @param {ReturnType<import('./paths.js').getPaths>} paths
 * @param {PiDiscordConfig} config
 */
export async function saveConfig(paths, config) {
	await ensureDir(paths.workspaceDir);
	await writeJson(paths.configPath, normalizeConfig(paths, config));
}

/**
 * Validates config and returns human-readable issues.
 * @param {PiDiscordConfig} config
 */
export function validateConfig(config) {
	const errors = [];
	const warnings = [];

	if (!config.botToken) errors.push("Missing `botToken`.");
	if (!config.applicationId) errors.push("Missing `applicationId`.");
	if (config.workspaceMode === "shared" && !config.sharedExecutionRoot) {
		errors.push(
			"`sharedExecutionRoot` is required when `workspaceMode` is `shared`.",
		);
	}
	if (!/^[a-z0-9_-]{1,32}$/.test(config.commandName)) {
		errors.push("`commandName` must match Discord slash-command naming rules.");
	}
	if (
		!Number.isInteger(config.globalConcurrency) ||
		config.globalConcurrency < 1
	) {
		errors.push("`globalConcurrency` must be an integer of at least 1.");
	}
	if (!Number.isInteger(config.queueLeaseMs) || config.queueLeaseMs < 1_000) {
		errors.push("`queueLeaseMs` must be an integer of at least 1000.");
	}
	if (!Number.isInteger(config.primaryFlushMs) || config.primaryFlushMs < 100) {
		errors.push("`primaryFlushMs` must be an integer of at least 100.");
	}
	if (config.defaultModel && !config.defaultModel.includes("/")) {
		warnings.push("`defaultModel` should look like `provider/model-id`.");
	}
	if (config.allowProjectExtensions) {
		warnings.push(
			"Project extensions are enabled for bot sessions. This is less safe in headless mode.",
		);
	}
	if (config.allowedGuildIds.length === 0) {
		warnings.push(
			"No guild allowlist is configured. The bot will accept slash commands and mentions in any guild it joins.",
		);
	}

	return { errors, warnings };
}