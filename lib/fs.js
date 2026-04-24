import { randomUUID } from "node:crypto";
import {
	access,
	mkdir,
	open,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import path from "node:path";

/**
 * Ensures a directory exists.
 * @param {string} dir
 */
export async function ensureDir(dir) {
	await mkdir(dir, { recursive: true });
}

/**
 * Returns true when a path exists.
 * @param {string} targetPath
 */
export async function pathExists(targetPath) {
	try {
		await access(targetPath);
		return true;
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
}

/**
 * Reads JSON from disk, returning a fallback when the file does not exist.
 * @template T
 * @param {string} filePath
 * @param {T} fallback
 * @returns {Promise<T>}
 */
export async function readJson(filePath, fallback) {
	try {
		const content = await readFile(filePath, "utf8");
		return /** @type {T} */ (JSON.parse(content));
	} catch (error) {
		if (error?.code === "ENOENT") return fallback;
		throw error;
	}
}

/**
 * Writes JSON atomically.
 * @param {string} filePath
 * @param {unknown} value
 */
export async function writeJson(filePath, value) {
	await ensureDir(path.dirname(filePath));
	const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
	await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await rename(tempPath, filePath);
}

/**
 * Appends a JSON line.
 * @param {string} filePath
 * @param {unknown} value
 */
export async function appendJsonLine(filePath, value) {
	await ensureDir(path.dirname(filePath));
	const handle = await open(filePath, "a");
	try {
		await handle.write(`${JSON.stringify(value)}\n`);
	} finally {
		await handle.close();
	}
}

/**
 * Removes a file if it exists.
 * @param {string} filePath
 */
export async function removeIfExists(filePath) {
	await rm(filePath, { force: true });
}

/**
 * Makes a string safe for file paths.
 * @param {string} value
 */
export function sanitizeSegment(value) {
	return (
		value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "route"
	);
}

/**
 * Tails a UTF-8 text file.
 * @param {string} filePath
 * @param {number} maxLines
 */
export async function tailFile(filePath, maxLines = 80) {
	try {
		const content = await readFile(filePath, "utf8");
		return content.split(/\r?\n/).filter(Boolean).slice(-maxLines).join("\n");
	} catch (error) {
		if (error?.code === "ENOENT") return "";
		throw error;
	}
}
