import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelMemory } from "../lib/channel-memory.js";
import { sanitize, sanitizeObject } from "../lib/sensitivity-filter.js";

const tmpDir = mkdtempSync(join(tmpdir(), "channel-memory-test-"));

try {
	console.log("Testing sensitivity filter...");
	assert.ok(sanitize("Token: abc123xyz789").includes("REDACTED"));
	assert.equal(sanitize("Email: test@example.com"), "Email: [EMAIL]");
	assert.equal(sanitize("Card: 1234 5678 9012 3456"), "Card: [CARD]");
	assert.equal(sanitize("Normal text"), "Normal text");
	console.log("  ✓ sanitize() works");

	const obj = { token: "secret123", data: "public" };
	const sanitized = sanitizeObject(obj);
	assert.equal(sanitized.token, "[REDACTED]");
	assert.equal(sanitized.data, "public");
	console.log("  ✓ sanitizeObject() works");

	console.log("\nTesting ChannelMemory...");
	const memPath = join(tmpDir, "memory.json");
	const mem = new ChannelMemory({ path: memPath, maxTokens: 1000 });

	assert.deepEqual(mem.getStats(), { entries: 0, compressed: 0, tokens: 0, topics: 0 });
	console.log("  ✓ Empty memory created");

	mem.append({ scene: "test-scene", turns: [{ speaker: "plana", text: "Hello" }] });
	assert.equal(mem.state.recent.length, 1);
	assert.equal(mem.getTopics().length, 1);
	console.log("  ✓ append() works");

	const ctx = mem.getContext();
	assert.ok(ctx.includes("test-scene"));
	assert.ok(ctx.includes("plana: Hello"));
	console.log("  ✓ getContext() works");

	assert.ok(!mem.wasRecentlyDiscussed("other-topic"));
	assert.ok(mem.wasRecentlyDiscussed("test-scene"));
	console.log("  ✓ wasRecentlyDiscussed() works");

	mem.clear();
	assert.equal(mem.state.recent.length, 0);
	assert.equal(mem.state.compressed.length, 0);
	console.log("  ✓ clear() works");

	console.log("\nTesting rotation...");
	const rotMem = new ChannelMemory({ path: join(tmpDir, "rot.json"), maxTokens: 500 });
	for (let i = 0; i < 30; i++) {
		rotMem.append({
			scene: `scene-${i}`,
			topic: `topic-${i}`,
			turns: [{ speaker: "bot", text: `Message ${i}` }],
		});
	}
	assert.ok(rotMem.state.compressed.length > 0);
	assert.ok(rotMem.state.recent.length < 15);
	console.log(`  ✓ Rotation works (${rotMem.state.compressed.length} compressed, ${rotMem.state.recent.length} recent, ~${rotMem.state.tokenEstimate} tokens)`);

	console.log("\nAll tests passed!");
} finally {
	rmSync(tmpDir, { recursive: true, force: true });
}