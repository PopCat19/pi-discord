import { readFile } from "node:fs/promises";
import path from "node:path";
import { appendJsonLine, ensureDir } from "../lib/fs.js";

export class JournalStore {
	/**
	 * @param {string} filePath
	 */
	constructor(filePath) {
		this.filePath = filePath;
		this.entries = [];
		this.sourceIds = new Set();
	}

	async load() {
		await ensureDir(path.dirname(this.filePath));
		try {
			const content = await readFile(this.filePath, "utf8");
			this.entries = content
				.split(/\r?\n/)
				.filter(Boolean)
				.flatMap((line) => {
					try {
						return [JSON.parse(line)];
					} catch {
						return [];
					}
				});
			this.sourceIds = new Set(
				this.entries.map((entry) => entry.sourceId).filter(Boolean),
			);
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
			this.entries = [];
			this.sourceIds = new Set();
		}
		return this.entries;
	}

	hasSource(sourceId) {
		return this.sourceIds.has(sourceId);
	}

	recent(limit = 25, predicate = () => true) {
		return this.entries.filter(predicate).slice(-limit);
	}

	async append(entry) {
		this.entries.push(entry);
		if (entry.sourceId) this.sourceIds.add(entry.sourceId);
		await appendJsonLine(this.filePath, entry);
	}
}
