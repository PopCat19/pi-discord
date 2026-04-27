#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { getPaths } from "../lib/paths.js";
import { createDefaultConfig, loadConfig } from "../lib/config.js";
import { syncSlashCommands } from "../lib/discord-commands.js";

const packageRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const agentDir = path.join(homedir(), ".pi", "agent");
const instancesDir = path.join(agentDir, "pi-discord-instances");
const legacyDir = path.join(agentDir, "pi-discord"); // Old single-instance location

const COMMANDS = {
	create: { args: ["name"], desc: "Create a new instance with default config" },
	list: { args: [], desc: "List all instances" },
	start: { args: ["name"], desc: "Start an instance" },
	stop: { args: ["name"], desc: "Stop an instance" },
	restart: { args: ["name"], desc: "Restart an instance" },
	status: { args: ["name?"], desc: "Show status of instance(s)" },
	edit: { args: ["name"], desc: "Open instance config in editor" },
	remove: { args: ["name"], desc: "Remove an instance (keeps workspace data)" },
	migrate: { args: ["name"], desc: "Migrate legacy instance to new location" },
	"sync-commands": { args: ["name"], desc: "Sync slash commands to Discord" },
	trigger: { args: ["name", "scene"], desc: "Trigger a scene manually" },
};

function printUsage() {
	console.log("pi-discord - Multi-instance Discord bot manager\n");
	console.log("Usage: pi-discord <command> [args]\n");
	console.log("Commands:");
	const maxCmdLen = Math.max(...Object.keys(COMMANDS).map(c => c.length));
	for (const [cmd, info] of Object.entries(COMMANDS)) {
		const args = info.args.map(a => a.endsWith("?") ? `[${a}]` : `<${a}>`).join(" ");
		const flags = cmd === "create" ? " [--needed]" : "";
		console.log(`  ${cmd.padEnd(maxCmdLen + 2)} ${args}${flags}  ${info.desc}`);
	}
	console.log("\nInstances are stored in: " + instancesDir);
}

function getInstanceDir(name) {
	if (!name || !/^[a-z0-9_-]+$/i.test(name)) {
		throw new Error(`Invalid instance name: ${name}. Use alphanumeric, dash, or underscore.`);
	}
	return path.join(instancesDir, name);
}

function getInstancePath(name) {
	return path.join(instancesDir, name, "workspace");
}

function resolveWorkspace(name) {
	// Handle legacy instance
	if (name === "legacy" || name === "(legacy)") {
		if (!existsSync(legacyDir)) {
			throw new Error("Legacy instance not found.");
		}
		return legacyDir;
	}

	const workspaceDir = getInstancePath(name);
	if (!existsSync(workspaceDir)) {
		throw new Error(`Instance "${name}" not found. Create it first with: pi-discord create ${name}`);
	}
	return workspaceDir;
}

function ensureInstancesDir() {
	if (!existsSync(instancesDir)) {
		mkdirSync(instancesDir, { recursive: true });
	}
}

function listInstances() {
	ensureInstancesDir();
	const instances = [];

	// Check for legacy instance
	if (existsSync(legacyDir)) {
		instances.push({ name: "(legacy)", path: legacyDir, isLegacy: true });
	}

	// List new-style instances
	const dirs = readdirSync(instancesDir, { withFileTypes: true });
	for (const d of dirs) {
		if (d.isDirectory()) {
			instances.push({ name: d.name, path: path.join(instancesDir, d.name, "workspace"), isLegacy: false });
		}
	}

	return instances;
}

function readStatus(workspaceDir) {
	const paths = getPaths({ workspaceDir });
	const statusPath = paths.statusPath;
	const lockPath = paths.lockPath;

	const result = { running: false, pid: null, status: null };

	if (existsSync(lockPath)) {
		try {
			const lockData = JSON.parse(readFileSync(lockPath, "utf8"));
			const pid = lockData.pid;
			if (pid && !isNaN(pid)) {
				// Check if process is alive
				try {
					process.kill(pid, 0);
					result.running = true;
					result.pid = pid;
				} catch {
					// Process not running
				}
			}
		} catch {}
	}

	if (existsSync(statusPath)) {
		try {
			result.status = JSON.parse(readFileSync(statusPath, "utf8"));
		} catch {}
	}

	return result;
}

function cmdCreate(name, options = {}) {
	ensureInstancesDir();
	const instanceDir = getInstanceDir(name);
	const workspaceDir = path.join(instanceDir, "workspace");
	const configFile = path.join(workspaceDir, "config.json");

	if (existsSync(instanceDir)) {
		if (options.needed) {
			console.log(`Instance "${name}" already exists at ${instanceDir}`);
			return;
		}
		console.error(`Instance "${name}" already exists at ${instanceDir}`);
		process.exit(1);
	}

	mkdirSync(workspaceDir, { recursive: true });

	const config = createDefaultConfig(getPaths({ workspaceDir }));
	config.botToken = "";
	config.applicationId = "";
	config.workspaceMode = "dedicated";
	config.sharedExecutionRoot = path.join(workspaceDir, "shared-workspace");

	writeFileSync(configFile, JSON.stringify(config, null, "\t"));
	console.log(`Created instance "${name}" at ${instanceDir}`);
	console.log(`\nEdit the config to add your bot token and application ID:`);
	console.log(`  ${configFile}`);
}

