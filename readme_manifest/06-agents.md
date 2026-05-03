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
