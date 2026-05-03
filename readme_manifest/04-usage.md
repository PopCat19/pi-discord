## Quick start

Inside Pi:

```text
/discord setup
/discord start
/discord status
```

That writes the runtime config, optionally syncs Discord slash commands, and launches the detached daemon.

Once the bot is in your server, you can talk to it with either:

```text
/pi ask text:"Check the repo status and summarize"
```

or a direct mention:

```text
@your-bot inspect the latest error screenshot
```

Role mentions also work:

```text
@AdminRole check the logs
```

To stop the helper process:

```text
/discord stop
```

To inspect logs:

```text
/discord logs 120
```

## Discord commands and triggers

Inside Discord, the package currently supports these slash subcommands under whatever `commandName` is configured:

- `/<command> ask text:"..."` - Send a prompt (ephemeral feedback)
- `/<command> status` - Show route queue status
- `/<command> stop` - Stop the active route run
- `/<command> reset` - Reset the current route session
- `/<command> wipe` - Full wipe: session + journal + memory
- `/<command> backup` - Backup route memory to file (admin only)
- `/<command> scrub` - Clear memory, optionally backup first (admin only)
- `/<command> regen` - Regenerate the last bot response (or generate for missed mention)
- `/<command> halt` - Stop all running/queued items (admin only)
- `/<command> routes [wipe]` - List routes or wipe stale ones (admin only)

In addition, a direct mention (user or role) in a guild channel or a DM from an allowlisted user will enqueue work for the current route. Role mentions require the bot to have the role assigned; the bot checks `message.mentions.roles` for roles it possesses.

Once a route already exists, follow-up messages from users who recently interacted with the bot (including via slash commands) are also enqueued. Other guild messages in that same surface are journaled as ambient context instead of immediately triggering the agent.

### Multi-bot behavior

When multiple bot instances share a channel:

- **Direct mentions**: Only the mentioned bot responds
- **Other bot messages**: Each bot journals other bots' messages as ambient context for cross-bot awareness
- **Followup detection**: Only the bot that was last mentioned/responded treats subsequent messages as followups
- **Ambient context**: All bots see each other's responses, enabling them to reference earlier conversations

This allows characters to maintain awareness of conversations they weren't directly involved in, while ensuring only the relevant bot responds to followups.

## Pi operator commands

Inside Pi, the extension exposes:

- `/discord setup`
- `/discord open-config`
- `/discord sync-commands`
- `/discord start`
- `/discord stop`
- `/discord status`
- `/discord logs [lines]`
- `/discord help`
