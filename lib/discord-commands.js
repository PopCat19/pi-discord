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
			)
			.addSubcommand((subcommand) =>
				subcommand
					.setName("wipe")
					.setDescription("Wipe route session, journal, and memory (full reset)"),
			)
			.addSubcommand((subcommand) =>
				subcommand
					.setName("regen")
					.setDescription("Regenerate the last bot response"),
			)
			.addSubcommand((subcommand) =>
				subcommand
					.setName("halt")
					.setDescription("Stop all running/queued items (admin)"),
			)
			.addSubcommand((subcommand) =>
				subcommand
					.setName("backup")
					.setDescription("Backup current route memory (admin)"),
			)
			.addSubcommand((subcommand) =>
				subcommand
					.setName("scrub")
					.setDescription("Clear route memory, optionally backup first (admin)")
					.addBooleanOption((option) =>
						option
							.setName("backup")
							.setDescription("Create backup before scrubbing")
							.setRequired(false),
					)
					.addBooleanOption((option) =>
						option
							.setName("journal")
							.setDescription("Also clear conversation journal")
							.setRequired(false),
					)
					.addBooleanOption((option) =>
						option
							.setName("clear")
							.setDescription("Delete bot messages and mark new state")
							.setRequired(false),
					),
			)
			.addSubcommand((subcommand) =>
				subcommand
					.setName("routes")
					.setDescription("List all routes (admin)")
					.addStringOption((option) =>
						option
							.setName("wipe")
							.setDescription("Wipe stale routes older than X days")
							.addChoices(
								{ name: "1 day", value: "1" },
								{ name: "7 days", value: "7" },
								{ name: "30 days", value: "30" },
								{ name: "all", value: "all" },
							)
							.setRequired(false),
					),
			)
			.addSubcommand((subcommand) =>
				subcommand
					.setName("scene")
					.setDescription("Trigger a custom scenario prompt")
					.addStringOption((option) =>
						option
							.setName("prompt")
							.setDescription("Custom scenario prompt")
							.setRequired(true),
					)
					.addStringOption((option) =>
						option
							.setName("context")
							.setDescription("Additional context for the scenario")
							.setRequired(false),
					)
					.addStringOption((option) =>
						option
							.setName("participants")
							.setDescription("Who participates (comma-separated: arona,plana,arisu,kei)")
							.setRequired(false),
					)
					.addIntegerOption((option) =>
						option
							.setName("turns")
							.setDescription("Number of conversation turns (default: 2)")
							.setRequired(false),
					),
			)
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
			"Set at least one `allowedGuildIds` entry or enable `registerCommandsGilibally`.",
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