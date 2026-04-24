import assert from "node:assert/strict";
import test from "node:test";
import { authorizeInteraction } from "../daemon/authz.js";
import { createDefaultConfig } from "../lib/config.js";
import { getPaths } from "../lib/paths.js";

function baseConfig() {
	return createDefaultConfig(
		getPaths({ agentDir: "/tmp/agent", workspaceDir: "/tmp/agent/pi-discord" }),
	);
}

test("dm access is deny-by-default unless the user is allowlisted", () => {
	const config = baseConfig();
	const message = { guildId: null, author: { id: "u1" } };
	assert.equal(authorizeInteraction(message, config).allowed, false);
	config.dmAllowlistUserIds.push("u1");
	assert.equal(authorizeInteraction(message, config).allowed, true);
});

test("guild allowlist and admin control are keyed by stable ids", () => {
	const config = baseConfig();
	config.allowedGuildIds = ["g1"];
	config.adminUserIds = ["u1"];
	const interaction = { guildId: "g1", user: { id: "u1" } };
	const result = authorizeInteraction(interaction, config);
	assert.equal(result.allowed, true);
	assert.equal(result.canControl, true);
	assert.equal(
		authorizeInteraction({ guildId: "g2", user: { id: "u1" } }, config).allowed,
		false,
	);
});
