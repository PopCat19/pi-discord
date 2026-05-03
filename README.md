<p>
  <img src="banner.png" alt="pi-discord" width="1100">
</p>

# pi-discord

A Discord bot that brings Pi into your server. Mention the bot or use slash commands to run Pi with full tool access, persistent sessions, and optional project extensions.

> **⚠️ Experimental: Multi-instance support**
> 
> The `pi-discord` CLI now supports multiple bot instances. This is a new feature.
> Legacy installations at `~/.pi/agent/pi-discord/` continue to work but can be migrated:
> 
> ```
> pi-discord migrate my-bot-name
> ```
> 
> New instances are stored in `~/.pi/agent/pi-discord-instances/`.

## Directory Layout

```
Source repository (your dev fork):
  ~/pi-discord-fork/           # git repo, package.json, source code

Instance directories (runtime data):
  ~/.pi/agent/pi-discord-instances/
    ├── plana/workspace/        # config.json, system-prompt.md, routes/, sessions/
    └── arona/workspace/        # another bot instance

Legacy (pre-multi-instance):
  ~/.pi/agent/pi-discord/      # still works, shown as "(legacy)" in CLI
```

When you `pi install git:github.com/PopCat19/pi-discord`, pi clones the source repo.
The `pi-discord` CLI creates instance directories at runtime.

**How it works:** A detached daemon listens for Discord mentions, DMs, and slash commands. Each channel gets its own persistent Pi session, so follow-up questions remember earlier conversation. When a message comes in, the daemon calls `session.prompt()`, subscribes to the response stream, and live-updates the Discord reply as text streams back. Operator runs `/discord start|stop|status` from Pi to control it.

Requires a bot token and application id from the Discord Developer Portal.

```text
/discord setup
/discord start

# In Discord
/pi ask text:"Summarize the errors in the latest deploy"
@your-bot check the logs and tell me what failed
```

<img src="discord-chat.png" alt="Discord chat example" width="500">

## What it does

- `/discord` commands in Pi for setup, start, stop, status, logs, config
- detached daemon that stays connected to Discord independently of Pi
- durable per-route state: registry, queue, journal, sessions, memory
- routing scoped to channel or thread by Discord ids
- headless Pi sessions via `createAgentSession()`
- slash commands and @mention ingress
- `discord_upload` tool for posting files back to Discord
- `discord_react` tool for adding emoji reactions to messages
- emoji reaction awareness — user reactions appear as passive context on the bot's next turn
- throttled message updates with details-thread fallback
- DM allowlisting and admin controls for stop/reset

## Install

```bash
pi install git:github.com/PopCat19/pi-discord
```

Or the upstream:

```bash
pi install npm:pi-discord
```

Then restart Pi so it discovers the extension.

## Multi-instance CLI

> **Experimental** - New feature, see notice above.

The `pi-discord` CLI manages multiple bot instances:

```
pi-discord create <name> [--needed]  Create new instance
pi-discord list                 List all instances
pi-discord start <name...>     Start one or more instances
pi-discord stop <name...>      Stop one or more instances
pi-discord restart <name...>   Restart one or more instances
pi-discord status [name]       Show instance status
pi-discord edit <name>         Open config in $EDITOR
pi-discord remove <name>       Delete an instance
pi-discord migrate <name>      Migrate legacy instance
pi-discord sync-commands <name> Sync slash commands
pi-discord trigger <name> <scene> Trigger a scene manually
pi-discord routes <name> [days] List/wipe stale routes
pi-discord backup <name> [route?] Backup route memory (admin)
pi-discord scrub <name> [route?] Scrub route memory (admin)
pi-discord halt <name>         Stop all runs and clear queue (admin)
```

**Instance storage:**
- New instances: `~/.pi/agent/pi-discord-instances/<name>/workspace/`
- Legacy: `~/.pi/agent/pi-discord/` (detected automatically)

**Creating a new bot:**

