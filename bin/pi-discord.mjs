#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { getPaths } from "../lib/paths.js";
import { createDefaultConfig } from "../lib/config.js";

const packageRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const agentDir = path.join(homedir(), ".pi", "agent");
const instancesDir = path.join(agentDir, "pi-discord-instances");
const legacyDir = path.join(agentDir, "pi-discord"); // Old single-instance location
const defaultInstance = "plana";

const COMMANDS = {
	create: { args: ["name"], desc: "Create a new instance with default config" },
	list: { args: [], desc: "List all instances" },
	start: { args: ["name"], desc: "Start an instance" },
	stop: { args: ["name"], desc: "Stop an instance" },
	restart: { args: ["name"], desc: "Restart an instance" },
	status: { args: ["name?"], desc: "Show status of instance(s)" },
	edit: { args: ["name"], desc: "Open instance config in editor" },
	remove: { args: ["name"], desc: "Remove an instance (keeps workspace data)" },
	migrate: { args: ["name?"], desc: "Migrate legacy instance to new location" },
};

function printUsage() {
	console.log("pi-discord - Multi-instance Discord bot manager\n");
	console.log("Usage: pi-discord <command> [args]\n");
	console.log("Commands:");
	const maxCmdLen = Math.max(...Object.keys(COMMANDS).map(c => c.length));
	for (const [cmd, info] of Object.entries(COMMANDS)) {
		const args = info.args.map(a => a.endsWith("?") ? `[${a}]` : `<${a}>`).join(" ");
		console.log(`  ${cmd.padEnd(maxCmdLen + 2)} ${args}  ${info.desc}`);
	}
	console.log("\nInstances are stored in: " + instancesDir);
	console.log("Default instance: " + defaultInstance);
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
	const pidPath = paths.pidPath;

	const result = { running: false, pid: null, status: null };

	if (existsSync(pidPath)) {
		try {
			const pid = parseInt(readFileSync(pidPath, "utf8").trim(), 10);
			if (!isNaN(pid)) {
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

function cmdCreate(name) {
	ensureInstancesDir();
	const instanceDir = getInstanceDir(name);
	const workspaceDir = path.join(instanceDir, "workspace");
	const configFile = path.join(workspaceDir, "config.json");

	if (existsSync(instanceDir)) {
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

function cmdStart(name) {
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

function cmdRestart(name) {
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

	cmdStart(name);
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

	const targetName = name || defaultInstance;
	const targetDir = getInstanceDir(targetName);

	if (existsSync(targetDir)) {
		console.error(`Instance "${targetName}" already exists at ${targetDir}`);
		console.error("Remove it first or choose a different name: pi-discord migrate <name>");
		process.exit(1);
	}

	const { running } = readStatus(legacyDir);
	if (running) {
		console.error("Legacy instance is running. Stop it first.");
		process.exit(1);
	}

	console.log(`Migrating legacy instance to "${targetName}"...`);
	mkdirSync(instancesDir, { recursive: true });

	// Create instance directory and move workspace
	const workspaceDir = path.join(targetDir, "workspace");
	mkdirSync(targetDir, { recursive: true });

	// Copy the entire legacy directory as the workspace
	const fs = require("fs");
	fs.cpSync(legacyDir, workspaceDir, { recursive: true });

	console.log(`Migrated to ${targetDir}`);
	console.log("\nOriginal files preserved at: " + legacyDir);
	console.log("To switch to the new instance, run:");
	console.log(`  pi-discord start ${targetName}`);
	console.log("\nOnce verified, you can remove the legacy directory:");
	console.log(`  rm -rf ${legacyDir}`);
}

async function main() {
	const args = process.argv.slice(2);

	if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
		printUsage();
		process.exit(args.length === 0 ? 1 : 0);
	}

	const [cmd, ...cmdArgs] = args;

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
			cmdCreate(cmdArgs[0]);
			break;
		case "list":
			cmdList();
			break;
		case "start":
			cmdStart(cmdArgs[0]);
			break;
		case "stop":
			cmdStop(cmdArgs[0]);
			break;
		case "restart":
			cmdRestart(cmdArgs[0]);
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
	}
}

main().catch(err => {
	console.error(err.message);
	process.exit(1);
});