import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { sanitizeObject } from "./sensitivity-filter.js";

const DEFAULT_COMPRESSION_TIMEOUT_MS = 60000; // 60s per attempt
const DEFAULT_COMPRESSION_MAX_RETRIES = 3;
const ENTRIES_TO_COMPRESS = 3;

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

export class ChannelMemory {
	/**
	 * @param {{ path: string, maxTokens?: number, compressionTimeout?: number, compressionRetries?: number, getSession?: () => Promise<unknown> }} options
	 */
	constructor(options) {
		this.path = options.path;
		this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
		this.compressionTimeout = options.compressionTimeout ?? DEFAULT_COMPRESSION_TIMEOUT_MS;
		this.compressionRetries = options.compressionRetries ?? DEFAULT_COMPRESSION_MAX_RETRIES;
		this.getSession = options.getSession;
		this.state = this.load();
		this.pendingCompressions = new Map(); // Track in-flight compressions
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
			const entryId = this.rotate();
			if (entryId) {
				// Schedule async LLM compression in background
				this.scheduleAsyncCompression(entryId);
			}
		}
	}

	/**
	 * Compress oldest entries into summary.
	 * Synchronous - uses simple extraction, never blocks.
	 * @returns {string | null} The compressed entry ID if rotation occurred
	 */
	rotate() {
		if (this.state.recent.length < ENTRIES_TO_COMPRESS) return null;

		const toCompress = this.state.recent.slice(0, ENTRIES_TO_COMPRESS);
		
		// Extract scenes
		const scenes = [...new Set(toCompress.map(e => e.scene).filter(Boolean))];
		
		// Simple compression: extract key info (fast, always works)
		const summary = this.extractSummary(toCompress);
		const entryId = `${toCompress[0].timestamp.split("T")[0]}-${scenes.join("-")}`;
		
		this.state.compressed.push({
			id: entryId,
			date: toCompress[0].timestamp.split("T")[0],
			scenes,
			summary,
			llmCompressed: false,
		});

		this.state.recent = this.state.recent.slice(ENTRIES_TO_COMPRESS);
		this.state.lastRotation = new Date().toISOString();
		this.state.tokenEstimate = this.calculateTokenEstimate();
		
		return entryId;
	}

	/**
	 * Schedule async LLM compression in background.
	 * Falls back to extraction on error/timeout.
	 * @param {string} entryId - The compressed entry to enhance
	 */
	scheduleAsyncCompression(entryId) {
		if (!this.getSession) return; // No session provider configured
		if (this.pendingCompressions.has(entryId)) return; // Already in progress
		
		this.pendingCompressions.set(entryId, true);
		
		// Run in background, never block
		this.runAsyncCompression(entryId).catch(() => {
			// Silently fail, extraction summary already in place
		}).finally(() => {
			this.pendingCompressions.delete(entryId);
		});
	}

	/**
	 * Run async compression with retry and timeout.
	 * @param {string} entryId
	 */
	async runAsyncCompression(entryId) {
		const entry = this.state.compressed.find(e => e.id === entryId);
		if (!entry || entry.llmCompressed) return;

		let lastError;
		for (let attempt = 0; attempt < this.compressionRetries; attempt++) {
			try {
				const session = await Promise.race([
					this.getSession(),
					this.timeout(this.compressionTimeout, "Session acquire"),
				]);
				
				// Reconstruct original entries from summary + recent
				const entries = this.reconstructEntries(entry);
				if (!entries) return; // Can't reconstruct
				
				const summary = await Promise.race([
					this.compressWithSession(session, entries),
					this.timeout(this.compressionTimeout, `Compression attempt ${attempt + 1}`),
				]);
				
				// Success - update entry
				entry.summary = summary;
				entry.llmCompressed = true;
				this.save();
				return;
			} catch (err) {
				// Wait before retry
				if (attempt < this.compressionRetries - 1) {
					await new Promise(r => setTimeout(r, 5000));
				}
			}
		}
		// All retries failed - extraction summary remains in place
	}

	/**
	 * Timeout wrapper.
	 * @param {number} ms
	 * @param {string} label
	 */
	timeout(ms, label) {
		return new Promise((_, reject) => {
			setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
		});
	}

	/**
	 * Reconstruct entries from compressed entry info.
	 * Best effort - returns null if not possible.
	 * @param {CompressedEntry} entry
	 * @returns {MemoryEntry[] | null}
	 */
	reconstructEntries(entry) {
		// If we still have recent entries that match, use them
		const matchingRecent = this.state.recent.filter(e => 
			entry.scenes.includes(e.scene)
		);
		if (matchingRecent.length > 0) {
			return matchingRecent;
		}
		// Otherwise can't reconstruct - use extraction summary
		return null;
	}

	/**
	 * Compress entries using LLM session.
	 * @param {unknown} session
	 * @param {MemoryEntry[]} entries
	 * @returns {Promise<string>}
	 */
	async compressWithSession(session, entries) {
		const turns = entries.flatMap(e => 
			(e.turns ?? []).map(t => `${t.speaker}: ${t.text}`)
		);
		
		const prompt = `Summarize this conversation in 2-3 sentences. Keep: topics discussed, key reactions, emotional tone. Omit: filler, repeated info.

Conversation:
${turns.join("\n")}`;

		// Session should have a send method (pi-coding-agent session)
		if (session && typeof session.send === "function") {
			const result = await session.send(prompt);
			return typeof result === "string" ? result : result.text ?? String(result);
		}
		
		// Fallback if session doesn't match expected interface
		return this.extractSummary(entries);
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