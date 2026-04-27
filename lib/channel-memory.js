import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { sanitize, sanitizeObject } from "./sensitivity-filter.js";

/**
 * @typedef {Object} MemoryEntry
 * @property {string} timestamp
 * @property {string} scene
 * @property {Array<{speaker: string, text: string}>} [turns]
 * @property {string} [topic]
 * @property {string} [source]
 */

/**
 * @typedef {Object} CompressedEntry
 * @property {string} date
 * @property {string[]} scenes
 * @property {string} summary
 */

/**
 * @typedef {Object} MemoryState
 * @property {string} channelId
 * @property {number} tokenEstimate
 * @property {number} maxTokens
 * @property {CompressedEntry[]} compressed
 * @property {MemoryEntry[]} recent
 * @property {string} [lastRotation]
 * @property {string} [createdAt]
 */

const DEFAULT_MAX_TOKENS = 8192;
const ENTRIES_TO_COMPRESS = 3;

export class ChannelMemory {
	/**
	 * @param {{ path: string, maxTokens?: number }} options
	 */
	constructor(options) {
		this.path = options.path;
		this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
		this.state = this.load();
	}

	/**
	 * Get default empty state.
	 * @param {string} channelId
	 * @returns {MemoryState}
	 */
	getDefaultState(channelId = "") {
		return {
			channelId,
			tokenEstimate: 0,
			maxTokens: this.maxTokens,
			compressed: [],
			recent: [],
			createdAt: new Date().toISOString(),
		};
	}

	/**
	 * Load memory from disk.
	 * @returns {MemoryState}
	 */
	load() {
		if (!existsSync(this.path)) {
			const dir = path.dirname(this.path);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			return this.getDefaultState();
		}

		try {
			const data = readFileSync(this.path, "utf8");
			const state = JSON.parse(data);
			// Migration: ensure fields exist
			state.compressed = state.compressed ?? [];
			state.recent = state.recent ?? [];
			state.maxTokens = state.maxTokens ?? this.maxTokens;
			return state;
		} catch {
			return this.getDefaultState();
		}
	}

	/**
	 * Save memory to disk.
	 */
	save() {
		const dir = path.dirname(this.path);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(this.path, JSON.stringify(this.state, null, "\t"));
	}

	/**
	 * Estimate token count from text.
	 * Rough approximation: ~4 chars per token.
	 * @param {string} text
	 * @returns {number}
	 */
	estimateTokens(text) {
		if (!text) return 0;
		return Math.ceil(text.length / 4);
	}

	/**
	 * Calculate total token estimate.
	 * @returns {number}
	 */
	calculateTokenEstimate() {
		const compressedText = JSON.stringify(this.state.compressed);
		const recentText = JSON.stringify(this.state.recent);
		return this.estimateTokens(compressedText) + this.estimateTokens(recentText);
	}

	/**
	 * Append a new memory entry.
	 * @param {MemoryEntry} entry
	 */
	append(entry) {
		const sanitized = sanitizeObject(entry);
		this.state.recent.push({
			timestamp: new Date().toISOString(),
			...sanitized,
		});
		this.state.tokenEstimate = this.calculateTokenEstimate();
		this.checkRotation();
		this.save();
	}

	/**
	 * Check if rotation is needed and perform it.
	 */
	checkRotation() {
		while (this.state.tokenEstimate > this.maxTokens && this.state.recent.length > ENTRIES_TO_COMPRESS) {
			this.rotate();
		}
	}

	/**
	 * Compress oldest entries into summary.
	 */
	rotate() {
		if (this.state.recent.length < ENTRIES_TO_COMPRESS) return;

		const toCompress = this.state.recent.slice(0, ENTRIES_TO_COMPRESS);
		
		// Extract scenes
		const scenes = [...new Set(toCompress.map(e => e.scene).filter(Boolean))];
		
		// Simple compression: extract key info
		const summary = this.extractSummary(toCompress);
		
		this.state.compressed.push({
			date: toCompress[0].timestamp.split("T")[0],
			scenes,
			summary,
		});

		this.state.recent = this.state.recent.slice(ENTRIES_TO_COMPRESS);
		this.state.lastRotation = new Date().toISOString();
		this.state.tokenEstimate = this.calculateTokenEstimate();
	}

	/**
	 * Extract summary from entries.
	 * Simple extraction for now - can be enhanced with LLM later.
	 * @param {MemoryEntry[]} entries
	 * @returns {string}
	 */
	extractSummary(entries) {
		const parts = [];
		
		for (const entry of entries) {
			if (entry.scene) {
				const turnCount = entry.turns?.length ?? 0;
				if (entry.topic) {
					parts.push(`${entry.scene}: discussed "${entry.topic}" (${turnCount} turns)`);
				} else {
					parts.push(`${entry.scene} (${turnCount} turns)`);
				}
			}
		}
		
		return parts.join("; ") || "Conversation occurred.";
	}

	/**
	 * Get formatted context for injection into prompts.
	 * @returns {string}
	 */
	getContext() {
		const lines = [];

		if (this.state.compressed.length > 0) {
			lines.push("## Past Conversations");
			for (const c of this.state.compressed) {
				lines.push(`[${c.date}] ${c.summary}`);
			}
			lines.push("");
		}

		if (this.state.recent.length > 0) {
			lines.push("## Recent");
			for (const entry of this.state.recent) {
				if (entry.scene) {
					lines.push(`[${entry.scene}]`);
				}
				if (entry.turns) {
					for (const turn of entry.turns) {
						lines.push(`${turn.speaker}: ${turn.text}`);
					}
				}
			}
		}

		return lines.join("\n");
	}

	/**
	 * Get list of discussed topics for deduplication.
	 * @returns {string[]}
	 */
	getTopics() {
		const topics = [];
		
		for (const c of this.state.compressed) {
			topics.push(...c.scenes);
		}
		
		for (const entry of this.state.recent) {
			if (entry.scene) topics.push(entry.scene);
			if (entry.topic) topics.push(entry.topic);
		}
		
		return [...new Set(topics)];
	}

	/**
	 * Check if a topic was recently discussed.
	 * @param {string} topic
	 * @param {number} [withinDays=7] - How many days to check
	 * @returns {boolean}
	 */
	wasRecentlyDiscussed(topic, withinDays = 7) {
		const cutoff = Date.now() - withinDays * 24 * 60 * 60 * 1000;
		
		for (const entry of this.state.recent) {
			if (entry.topic === topic || entry.scene === topic) {
				if (new Date(entry.timestamp).getTime() > cutoff) {
					return true;
				}
			}
		}
		
		for (const c of this.state.compressed) {
			if (c.scenes.includes(topic)) {
				const date = new Date(c.date).getTime();
				if (date > cutoff) {
					return true;
				}
			}
		}
		
		return false;
	}

	/**
	 * Clear all memory.
	 */
	clear() {
		this.state = this.getDefaultState(this.state.channelId);
		this.save();
	}

	/**
	 * Get memory stats.
	 * @returns {{ entries: number, compressed: number, tokens: number, topics: number }}
	 */
	getStats() {
		return {
			entries: this.state.recent.length,
			compressed: this.state.compressed.length,
			tokens: this.state.tokenEstimate,
			topics: this.getTopics().length,
		};
	}
}