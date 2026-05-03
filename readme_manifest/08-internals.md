## Implementation details

**Queueing**: Each route has a durable queue that survives daemon restarts. Work items are leased with expiration timestamps, so if the daemon crashes mid-run, abandoned work is automatically recovered and retried on the next startup.

**Journaling**: An append-only journal records all inbound messages, edits, deletions, and assistant responses for each route. This provides bounded recent context for new prompts and supports post-hoc debugging without relying on Discord message history.

**Route registry**: A central registry tracks known routes by their Discord identity (guild/channel/thread). Each route maintains its own manifest with pointers to the current session file, primary message id, and details thread id.

**Restart recovery**: On startup, the daemon iterates known routes, recovers any expired queue leases, and backfills recent channel messages into the journal as ambient context. This means the bot can pick up where it left off even after an unexpected exit.

**Thread creation**: Bot sessions can create Discord threads via the `createThread` tool. This allows the agent to spin off dedicated discussion threads for complex topics or tool output. Threads are named with a date prefix by default.

**Manifest persistence**: Route manifests are persisted after agent switches to preserve the current agent across daemon restarts.

**Detached daemon**: The Discord gateway connection runs in a separate long-lived process (`pi-discord-daemon`) rather than inside Pi's runtime. This lets the bot stay online independently of any interactive Pi session.

## Orchestrator (Ambient Interactions)

The daemon includes an optional "Slice of Bread" orchestrator that handles ambient bot interactions and character presence.

- **Ambient Posts**: Automatically triggers scenes based on RNG and cron schedules.
- **Bot Followups**: Allows bots to reply to each other in the same channel.
- **Presence Rotation**: Dynamically updates Discord status based on scheduled markers.
- **Shared Memory**: Cross-instance memory for coordinated conversations.

### Config

```json
"sliceOfBread": {
  "enabled": true,
  "channelId": "123456789",
  "primaryInstance": "arona",
  "cooldown": 3600000,
  "sharedMemoryPath": "~/.pi/agent/pi-discord-instances/shared/bread-memory.json",
  "globalTopics": ["topic1", "topic2"],
  "scenes": [
    {
      "name": "morning-greeting",
      "trigger": { "cron": "0 7 * * *" },
      "speaker": "arona",
      "prompt": "Good morning. Be brief."
    }
  ],
  "botFollowup": {
    "enabled": true,
    "cooldown": 30000,
    "maxTurns": 4,
    "responders": ["arona"],
    "chance": 0.8,
    "mentionPatterns": ["name1", "name2"],
    "promptTemplate": "Bot: {content}"
  }
}
```

### World News Enrichment

The orchestrator can fetch real-world news to give characters "ambient awareness" of events (science, tech, culture).

```json
"worldNews": {
    "enabled": true,
    "endpoint": "http://127.0.0.1:8080",
    "refreshInterval": 21600000,
    "maxItems": 5,
    "searchQuery": "interesting non-political science and tech news"
}
```

## Status

✓ Working - tested with SillyTavern and multi-bot configurations.

Completed:
- [x] Discord gateway connection with detached daemon
- [x] Slash commands and @mention ingress
- [x] Per-route sessions, memory, and journaling
- [x] Multi-instance support with auto port assignment
- [x] Agent system with mid-route switching
- [x] Tool permissions system (admin/disabled)
- [x] Slice of Bread orchestrator with world news enrichment

TODO:
- [ ] Webhook ingestion support
- [ ] launchd/systemd service generation
- [ ] Full setup wizard

## License

MIT
