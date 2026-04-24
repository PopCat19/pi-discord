import { REST, Routes, SlashCommandBuilder } from "discord.js";

/**
 * Builds the Discord slash command definitions.
 * @param {import('./config.js').PiDiscordConfig} config
 */
export function buildSlashCommands(config) {
	return [
		new SlashCommandBuilder()
			.setName(config.commandName)
			.setDescription("Interact with the pi Discord route")
			.addSubcommand((subcommand) =>
				subcommand
					.setName("ask")
					.setDescription("Send a prompt to pi")
					.addStringOption((option) =>
						option
							.setName("text")
							.setDescription("Prompt text")
							.setRequired(true),
					),
			)
			.addSubcommand((subcommand) =>
				subcommand.setName("status").setDescription("Show route queue status"),
			)
			.addSubcommand((subcommand) =>
				subcommand.setName("stop").setDescription("Stop the active route run"),
			)
			.addSubcommand((subcommand) =>
				subcommand
					.setName("reset")
					.setDescription("Reset the current route session"),
			),
	].map((command) => command.toJSON());
}

/**
 * Registers Discord slash commands.
 * @param {import('./config.js').PiDiscordConfig} config
 */
export async function syncSlashCommands(config) {
	const rest = new REST({ version: "10" }).setToken(config.botToken);
	const body = buildSlashCommands(config);

	if (config.registerCommandsGlobally) {
		await rest.put(Routes.applicationCommands(config.applicationId), { body });
		return { scope: "global", count: body.length };
	}

	if (config.allowedGuildIds.length === 0) {
		throw new Error(
			"Set at least one `allowedGuildIds` entry or enable `registerCommandsGlobally`.",
		);
	}

	for (const guildId of config.allowedGuildIds) {
		await rest.put(
			Routes.applicationGuildCommands(config.applicationId, guildId),
			{ body },
		);
	}
	return {
		scope: "guild",
		count: body.length,
		guildIds: config.allowedGuildIds.slice(),
	};
}
