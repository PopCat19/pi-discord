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
4. `pi-discord edit my-bot`, paste credentials
5. Add `systemPromptFile: "system-prompt.md"` to config and create the file
6. `pi-discord start my-bot`

**Migrating from legacy:**

```bash
pi-discord stop legacy
pi-discord migrate my-bot
rm -rf ~/.pi/agent/pi-discord
```
