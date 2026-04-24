import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeSegment } from "./fs.js";

const packageRoot = path.dirname(
	fileURLToPath(new URL("../package.json", import.meta.url)),
);

/**
 * Resolves all package and runtime paths.
 * @param {{ agentDir?: string, workspaceDir?: string }} [options]
 */
export function getPaths(options = {}) {
	const agentDir = options.agentDir ?? path.join(homedir(), ".pi", "agent");
	const workspaceDir =
		options.workspaceDir ?? path.join(agentDir, "pi-discord");
	return {
		packageRoot,
		agentDir,
		workspaceDir,
		configPath: path.join(workspaceDir, "config.json"),
		runDir: path.join(workspaceDir, "run"),
		logsDir: path.join(workspaceDir, "logs"),
		routesDir: path.join(workspaceDir, "routes"),
		routeWorkspacesDir: path.join(workspaceDir, "workspaces"),
		daemonLogPath: path.join(workspaceDir, "logs", "daemon.log"),
		statusPath: path.join(workspaceDir, "run", "status.json"),
		pidPath: path.join(workspaceDir, "run", "daemon.pid"),
		lockPath: path.join(workspaceDir, "run", "daemon.lock"),
		registryPath: path.join(workspaceDir, "routes", "registry.json"),
		daemonEntry: path.join(packageRoot, "bin", "pi-discord-daemon.mjs"),
	};
}

/**
 * Resolves per-route paths.
 * @param {ReturnType<typeof getPaths>} paths
 * @param {string} routeKey
 */
export function getRoutePaths(paths, routeKey) {
	const routeSlug = sanitizeSegment(routeKey);
	const routeDir = path.join(paths.routesDir, routeSlug);
	return {
		routeDir,
		manifestPath: path.join(routeDir, "manifest.json"),
		queuePath: path.join(routeDir, "queue.json"),
		journalPath: path.join(routeDir, "journal.jsonl"),
		sessionsDir: path.join(routeDir, "sessions"),
		inboundAttachmentsDir: path.join(routeDir, "attachments", "inbound"),
		dedicatedExecutionRoot: path.join(paths.routeWorkspacesDir, routeSlug),
		sharedMemoryPath: path.join(routeDir, "route-memory.md"),
	};
}
