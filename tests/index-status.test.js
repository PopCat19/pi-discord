import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import piDiscordExtension from "../index.js";
import { ensureDir, pathExists } from "../lib/fs.js";

test("/discord status does not create a config file when none exists", async () => {
	const tempHome = await mkdtemp(path.join(os.tmpdir(), "pi-discord-home-"));
	const originalHome = process.env.HOME;
	process.env.HOME = tempHome;

	const messages = [];
	const pi = {
		sendMessage(message) {
			messages.push(message);
		},
		registerCommand(name, definition) {
			this.name = name;
			this.definition = definition;
		},
	};

	try {
		piDiscordExtension(pi);
		await pi.definition.handler("status", { hasUI: false });

		const configPath = path.join(
			tempHome,
			".pi",
			"agent",
			"pi-discord",
			"config.json",
		);
		assert.equal(await pathExists(configPath), false);
		assert.match(
			messages.at(-1).content,
			/Config errors: Missing `botToken`\.; Missing `applicationId`\./,
		);
	} finally {
		process.env.HOME = originalHome;
	}
});

test("/discord open-config can open malformed JSON for repair", async () => {
	const tempHome = await mkdtemp(
		path.join(os.tmpdir(), "pi-discord-home-malformed-"),
	);
	const originalHome = process.env.HOME;
	process.env.HOME = tempHome;

	const configPath = path.join(
		tempHome,
		".pi",
		"agent",
		"pi-discord",
		"config.json",
	);
	await ensureDir(path.dirname(configPath));
	await writeFile(configPath, '{\n  "botToken": "abc",\n', "utf8");

	let editorText;
	const pi = {
		sendMessage() {},
		registerCommand(name, definition) {
			this.name = name;
			this.definition = definition;
		},
	};

	try {
		piDiscordExtension(pi);
		await pi.definition.handler("open-config", {
			hasUI: true,
			ui: {
				editor: async (_title, text) => {
					editorText = text;
					return null;
				},
			},
		});

		assert.equal(editorText, '{\n  "botToken": "abc",\n');
	} finally {
		process.env.HOME = originalHome;
	}
});

test("/discord setup without UI does not create config as a side effect", async () => {
	const tempHome = await mkdtemp(
		path.join(os.tmpdir(), "pi-discord-home-setup-no-ui-"),
	);
	const originalHome = process.env.HOME;
	process.env.HOME = tempHome;

	const messages = [];
	const pi = {
		sendMessage(message) {
			messages.push(message);
		},
		registerCommand(name, definition) {
			this.name = name;
			this.definition = definition;
		},
	};

	try {
		piDiscordExtension(pi);
		await pi.definition.handler("setup", { hasUI: false });

		const configPath = path.join(
			tempHome,
			".pi",
			"agent",
			"pi-discord",
			"config.json",
		);
		assert.equal(await pathExists(configPath), false);
		assert.match(messages.at(-1).content, /Interactive setup requires Pi UI/);
	} finally {
		process.env.HOME = originalHome;
	}
});

test("/discord setup falls back to defaults when existing config JSON is malformed", async () => {
	const tempHome = await mkdtemp(
		path.join(os.tmpdir(), "pi-discord-home-setup-malformed-"),
	);
	const originalHome = process.env.HOME;
	process.env.HOME = tempHome;

	const configPath = path.join(
		tempHome,
		".pi",
		"agent",
		"pi-discord",
		"config.json",
	);
	await ensureDir(path.dirname(configPath));
	await writeFile(configPath, '{\n  "botToken": "abc",\n', "utf8");

	const prompts = [];
	const pi = {
		sendMessage() {},
		registerCommand(name, definition) {
			this.name = name;
			this.definition = definition;
		},
	};

	try {
		piDiscordExtension(pi);
		await pi.definition.handler("setup", {
			hasUI: true,
			ui: {
				input: async (label, value) => {
					prompts.push({ label, value });
					return null;
				},
			},
		});

		assert.deepEqual(prompts, [
			{ label: "Discord bot token", value: "" },
			{ label: "Discord application id", value: "" },
			{
				label: "Allowlisted guild ids (comma separated, blank for all)",
				value: "",
			},
		]);
	} finally {
		process.env.HOME = originalHome;
	}
});

