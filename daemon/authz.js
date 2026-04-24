/**
 * @param {import('discord.js').Message | import('discord.js').ChatInputCommandInteraction | import('discord.js').ButtonInteraction} subject
 * @param {import('../lib/config.js').PiDiscordConfig} config
 */
export function authorizeInteraction(subject, config) {
	const guildId = "guildId" in subject ? (subject.guildId ?? null) : null;
	const userId = getUserId(subject);

	if (!userId) {
		return { allowed: false, reason: "Missing requester identity." };
	}

	if (!guildId) {
		if (config.dmAllowlistUserIds.includes(userId)) {
			return {
				allowed: true,
				canControl: config.adminUserIds.includes(userId),
			};
		}
		return {
			allowed: false,
			reason: "Direct messages are restricted to allowlisted Discord user ids.",
		};
	}

	if (
		config.allowedGuildIds.length > 0 &&
		!config.allowedGuildIds.includes(guildId)
	) {
		return { allowed: false, reason: `Guild ${guildId} is not allowlisted.` };
	}

	return {
		allowed: true,
		canControl: config.adminUserIds.includes(userId),
	};
}

/**
 * @param {import('discord.js').Message | import('discord.js').ChatInputCommandInteraction | import('discord.js').ButtonInteraction} subject
 */
function getUserId(subject) {
	return subject.author?.id ?? subject.user?.id;
}
