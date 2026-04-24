import { appendFile } from "node:fs/promises";
import path from "node:path";
import { ensureDir } from "../lib/fs.js";

export class Logger {
	/**
	 * @param {string} filePath
	 */
	constructor(filePath) {
		this.filePath = filePath;
	}

	async log(level, message, details) {
		try {
			const line = JSON.stringify({
				timestamp: new Date().toISOString(),
				level,
				message,
				details,
			});
			await ensureDir(path.dirname(this.filePath));
			await appendFile(this.filePath, `${line}\n`, "utf8");
		} catch {
			return;
		}
	}

	info(message, details) {
		return this.log("info", message, details);
	}

	warn(message, details) {
		return this.log("warn", message, details);
	}

	error(message, details) {
		return this.log("error", message, details);
	}
}
