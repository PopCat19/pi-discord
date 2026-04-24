import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Logger } from "../daemon/logger.js";

test("logger ignores unserializable details instead of throwing", async () => {
	const tempDir = await mkdtemp(path.join(os.tmpdir(), "pi-discord-logger-"));
	const logPath = path.join(tempDir, "daemon.log");
	const logger = new Logger(logPath);
	const details = {};
	details.self = details;

	await assert.doesNotReject(logger.error("circular", details));
	await logger.info("plain", { ok: true });

	const content = await readFile(logPath, "utf8");
	assert.match(content, /"message":"plain"/);
});
