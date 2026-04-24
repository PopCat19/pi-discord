import path from "node:path";
import { ensureDir, readJson, writeJson } from "../lib/fs.js";
import { getRoutePaths } from "../lib/paths.js";

/**
 * @typedef {Object} RouteManifest
 * @property {number} version
 * @property {string} routeKey
 * @property {{ guildId: string | null, channelId: string, threadId: string | null }} scope
 * @property {"dedicated" | "shared"} workspaceMode
 * @property {string} executionRoot
 * @property {string} memoryPath
 * @property {string | undefined} sessionFile
 * @property {string | undefined} primaryMessageId
 * @property {string | undefined} detailsThreadId
 * @property {string | undefined} currentAgent
 */

function normalizeScope(value) {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return undefined;
	if (typeof value.channelId !== "string" || !value.channelId) return undefined;
	return {
		guildId: typeof value.guildId === "string" ? value.guildId : null,
		channelId: value.channelId,
		threadId: typeof value.threadId === "string" ? value.threadId : null,
	};
}

function normalizeRegistry(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { version: 1, routes: {} };
	}

	const routes = {};
	const sourceRoutes = value.routes;
	if (
		!sourceRoutes ||
		typeof sourceRoutes !== "object" ||
		Array.isArray(sourceRoutes)
	) {
		return { version: 1, routes };
	}

	for (const [key, entry] of Object.entries(sourceRoutes)) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const routeKey =
			typeof entry.routeKey === "string" && entry.routeKey
				? entry.routeKey
				: key;
		const scope = normalizeScope(entry.scope);
		if (!routeKey || !scope) continue;
		routes[routeKey] = { routeKey, scope };
	}

	return { version: 1, routes };
}

function normalizeManifest(routeKey, value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const scope = normalizeScope(value.scope);
	const executionRoot =
		typeof value.executionRoot === "string" && value.executionRoot
			? value.executionRoot
			: undefined;
	const memoryPath =
		typeof value.memoryPath === "string" && value.memoryPath
			? value.memoryPath
			: undefined;
	if (!scope || !executionRoot || !memoryPath) return null;

	return {
		version: 1,
		routeKey,
		scope,
		workspaceMode: value.workspaceMode === "shared" ? "shared" : "dedicated",
		executionRoot,
		memoryPath,
		sessionFile:
			typeof value.sessionFile === "string" ? value.sessionFile : undefined,
		primaryMessageId:
			typeof value.primaryMessageId === "string"
				? value.primaryMessageId
				: undefined,
		detailsThreadId:
			typeof value.detailsThreadId === "string"
				? value.detailsThreadId
				: undefined,
		currentAgent:
			typeof value.currentAgent === "string" ? value.currentAgent : undefined,
	};
}

export class RouteRegistry {
	/**
	 * @param {ReturnType<import('../lib/paths.js').getPaths>} paths
	 */
	constructor(paths) {
		this.paths = paths;
		this.registry = { version: 1, routes: {} };
	}

	async load() {
		this.registry = normalizeRegistry(
			await readJson(this.paths.registryPath, { version: 1, routes: {} }),
		);
		return this.registry;
	}

	async save() {
		await ensureDir(path.dirname(this.paths.registryPath));
		await writeJson(this.paths.registryPath, this.registry);
	}

	list() {
		return Object.values(this.registry.routes);
	}

	/**
	 * @param {string} routeKey
	 */
	async loadManifest(routeKey) {
		const routePaths = getRoutePaths(this.paths, routeKey);
		return normalizeManifest(
			routeKey,
			await readJson(routePaths.manifestPath, null),
		);
	}

	/**
	 * @param {RouteManifest} manifest
	 */
	async saveManifest(manifest) {
		const routePaths = getRoutePaths(this.paths, manifest.routeKey);
		await ensureDir(routePaths.routeDir);
		await writeJson(routePaths.manifestPath, manifest);
		this.registry.routes[manifest.routeKey] = {
			routeKey: manifest.routeKey,
			scope: manifest.scope,
		};
		await this.save();
	}
}

/**
 * @param {{ routeKey: string, scope: { guildId: string | null, channelId: string, threadId: string | null }, workspaceMode: "dedicated" | "shared", executionRoot: string, memoryPath: string }} input
 * @returns {RouteManifest}
 */
export function createRouteManifest(input) {
	return {
		version: 1,
		routeKey: input.routeKey,
		scope: input.scope,
		workspaceMode: input.workspaceMode,
		executionRoot: input.executionRoot,
		memoryPath: input.memoryPath,
		sessionFile: undefined,
		primaryMessageId: undefined,
		detailsThreadId: undefined,
		currentAgent: undefined,
	};
}