1. Create Discord application at https://discord.com/developers/applications
2. Copy bot token and application ID
3. `pi-discord create my-bot`
4. `pi-discord edit my-bot` — paste credentials
5. Add `systemPromptFile: "system-prompt.md"` to config and create the file
6. `pi-discord start my-bot`

**Migrating from legacy:**

```bash
pi-discord stop legacy
pi-discord migrate my-bot
rm -rf ~/.pi/agent/pi-discord
```

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

## Config reference

The runtime config lives at:

`~/.pi/agent/pi-discord/config.json`

Current fields:

- `botToken`: Discord bot token from the Bot page
- `applicationId`: Discord application id from General Information
- `allowedGuildIds`: optional guild allowlist. Empty means any guild the bot joins is accepted
- `adminUserIds`: Discord user ids allowed to stop active runs and reset routes
- `dmAllowlistUserIds`: Discord user ids allowed to use the bot in DMs
- `commandName`: slash-command root. Defaults to `pi`, which creates `/pi ask`, `/pi status`, `/pi stop`, and `/pi reset`
- `registerCommandsGlobally`: if `true`, registers commands globally instead of guild-scoped
- `syncCommandsOnStart`: if `true`, `/discord start` syncs slash commands before starting the daemon
- `workspaceMode`: `dedicated` or `shared`
- `sharedExecutionRoot`: execution root to use when `workspaceMode` is `shared`
- `routeOverrides`: per-route overrides for execution root or workspace mode
- `allowProjectExtensions`: if `true`, bot sessions load discovered extensions in addition to the built-in helper extension. This is less safe in headless mode
- `disabledExtensions`: array of extension names to exclude (e.g. `["pi-lsp-extension"]`)
- `showThinkingStatus`: if `false`, skips "Thinking..." status message, relies on typing indicator only (default: true)
- `enableImageInput`: if `false`, image attachments stay on disk and are described in text instead of being sent as model image input
- `enableDetailsThreads`: if `true`, the daemon will try to open and reuse a details thread for tool chatter and uploads
- `globalConcurrency`: max routes processed at once
- `queueLeaseMs`: queue lease duration before abandoned work is recovered
- `primaryFlushMs`: cadence for throttled primary-message edits while the assistant is streaming
- `defaultModel`: optional `provider/model-id` for new routes
- `defaultThinkingLevel`: Pi thinking level for new routes
- `systemPrompt`: optional system prompt override for routes without a specified agent
- `systemPromptFile`: path to system prompt file (relative to config directory). Contents loaded at startup, overrides `systemPrompt`. Useful for long prompts.
- `useThreadPersona`: if `true`, discard default Pi persona and let thread history define the persona for Pi tasks (git status, etc.)
- `toolPermissions`: tool access control configuration
  - `adminOnly`: array of tool names restricted to admin users (default: `["bash", "edit", "write"]`)
  - `disabled`: array of tool names disabled for all users (default: `[]`)
- `agents`: map of agent name to agent definition (see Agent System below)
- `defaultAgent`: name of the default agent to use. Defaults to `"default"`
- `sliceOfLife`: optional slice-of-life orchestrator config for ambient bot interactions (see Slice of Life below)
- `routeCleanup`: auto-cleanup config for stale routes
- `presence`: presence manager config for scheduled status changes
- `botFollowup`: config for bot-to-bot followup messages
- `processOfflineMentions`: if `true`, bot processes the most recent missed mention on startup (default: true)

## Agent system

Multiple agents can be defined in config, each with their own system prompt, model, and thinking level. This enables switching personalities or capabilities mid-route.

**Agent config structure:**

```json
{
  "agents": {
    "assistant": {
      "systemPrompt": "You are a helpful assistant.",
      "defaultModel": "openai/gpt-4o",
      "defaultThinkingLevel": "medium"
    },
    "code-reviewer": {
      "systemPrompt": "You are a strict code reviewer. Be concise and thorough.",
      "defaultModel": "anthropic/claude-sonnet-4",
      "defaultThinkingLevel": "high"
    }
  },
  "defaultAgent": "assistant"
}
```

