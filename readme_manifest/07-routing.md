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
