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