**Agent fields:**

- `systemPrompt` (required): The system prompt for that agent
- `defaultModel` (optional): Model override for this agent
- `defaultThinkingLevel` (optional): Thinking level for this agent

**Switching agents:**

The bot session exposes a `setAgent` tool that allows switching agents during a conversation. The current agent is persisted in the route manifest and survives restarts.

**Fallback behavior:**

If no agent is specified or `defaultAgent` is not configured, routes use the top-level `systemPrompt` and `defaultModel` from config for backward compatibility.

## How routing works

A route is keyed by Discord identity, not by an arbitrary chat title. The route key is built from:

- guild id or `dm`
- channel id
- optional thread id

Each route owns:

- a route manifest
- a durable queue
- an append-only transport journal
- a compressing memory file (routes older than 8192 tokens are summarized)
- a session storage directory
- inbound and outbound attachment folders
- an execution root

### Route memory

Routes use a compressing memory system that automatically summarizes old conversations:

- **Recent entries**: Full conversation turns (limited by token count)
- **Compressed entries**: Summaries of older conversations
- **Auto-rotation**: When memory exceeds 8192 tokens, oldest conversations are compressed

**`/pi wipe`** clears the entire memory, including summaries. **`/pi reset`** only ends the current session while preserving memory.

### Stale route cleanup

```bash
pi-discord routes plana           # List all routes
pi-discord routes plana 30        # Wipe routes older than 30 days
pi-discord routes plana all       # Wipe all routes
```

Or enable auto-cleanup in config:

```json
"routeCleanup": {
  "enabled": true,
  "maxAgeDays": 30,
  "onStartup": true
}
```

## Session behavior

Bot sessions are created with the Pi SDK, not with a separate custom context store. The daemon uses `createAgentSession()` and binds a small helper extension so it can:

- inject route memory and bounded recent Discord context at request time
- expose a `discord_upload` tool for explicit file egress back into Discord
- expose a `discord_react` tool for adding emoji reactions to the triggering message
- keep the session headless-safe by avoiding interactive UI assumptions

Raw Discord text is sent through `session.prompt(..., { expandPromptTemplates: false, source: "extension" })` so normal Discord content beginning with `/` stays literal unless it came from an explicit Discord slash command.

## Attachments and images

Inbound attachments are downloaded into the route workspace before the run starts.

If an attachment is an image and the selected model supports image input, the daemon passes it through as Pi image content. Otherwise the saved file path is still included in the prompt context so the model can reason about the file as a normal artifact.

For outbound files, the bot session can use the `discord_upload` tool to post a generated file back into the current Discord surface or details thread.

## Safety model

DMs are deny-by-default and only open to ids listed in `dmAllowlistUserIds`.

Stop and reset controls are restricted to ids listed in `adminUserIds`.

**Tool permissions** restrict dangerous operations:

- `toolPermissions.adminOnly`: Tools only usable by admins (default: `bash`, `edit`, `write`)
- `toolPermissions.disabled`: Tools disabled for all users

Non-admin users in allowlisted guilds can use the bot but cannot execute admin-restricted tools. When they attempt to use one, they receive a clear message:

> Tool 'bash' is restricted to server admins only. Ask a server admin to perform this action.

**Role mentions**: Role mentions trigger bot responses when the bot has that role assigned. The bot checks `message.mentions.roles` for roles it possesses, enabling team-based access patterns.

**Followup detection**: After slash commands or mentions, the bot creates a context window where followup messages from the same user are automatically enqueued.

Project extensions are off by default in bot sessions because many extensions assume an interactive TUI and human supervision.

The package stores route state separately from the extension package so updates or reinstalls do not trample mutable bot data.

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

<!-- generated: 20260503-9359e28 -->
