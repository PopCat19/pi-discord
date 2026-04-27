import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const STATE_FILE = "presence-state.json";

/**
 * @typedef {"online" | "idle" | "dnd" | "invisible"} PresenceStatus
 */

/**
 * @typedef {Object} PresenceMarker
 * @property {string} name - Marker name (e.g., "sleep", "work", "free")
 * @property {PresenceStatus} status - Discord presence status
 * @property {string} [activity] - Activity text (optional)
 * @property {string} time - Time of state change (HH:MM in timezone)
 */

/**
 * @typedef {Object} PresenceConfig
 * @property {string} [timezone="America/New_York"] - Timezone for schedule
 * @property {string} [refreshTime="00:00"] - Time to regenerate schedule
 * @property {PresenceMarker[]} markers - Presence markers
 */

/**
 * @typedef {Object} PresenceState
 * @property {string} currentMarker
 * @property {PresenceStatus} currentStatus
 * @property {string} [currentActivity]
 * @property {string} lastRefresh - ISO date string
 * @property {PresenceMarker[]} schedule - Current day's schedule
 */

const DEFAULT_MARKERS = [
	{ name: "sleep", status: "idle", activity: "Sleeping", time: "00:00" },
	{ name: "morning", status: "online", activity: "Good morning", time: "07:00" },
	{ name: "work", status: "dnd", activity: "Working", time: "09:00" },
	{ name: "free", status: "online", activity: "Free time", time: "17:00" },
	{ name: "evening", status: "idle", activity: "Winding down", time: "22:00" },
];

export class PresenceManager {
	/**
	 * @param {Object} options
	 * @param {PresenceConfig} options.config
	 * @param {import('discord.js').Client} options.client
	 * @param {string} options.workspaceDir
	 * @param {Object} options.logger
	 */
	constructor({ config, client, workspaceDir, logger }) {
		this.config = config;
		this.client = client;
		this.workspaceDir = workspaceDir;
		this.logger = logger;
		this.state = this.loadState();
		this.checkInterval = null;
		this.refreshTimeout = null;
	}

	loadState() {
		try {
			const data = readFileSync(path.join(this.workspaceDir, STATE_FILE), "utf8");
			return JSON.parse(data);
		} catch {
			return {
				currentMarker: "online",
				currentStatus: "online",
				currentActivity: undefined,
				lastRefresh: new Date(0).toISOString(),
				schedule: [],
			};
		}
	}

	async saveState() {
		try {
			writeFileSync(
				path.join(this.workspaceDir, STATE_FILE),
				JSON.stringify(this.state, null, "\t")
			);
		} catch (err) {
			await this.logger.error("presence-state-save-failed", { error: String(err) });
		}
	}

	/**
	 * Generate a new presence schedule for the day.
	 */
	generateSchedule() {
		const markers = this.config.markers ?? DEFAULT_MARKERS;
		const schedule = [...markers];

		// Shuffle markers slightly for variety (optional)
		// For now, use markers as-is

		return schedule;
	}

	/**
	 * Get current time in configured timezone as minutes since midnight.
	 */
	getCurrentMinutes() {
		const timezone = this.config.timezone ?? "America/New_York";
		const now = new Date();
		const options = { timeZone: timezone, hour: "numeric", minute: "numeric", hour12: false };
		const timeStr = new Intl.DateTimeFormat("en-US", options).format(now);
		const [hour, minute] = timeStr.split(":").map(Number);
		return hour * 60 + minute;
	}

	/**
	 * Check if schedule needs refresh (new day).
	 */
	needsRefresh() {
		const timezone = this.config.timezone ?? "America/New_York";
		const lastRefresh = new Date(this.state.lastRefresh);
		
		// Get date in timezone
		const nowInTz = new Date(new Date().toLocaleString("en-US", { timeZone: timezone }));
		const lastInTz = new Date(lastRefresh.toLocaleString("en-US", { timeZone: timezone }));

		return nowInTz.getDate() !== lastInTz.getDate();
	}

