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
 * @typedef {Object} PresenceActivity
 * @property {PresenceStatus} status
 * @property {string} [activity]
 */

/**
 * @typedef {Object} PresenceConfig
 * @property {string} [timezone="America/New_York"] - Timezone for schedule
 * @property {PresenceMarker[]} [base] - Base schedule markers (time-based)
 * @property {Record<string, PresenceActivity>} [activities] - Named activities for dynamic use
 */

/**
 * @typedef {Object} PresenceState
 * @property {string} currentMarker
 * @property {PresenceStatus} currentStatus
 * @property {string} [currentActivity]
 * @property {string} lastRefresh - ISO date string
 * @property {PresenceMarker[]} schedule - Current day's schedule
 */

const DEFAULT_BASE = [
	{ name: "sleep", status: "idle", activity: "Standby", time: "00:00" },
	{ name: "morning", status: "online", activity: "Online", time: "07:00" },
	{ name: "work", status: "online", activity: "Active", time: "09:00" },
	{ name: "free", status: "online", activity: "Idle", time: "17:00" },
	{ name: "evening", status: "idle", activity: "Power save", time: "22:00" },
];

const DEFAULT_ACTIVITIES = {
	processing: { status: "online", activity: "Processing" },
	thinking: { status: "online", activity: "Computing" },
	reading: { status: "online", activity: "Reading" },
	discussing: { status: "online", activity: "Syncing" },
};

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
		
		// Dynamic presence state (overrides schedule)
		this.dynamicMarker = null;
		this.dynamicTimeout = null;
	}

	/**
	 * Set base schedule (called by orchestrator).
	 * @param {PresenceMarker[]} schedule
	 */
	async setBase(schedule) {
		this.state.schedule = schedule;
		this.state.lastRefresh = new Date().toISOString();
		await this.saveState();
		await this.logger.info("presence-base-updated", {
			markers: schedule.map(m => m.name),
		});
		
		// Apply current marker
		const marker = this.findMarkerForTime(schedule, this.getCurrentMinutes());
		await this.updatePresence(marker);
	}

	/**
	 * Set activity by name (looks up from config.activities).
	 * @param {string} name - Activity name (e.g., "processing", "thinking")
	 * @param {Object} [options]
	 * @param {number} [options.ttl=60000] - Time until auto-clear (ms)
	 */
	async setActivity(name, { ttl = 60000 } = {}) {
		const activities = this.config.activities ?? DEFAULT_ACTIVITIES;
		const activity = activities[name];
		
		if (!activity) {
			await this.logger.warn("presence-activity-not-found", { name });
			return;
		}
		
		if (this.dynamicTimeout) {
			clearTimeout(this.dynamicTimeout);
		}
		
		this.dynamicMarker = { name, ...activity };
		await this.updatePresence(this.dynamicMarker);
		
		// Auto-clear after TTL
		this.dynamicTimeout = setTimeout(() => {
			this.clear().catch(() => {});
		}, ttl);
	}
	
	/**
	 * Clear dynamic presence, return to schedule.
	 */
	async clear() {
		if (this.dynamicTimeout) {
			clearTimeout(this.dynamicTimeout);
			this.dynamicTimeout = null;
		}
		
		this.dynamicMarker = null;
		
		// Apply current schedule marker
		const schedule = this.state.schedule.length > 0
			? this.state.schedule
			: this.generateSchedule();
		const marker = this.findMarkerForTime(schedule, this.getCurrentMinutes());
		await this.updatePresence(marker);
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
		const base = this.config.base ?? DEFAULT_BASE;
		return [...base];
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
		const activity = marker.activity ? [{ name: marker.activity, type: 0 }] : [];

		try {
			await this.client.user.setPresence({
				status,
				activities: activity,
			});

			// Also set as a fallback using setActivity
			if (marker.activity) {
				await this.client.user.setActivity(marker.activity, { type: 0 });
			}

			// Only update state for schedule markers (not dynamic)
			if (!this.dynamicMarker) {
				this.state.currentMarker = marker.name;
				this.state.currentStatus = status;
				this.state.currentActivity = marker.activity;
				await this.saveState();
			}

			await this.logger.info("presence-updated", {
				marker: marker.name ?? "dynamic",
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
		// Skip if dynamic presence is active
		if (this.dynamicMarker) return;
		
		// Refresh schedule if new day - delegate to orchestrator if available
		if (this.needsRefresh()) {
			if (this.onDayRefresh) {
				// Orchestrator handles contextual schedule generation
				await this.onDayRefresh();
			} else {
				// Fallback: use static schedule
				this.state.schedule = this.generateSchedule();
				this.state.lastRefresh = new Date().toISOString();
				await this.saveState();
				await this.logger.info("presence-schedule-refreshed");
			}
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
		if (this.dynamicTimeout) {
			clearTimeout(this.dynamicTimeout);
			this.dynamicTimeout = null;
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