function cmdList() {
	ensureInstancesDir();
	const instances = listInstances();

	if (instances.length === 0) {
		console.log("No instances found. Create one with: pi-discord create <name>");
		return;
	}

	console.log("Instances:\n");
	for (const inst of instances) {
		const name = inst.isLegacy ? "(legacy)" : inst.name;
		const workspaceDir = inst.isLegacy ? legacyDir : getInstancePath(inst.name);
		const { running, pid, status } = readStatus(workspaceDir);
		const state = running ? `running (pid ${pid})` : "stopped";
		console.log(`  ${name}`);
		console.log(`    Status: ${state}`);
		console.log(`    Workspace: ${workspaceDir}`);
		if (status) {
			console.log(`    Routes: ${status.routes ?? 0}`);
		}
		if (inst.isLegacy) {
			console.log(`    Note: Legacy instance, migrate with: pi-discord migrate`);
		}
		console.log();
	}
}

async function cmdStart(name) {
	let workspaceDir;
	try {
		workspaceDir = resolveWorkspace(name);
	} catch (err) {
		console.error(err.message);
		process.exit(1);
	}

	const { running, pid } = readStatus(workspaceDir);
	if (running) {
		console.log(`Instance "${name}" is already running (pid ${pid})`);
		return;
	}

	// Sync slash commands if configured
	try {
		const config = await loadConfig(getPaths({ workspaceDir }));
		if (config.syncCommandsOnStart) {
			const canSync = config.registerCommandsGlobally || config.allowedGuildIds.length > 0;
			if (canSync) {
				console.log("Syncing slash commands...");
				await syncSlashCommands(config);
				console.log("Slash commands synced.");
			}
		}
	} catch (err) {
		// Config load failed, continue anyway
	}

	console.log(`Starting instance "${name}"...`);
	const daemonPath = path.join(packageRoot, "bin", "pi-discord-daemon.mjs");
	const child = spawn("node", [daemonPath, "--workspace", workspaceDir], {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
	console.log(`Started instance "${name}" (pid ${child.pid})`);
}

function cmdStop(name) {
	let workspaceDir;
	try {
		workspaceDir = resolveWorkspace(name);
	} catch (err) {
		console.error(err.message);
		process.exit(1);
	}

	const { running, pid } = readStatus(workspaceDir);
	if (!running) {
		console.log(`Instance "${name}" is not running.`);
		return;
	}

	try {
		process.kill(pid, "SIGTERM");
		console.log(`Stopped instance "${name}" (pid ${pid})`);
	} catch (err) {
		console.error(`Failed to stop instance "${name}": ${err.message}`);
	}
}

async function cmdRestart(name) {
	const workspaceDir = getInstancePath(name);
	const { running, pid } = readStatus(workspaceDir);

	if (running) {
		console.log(`Stopping instance "${name}"...`);
		try {
			process.kill(pid, "SIGTERM");
			// Wait a moment for shutdown
			let attempts = 0;
			while (attempts < 10) {
				try {
					process.kill(pid, 0);
					attempts++;
					// Use synchronous sleep hack
					Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
				} catch {
					break;
				}
			}
		} catch {}
	}

	await cmdStart(name);
}

function cmdStatus(name) {
	if (name) {
		let workspaceDir;
		try {
			workspaceDir = resolveWorkspace(name);
		} catch (err) {
			console.error(err.message);
			process.exit(1);
		}
		const { running, pid, status } = readStatus(workspaceDir);
		console.log(`Instance: ${name}`);
		console.log(`  Running: ${running}`);
		if (running) console.log(`  PID: ${pid}`);
		if (status) console.log(`  Status: ${JSON.stringify(status, null, 2)}`);
	} else {
		cmdList();
	}
}

function cmdEdit(name) {
	let workspaceDir;
	try {
		workspaceDir = resolveWorkspace(name);
	} catch (err) {
		console.error(err.message);
		process.exit(1);
	}
	const paths = getPaths({ workspaceDir });
	const editor = process.env.EDITOR || process.env.VISUAL || "nano";
	const configFile = paths.configPath;

	if (!existsSync(configFile)) {
		console.error(`Instance "${name}" config not found.`);
		process.exit(1);
	}

	spawn(editor, [configFile], { stdio: "inherit" });
}

function cmdRemove(name) {
	if (name === "legacy" || name === "(legacy)") {
		console.error("Cannot remove legacy instance. Use 'pi-discord migrate' instead.");
		process.exit(1);
	}

	const instanceDir = getInstanceDir(name);
	if (!existsSync(instanceDir)) {
		console.error(`Instance "${name}" not found.`);
		process.exit(1);
	}

	const { running } = readStatus(getInstancePath(name));
	if (running) {
		console.error(`Instance "${name}" is running. Stop it first.`);
		process.exit(1);
	}

	console.log(`Removing instance "${name}"...`);
	rmSync(instanceDir, { recursive: true });
	console.log(`Removed.`);
}

function cmdMigrate(name) {
	if (!existsSync(legacyDir)) {
		console.error("No legacy instance found at ~/.pi/agent/pi-discord/");
		process.exit(1);
	}

	if (!name) {
		console.error("Please specify a name for the migrated instance:");
		console.error("  pi-discord migrate <name>");
		console.error("\nExample: pi-discord migrate my-bot");
		process.exit(1);
	}

	const targetDir = getInstanceDir(name);

	if (existsSync(targetDir)) {
		console.error(`Instance "${name}" already exists at ${targetDir}`);
		process.exit(1);
	}

	const { running } = readStatus(legacyDir);
	if (running) {
		console.error("Legacy instance is running. Stop it first.");
		process.exit(1);
	}

	console.log(`Migrating legacy instance to "${name}"...`);
	mkdirSync(instancesDir, { recursive: true });

	// Create instance directory and copy workspace
	const workspaceDir = path.join(targetDir, "workspace");
	mkdirSync(targetDir, { recursive: true });

	const fs = require("fs");
	fs.cpSync(legacyDir, workspaceDir, { recursive: true });

	console.log(`Migrated to ${targetDir}`);
	console.log("\nOriginal files preserved at: " + legacyDir);
	console.log("To start the new instance:");
	console.log(`  pi-discord start ${name}`);
	console.log("\nOnce verified, you can remove the legacy directory:");
	console.log(`  rm -rf ${legacyDir}`);
}

async function cmdSyncCommands(name) {
	let workspaceDir;
	try {
		workspaceDir = resolveWorkspace(name);
	} catch (err) {
		console.error(err.message);
		process.exit(1);
	}
	const paths = getPaths({ workspaceDir });
	const config = await loadConfig(paths);

	if (!config.botToken || !config.applicationId) {
		console.error(`Instance "${name}" missing botToken or applicationId in config.`);
		process.exit(1);
	}

	console.log(`Syncing commands for "${name}"...`);
	try {
		const result = await syncSlashCommands(config);
		console.log(`Synced ${result.count} commands ${result.scope === "global" ? "globally" : "to guild(s)"}.`);
	} catch (err) {
		console.error(`Failed to sync commands: ${err.message}`);
		process.exit(1);
	}
}

async function cmdTrigger(name, scene) {
	let workspaceDir;
	try {
		workspaceDir = resolveWorkspace(name);
	} catch (err) {
		console.error(err.message);
		process.exit(1);
	}

	const { running } = readStatus(workspaceDir);
	if (!running) {
		console.error(`Instance "${name}" is not running.`);
		process.exit(1);
	}

	if (!scene) {
		console.error("Scene name required.");
		console.error("Usage: pi-discord trigger <instance> <scene>");
		process.exit(1);
	}

	// Write scene trigger file
	const triggersDir = path.join(workspaceDir, "scene-triggers");
	if (!existsSync(triggersDir)) {
		mkdirSync(triggersDir, { recursive: true });
	}

	const triggerFile = path.join(triggersDir, `${scene}-${Date.now()}.json`);
	writeFileSync(triggerFile, JSON.stringify({ scene }));
	console.log(`Triggered scene "${scene}" on instance "${name}".`);
}

async function main() {
	const args = process.argv.slice(2);

	if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
		printUsage();
		process.exit(args.length === 0 ? 1 : 0);
	}

	// Parse flags
	const flags = { needed: false };
	const filteredArgs = args.filter(arg => {
		if (arg === "--needed") {
			flags.needed = true;
			return false;
		}
		return true;
	});

	const [cmd, ...cmdArgs] = filteredArgs;

	if (!COMMANDS[cmd]) {
		console.error(`Unknown command: ${cmd}`);
		printUsage();
		process.exit(1);
	}

	const { args: expected } = COMMANDS[cmd];
	const required = expected.filter(a => !a.endsWith("?"));
	if (cmdArgs.length < required.length) {
		console.error(`Usage: pi-discord ${cmd} ${expected.map(a => a.endsWith("?") ? `[${a}]` : `<${a}>`).join(" ")}`);
		process.exit(1);
	}

	switch (cmd) {
		case "create":
			cmdCreate(cmdArgs[0], flags);
			break;
		case "list":
			cmdList();
			break;
		case "start":
			cmdStart(cmdArgs[0]).catch(err => console.error(err.message));
			break;
		case "stop":
			cmdStop(cmdArgs[0]);
			break;
		case "restart":
			cmdRestart(cmdArgs[0]).catch(err => console.error(err.message));
			break;
		case "status":
			cmdStatus(cmdArgs[0]);
			break;
		case "edit":
			cmdEdit(cmdArgs[0]);
			break;
		case "remove":
			cmdRemove(cmdArgs[0]);
			break;
		case "migrate":
			cmdMigrate(cmdArgs[0]);
			break;
		case "sync-commands":
			await cmdSyncCommands(cmdArgs[0]);
			break;
		case "trigger":
			await cmdTrigger(cmdArgs[0], cmdArgs[1]);
			break;
	}
}

main().catch(err => {
	console.error(err.message);
	process.exit(1);
});