	/**
	 * Find the marker for current time.
	 * Returns the most recent marker whose time has passed.
	 */
	findMarkerForTime(schedule, currentMinutes) {
		// Sort by time
		const sorted = [...schedule].sort((a, b) => {
			const [aH, aM] = a.time.split(":").map(Number);
			const [bH, bM] = b.time.split(":").map(Number);
			return (aH * 60 + aM) - (bH * 60 + bM);
		});

		// Find most recent passed marker
		let current = sorted[sorted.length - 1]; // Default to last marker
		for (const marker of sorted) {
			const [h, m] = marker.time.split(":").map(Number);
			const markerMinutes = h * 60 + m;
			if (markerMinutes <= currentMinutes) {
				current = marker;
			} else {
				break;
			}
		}
		return current;
	}

	/**
	 * Update Discord presence.
	 */
	async updatePresence(marker) {
		if (!this.client.user) return;

		const status = marker.status ?? "online";
		const activity = marker.activity ? { name: marker.activity, type: 0 } : undefined;

		try {
			await this.client.user.setPresence({
				status,
				activities: activity ? [activity] : [],
			});

			this.state.currentMarker = marker.name;
			this.state.currentStatus = status;
			this.state.currentActivity = marker.activity;
			await this.saveState();

			await this.logger.info("presence-updated", {
				marker: marker.name,
				status,
				activity: marker.activity,
			});
		} catch (err) {
			await this.logger.error("presence-update-failed", { error: String(err) });
		}
	}

	/**
	 * Check and update presence based on schedule.
	 */
	async checkAndUpdatePresence() {
		// Refresh schedule if new day
		if (this.needsRefresh()) {
			this.state.schedule = this.generateSchedule();
			this.state.lastRefresh = new Date().toISOString();
			await this.saveState();
			await this.logger.info("presence-schedule-refreshed");
		}

		const schedule = this.state.schedule.length > 0
			? this.state.schedule
			: this.generateSchedule();

		const currentMinutes = this.getCurrentMinutes();
		const marker = this.findMarkerForTime(schedule, currentMinutes);

		// Only update if changed
		if (marker.name !== this.state.currentMarker) {
			await this.updatePresence(marker);
		}
	}

	/**
	 * Start the presence manager.
	 */
	start() {
		// Initial update
		this.checkAndUpdatePresence().catch(err =>
			this.logger.error("presence-initial-update-failed", { error: String(err) })
		);

		// Check every minute
		this.checkInterval = setInterval(() => {
			this.checkAndUpdatePresence().catch(err =>
				this.logger.error("presence-check-failed", { error: String(err) })
			);
		}, 60000);

		// Schedule next day's refresh at 00:00 timezone
		this.scheduleNextRefresh();
	}

	/**
	 * Schedule refresh at next 00:00 in configured timezone.
	 */
	scheduleNextRefresh() {
		const timezone = this.config.timezone ?? "America/New_York";
		const now = new Date();

		// Get next midnight in timezone
		const tomorrow = new Date(now);
		tomorrow.setDate(tomorrow.getDate() + 1);
		tomorrow.setHours(0, 0, 0, 0);

		// Convert to local time
		const midnightInTz = new Date(
			tomorrow.toLocaleString("en-US", { timeZone: timezone })
		);
		const localMidnight = new Date(
			tomorrow.toLocaleString("en-US", { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
		);

		const delay = localMidnight.getTime() - now.getTime();

		this.refreshTimeout = setTimeout(() => {
			this.state.schedule = this.generateSchedule();
			this.state.lastRefresh = new Date().toISOString();
			this.saveState();
			this.logger.info("presence-schedule-refreshed");
			this.scheduleNextRefresh();
		}, delay);
	}

	/**
	 * Stop the presence manager.
	 */
	stop() {
		if (this.checkInterval) {
			clearInterval(this.checkInterval);
			this.checkInterval = null;
		}
		if (this.refreshTimeout) {
			clearTimeout(this.refreshTimeout);
			this.refreshTimeout = null;
		}
	}

	/**
	 * Get current presence info.
	 */
	getInfo() {
		return {
			marker: this.state.currentMarker,
			status: this.state.currentStatus,
			activity: this.state.currentActivity,
			lastRefresh: this.state.lastRefresh,
		};
	}
}