test("/discord setup full cancel does not overwrite malformed config", async () => {
	const tempHome = await mkdtemp(
		path.join(os.tmpdir(), "pi-discord-home-setup-cancel-"),
	);
	const originalHome = process.env.HOME;
	process.env.HOME = tempHome;

	const configPath = path.join(
		tempHome,
		".pi",
		"agent",
		"pi-discord",
		"config.json",
	);
	const originalText = '{\n  "botToken": "abc",\n';
	await ensureDir(path.dirname(configPath));
	await writeFile(configPath, originalText, "utf8");

	const pi = {
		sendMessage() {},
		registerCommand(name, definition) {
			this.name = name;
			this.definition = definition;
		},
	};

	try {
		piDiscordExtension(pi);
		await pi.definition.handler("setup", {
			hasUI: true,
			ui: {
				input: async () => null,
			},
		});

		assert.equal(await readFile(configPath, "utf8"), originalText);
	} finally {
		process.env.HOME = originalHome;
	}
});

test("/discord status reports malformed config instead of crashing", async () => {
	const tempHome = await mkdtemp(
		path.join(os.tmpdir(), "pi-discord-home-status-malformed-"),
	);
	const originalHome = process.env.HOME;
	process.env.HOME = tempHome;

	const configPath = path.join(
		tempHome,
		".pi",
		"agent",
		"pi-discord",
		"config.json",
	);
	await ensureDir(path.dirname(configPath));
	await writeFile(configPath, '{\n  "botToken": "abc",\n', "utf8");

	const messages = [];
	const pi = {
		sendMessage(message) {
			messages.push(message);
		},
		registerCommand(name, definition) {
			this.name = name;
			this.definition = definition;
		},
	};

	try {
		piDiscordExtension(pi);
		await pi.definition.handler("status", { hasUI: false });

		assert.match(messages.at(-1).content, /Config read error:/);
	} finally {
		process.env.HOME = originalHome;
	}
});

test("/discord start reports malformed config instead of crashing", async () => {
	const tempHome = await mkdtemp(
		path.join(os.tmpdir(), "pi-discord-home-start-malformed-"),
	);
	const originalHome = process.env.HOME;
	process.env.HOME = tempHome;

	const configPath = path.join(
		tempHome,
		".pi",
		"agent",
		"pi-discord",
		"config.json",
	);
	await ensureDir(path.dirname(configPath));
	await writeFile(configPath, '{\n  "botToken": "abc",\n', "utf8");

	const messages = [];
	const pi = {
		sendMessage(message) {
			messages.push(message);
		},
		registerCommand(name, definition) {
			this.name = name;
			this.definition = definition;
		},
	};

	try {
		piDiscordExtension(pi);
		await pi.definition.handler("start", { hasUI: false });

		assert.match(messages.at(-1).content, /Could not read .*config\.json:/);
		assert.match(
			messages.at(-1).content,
			/Run \/discord open-config to repair it\./,
		);
	} finally {
		process.env.HOME = originalHome;
	}
});

test("/discord setup reports unreadable config paths instead of silently falling back", async () => {
	const tempHome = await mkdtemp(
		path.join(os.tmpdir(), "pi-discord-home-setup-unreadable-"),
	);
	const originalHome = process.env.HOME;
	process.env.HOME = tempHome;

	const configPath = path.join(
		tempHome,
		".pi",
		"agent",
		"pi-discord",
		"config.json",
	);
	await ensureDir(configPath);

	const messages = [];
	const pi = {
		sendMessage(message) {
			messages.push(message);
		},
		registerCommand(name, definition) {
			this.name = name;
			this.definition = definition;
		},
	};

	try {
		piDiscordExtension(pi);
		await pi.definition.handler("setup", {
			hasUI: true,
			ui: {
				input: async () => {
					throw new Error("input should not be reached");
				},
			},
		});

		assert.match(messages.at(-1).content, /Could not read .*config\.json:/);
	} finally {
		process.env.HOME = originalHome;
	}
});

test("/discord open-config reports unreadable config paths instead of crashing", async () => {
	const tempHome = await mkdtemp(
		path.join(os.tmpdir(), "pi-discord-home-open-unreadable-"),
	);
	const originalHome = process.env.HOME;
	process.env.HOME = tempHome;

	const configPath = path.join(
		tempHome,
		".pi",
		"agent",
		"pi-discord",
		"config.json",
	);
	await ensureDir(configPath);

	const messages = [];
	const pi = {
		sendMessage(message) {
			messages.push(message);
		},
		registerCommand(name, definition) {
			this.name = name;
			this.definition = definition;
		},
	};

	try {
		piDiscordExtension(pi);
		await pi.definition.handler("open-config", {
			hasUI: true,
			ui: {
				editor: async () => {
					throw new Error("editor should not be reached");
				},
			},
		});

		assert.match(messages.at(-1).content, /Could not read .*config\.json:/);
	} finally {
		process.env.HOME = originalHome;
	}
});
