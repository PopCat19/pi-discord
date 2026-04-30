import { readFile } from "node:fs/promises";
import {
	MAX_CONTEXT_CHARS,
	MAX_CONTEXT_LINES,
	DEFAULT_CONTEXT_CHARS,
	DEFAULT_CONTEXT_LINES,
} from "../lib/constants.js";

/**
 * @param {{
 *   routeKey: string,
 *   scope: { guildId: string | null, channelId: string, threadId: string | null },
 *   requester: { id: string, name: string },
 *   trigger: string,
 *   rawText: string,
 *   replyContext?: string,
 *   savedAttachments: Array<{ path: string, name: string, contentType?: string, isImage: boolean }>
 * }} input
 */
export function buildPromptText(input) {
	const sections = [
		`Discord route: ${input.routeKey}`,
		`Requester: ${input.requester.name} (${input.requester.id})`,
		`Trigger: ${input.trigger}`,
		`Guild: ${input.scope.guildId ?? "DM"}`,
		`Channel: ${input.scope.channelId}`,
	];

	if (input.scope.threadId) sections.push(`Thread: ${input.scope.threadId}`);
	if (input.replyContext)
		sections.push(`Reply context:\n${input.replyContext}`);
	if (input.savedAttachments.length > 0) {
		sections.push(
			`Saved attachments:\n${input.savedAttachments
				.map(
					(attachment) =>
						`- ${attachment.name} -> ${attachment.path}${attachment.contentType ? ` (${attachment.contentType})` : ""}`,
				)
				.join("\n")}`,
		);
	}
	sections.push(`User request:\n${input.rawText || "(empty message)"}`);
	return sections.join("\n\n");
}

/**
 * @param {{ memory?: { getContext: () => string }, memoryPath?: string, journal: import('./journal.js').JournalStore, excludeSourceId?: string, contextLimits?: { lines?: number, chars?: number } }} input
 */
export async function buildInjectedContext(input) {
	// Apply configurable limits with upper bound guards
	const maxLines = Math.min(
		input.contextLimits?.lines ?? DEFAULT_CONTEXT_LINES,
		MAX_CONTEXT_LINES,
	);
	const maxChars = Math.min(
		input.contextLimits?.chars ?? DEFAULT_CONTEXT_CHARS,
		MAX_CONTEXT_CHARS,
	);

	let memoryText = "";

	// Use ChannelMemory if available, otherwise fall back to file
	if (input.memory) {
		memoryText = input.memory.getContext();
	} else if (input.memoryPath) {
		try {
			memoryText = await readFile(input.memoryPath, "utf8");
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
	}

	const recentMessages = input.journal
		.recent(
			maxLines,
			(entry) =>
				(entry.kind === "ambient" ||
					entry.kind === "inbound" ||
					entry.kind === "reaction") &&
				entry.sourceId !== input.excludeSourceId,
		)
		.map((entry) => {
			if (entry.kind === "reaction") {
				return `${entry.emoji} ${entry.authorName ?? "someone"} reacted`;
			}
			return `${entry.authorName ?? entry.authorId ?? "unknown"}: ${entry.text ?? ""}`;
		})
		.join("\n");

	const blocks = [];
	if (memoryText.trim()) {
		blocks.push(
			`Route memory:\n${memoryText.trim().slice(0, maxChars)}`,
		);
	}
	if (recentMessages.trim()) {
		blocks.push(
			`Recent Discord context:\n${recentMessages.slice(0, maxChars)}`,
		);
	}
	return blocks.join("\n\n");
}