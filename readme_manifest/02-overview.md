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
