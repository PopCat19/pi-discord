import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { ensureDir, tailFile } from "./fs.js";

async function readJsonFile(filePath) {
	try {
		return JSON.parse(await readFile(filePath, "utf8"));
	} catch {
		return undefined;
	}
}

async function readNumericFile(filePath) {
	try {
		const value = Number((await readFile(filePath, "utf8")).trim());
		return Number.isInteger(value) && value > 0 ? value : undefined;
	} catch {
		return undefined;
	}
}

function isProcessAlive(pid) {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * @param {ReturnType<import('./paths.js').getPaths>} paths
 */
export async function readDaemonStatus(paths) {
	const [pidFilePid, lockState, status] = await Promise.all([
		readNumericFile(paths.pidPath),
		readJsonFile(paths.lockPath),
		readJsonFile(paths.statusPath),
	]);

	const candidates = [
		typeof lockState?.pid === "number" ? lockState.pid : undefined,
		typeof status?.pid === "number" ? status.pid : undefined,
		pidFilePid,
	].filter((pid) => Number.isInteger(pid) && pid > 0);

	const livePid = candidates.find((pid) => isProcessAlive(pid));
	return {
		running: Boolean(livePid),
		pid: livePid,
		status: livePid && status?.pid === livePid ? status : undefined,
	};
}

/**
 * @param {ReturnType<import('./paths.js').getPaths>} paths
 */
export async function startDaemon(paths) {
	const state = await readDaemonStatus(paths);
	if (state.running) {
		return {
			started: false,
			reason: `Daemon already running as pid ${state.pid}.`,
		};
	}

	await ensureDir(paths.runDir);
	const child = spawn(
		process.execPath,
		[paths.daemonEntry, "--workspace", paths.workspaceDir],
		{
			cwd: paths.packageRoot,
			detached: true,
			stdio: "ignore",
			env: { ...process.env },
		},
	);
	child.unref();
	await writeFile(paths.pidPath, `${child.pid}\n`, "utf8");
	return { started: true, pid: child.pid };
}

/**
 * @param {ReturnType<import('./paths.js').getPaths>} paths
 */
export async function stopDaemon(paths) {
	const state = await readDaemonStatus(paths);
	if (!state.running || !state.pid) {
		return { stopped: false, reason: "Daemon is not running." };
	}
	try {
		process.kill(state.pid, "SIGTERM");
		return { stopped: true, pid: state.pid };
	} catch (error) {
		if (error?.code === "ESRCH")
			return { stopped: false, reason: "Daemon is no longer running." };
		throw error;
	}
}

/**
 * @param {ReturnType<import('./paths.js').getPaths>} paths
 * @param {number} [lines]
 */
export async function readDaemonLogs(paths, lines = 80) {
	return tailFile(paths.daemonLogPath, lines);
}
