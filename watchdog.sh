#!/usr/bin/env bash
# Watchdog for pi-discord instances
# Usage: ./watchdog.sh [--once]
#   --once: Check once and exit (for cron)
#   No args: Run as daemon (for systemd)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_DISCORD="$SCRIPT_DIR/pi-discord.mjs"
PID_DIR="/run/user/$(id -u)/pi-discord"
LOG_DIR="$HOME/.pi/agent/pi-discord-instances"

# Instances to watch
INSTANCES=("arona" "plana" "arisu" "kei")

# Cooldown between restart attempts (seconds)
RESTART_COOLDOWN=30
MAX_RESTARTS=5
RESTART_WINDOW=300

mkdir -p "$PID_DIR"

log() {
	echo "[$(date -Iseconds)] $1"
}

get_pid() {
	local instance="$1"
	local pid_file="$PID_DIR/$instance.pid"
	if [ -f "$pid_file" ]; then
		local pid=$(cat "$pid_file" 2>/dev/null)
		if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
			echo "$pid"
			return 0
		fi
	fi
	echo ""
	return 1
}

is_running() {
	local instance="$1"
	local pid=$(get_pid "$instance")
	[ -n "$pid" ]
}

get_restart_count() {
	local instance="$1"
	local count_file="$PID_DIR/$instance.restarts"
	local count=0
	local now=$(date +%s)
	
	if [ -f "$count_file" ]; then
		while IFS=' ' read -r ts; do
			if [ $((now - ts)) -lt $RESTART_WINDOW ]; then
				((count++))
			fi
		done < "$count_file" 2>/dev/null || true
	fi
	echo $count
}

record_restart() {
	local instance="$1"
	local count_file="$PID_DIR/$instance.restarts"
	local now=$(date +%s)
	
	# Append timestamp and prune old entries
	echo "$now" >> "$count_file"
	
	# Keep only recent timestamps
	local tmp=$(mktemp)
	while IFS=' ' read -r ts; do
		if [ $((now - ts)) -lt $RESTART_WINDOW ]; then
			echo "$ts" >> "$tmp"
		fi
	done < "$count_file" 2>/dev/null || true
	mv "$tmp" "$count_file"
}

start_instance() {
	local instance="$1"
	
	# Check restart limit
	local restarts=$(get_restart_count "$instance")
	if [ "$restarts" -ge $MAX_RESTARTS ]; then
		log "ERROR: $instance exceeded max restarts ($MAX_RESTARTS in ${RESTART_WINDOW}s)"
		return 1
	fi
	
	log "Starting $instance..."
	
	# Start in background
	local log_file="$LOG_DIR/$instance/workspace/logs/watchdog.log"
	nohup node "$PI_DISCORD" start "$instance" >> "$log_file" 2>&1 &
	local pid=$!
	
	# Wait for startup
	sleep 2
	
	# Verify started
	if kill -0 $pid 2>/dev/null; then
		echo $pid > "$PID_DIR/$instance.pid"
		record_restart "$instance"
		log "Started $instance (pid: $pid, restart #$((restarts + 1)))"
		return 0
	else
		log "ERROR: Failed to start $instance"
		return 1
	fi
}

stop_instance() {
	local instance="$1"
	local pid=$(get_pid "$instance")
	
	if [ -n "$pid" ]; then
		log "Stopping $instance (pid: $pid)..."
		kill "$pid" 2>/dev/null || true
		
		# Wait for graceful shutdown
		local timeout=10
		while [ $timeout -gt 0 ] && kill -0 "$pid" 2>/dev/null; do
			sleep 1
			((timeout--))
		done
		
		# Force kill if still running
		if kill -0 "$pid" 2>/dev/null; then
			kill -9 "$pid" 2>/dev/null || true
		fi
		
		rm -f "$PID_DIR/$instance.pid"
	fi
}

check_and_restart() {
	local instance="$1"
	
	if is_running "$instance"; then
		return 0
	fi
	
	log "Instance $instance is down, restarting..."
	
	# Try graceful start via CLI first
	node "$PI_DISCORD" stop "$instance" 2>/dev/null || true
	sleep 1
	
	# Start the instance
	node "$PI_DISCORD" start "$instance" 2>&1 | while read -r line; do
		log "[$instance] $line"
	done &
	
	# Give it time to start
	sleep 5
	
	# Verify it's running
	if is_running "$instance"; then
		log "Instance $instance restarted successfully"
		return 0
	fi
	
	log "ERROR: Failed to restart $instance"
	return 1
}

# Main loop
watchdog_daemon() {
	log "Watchdog started"
	
	while true; do
		for instance in "${INSTANCES[@]}"; do
			check_and_restart "$instance"
		done
		sleep 10
	done
}

watchdog_once() {
	for instance in "${INSTANCES[@]}"; do
		if ! is_running "$instance"; then
			log "Instance $instance is down, restarting..."
			node "$PI_DISCORD" start "$instance" >/dev/null 2>&1 &
		fi
	done
}

case "${1:-}" in
	--once)
		watchdog_once
		;;
	start)
		watchdog_daemon
		;;
	stop)
		for instance in "${INSTANCES[@]}"; do
			stop_instance "$instance"
		done
		log "Watchdog stopped"
		;;
	status)
		for instance in "${INSTANCES[@]}"; do
			if is_running "$instance"; then
				local pid=$(get_pid "$instance")
				echo "$instance: running (pid: $pid)"
			else
				echo "$instance: stopped"
			fi
		done
		;;
	*)
		echo "Usage: $0 {start|stop|status|--once}"
		echo "  start   - Run as daemon"
		echo "  stop    - Stop all instances"
		echo "  status  - Show instance status"
		echo "  --once  - Check once (for cron)"
		exit 1
		;;
esac