/**
 * Creates a stable route key from Discord identifiers.
 * @param {{ guildId?: string | null, channelId: string, threadId?: string | null }} input
 */
export function makeRouteKey(input) {
	const guildPart = input.guildId ?? "dm";
	const threadPart = input.threadId ?? "root";
	return `${guildPart}__${input.channelId}__${threadPart}`;
}
