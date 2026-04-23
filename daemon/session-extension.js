import { Type } from "@sinclair/typebox";

/**
 * @param {{
 *   getInjectedContext: () => Promise<string>,
 *   uploadFile: (filePath: string, options?: { title?: string }) => Promise<{ messageId: string, url?: string }>,
 *   addReaction: (emoji: string) => Promise<void>,
 *   getIsAdmin: () => boolean,
 *   getToolPermissions: () => { adminOnly: string[], disabled: string[] }
 * }} runtime
 */
export function createRouteSessionExtension(runtime) {
  return (pi) => {
    // Intercept tool calls to enforce permissions
    pi.on("tool_call", async (event) => {
      const toolPermissions = runtime.getToolPermissions?.() ?? { adminOnly: ["bash", "edit", "write"], disabled: [] };
      const adminOnly = toolPermissions.adminOnly ?? [];
      const disabled = toolPermissions.disabled ?? [];
      const isAdmin = runtime.getIsAdmin?.() ?? false;
      
      if (disabled.includes(event.toolName)) {
        return {
          content: [{ type: "text", text: `Tool '${event.toolName}' is disabled and cannot be used.` }],
          isError: true,
        };
      }
      if (adminOnly.includes(event.toolName) && !isAdmin) {
        return {
          content: [{ type: "text", text: `Tool '${event.toolName}' is restricted to server admins only. Ask a server admin to perform this action.` }],
          isError: true,
        };
      }
      // Return undefined to let the tool execute normally
      return undefined;
    });

    pi.on("context", async (event) => {
      const injectedText = await runtime.getInjectedContext();
      if (!injectedText.trim()) return undefined;
      return {
        messages: [
          {
            role: "user",
            content: `Discord route context:\n\n${injectedText}`,
            timestamp: Date.now(),
          },
          ...event.messages,
        ],
      };
    });

    pi.registerTool({
      name: "discord_upload",
      label: "Discord Upload",
      description: "Upload a local file to the active Discord route surface.",
      promptSnippet: "Upload route artifacts back to Discord when the user asked for a file.",
      promptGuidelines: [
        "Use this tool instead of assuming local files are automatically sent to Discord.",
      ],
      parameters: Type.Object({
        path: Type.String({ description: "Local file path to upload" }),
        title: Type.Optional(Type.String({ description: "Optional message title" })),
      }),
      async execute(_toolCallId, params) {
        const result = await runtime.uploadFile(params.path, { title: params.title });
        return {
          content: [{ type: "text", text: `Uploaded ${params.path} to Discord.` }],
          details: result,
        };
      },
    });

    pi.registerTool({
      name: "discord_react",
      label: "React",
      description: "Add an emoji reaction to the message you're responding to.",
      promptSnippet: "React to messages with emoji when it feels natural.",
      parameters: Type.Object({
        emoji: Type.String({ description: "Emoji to react with (e.g. 🔥, 👍, 😂, or custom name:id / <:name:id>)" }),
      }),
      async execute(_toolCallId, params) {
        await runtime.addReaction(params.emoji);
        return {
          content: [{ type: "text", text: `Reacted with ${params.emoji}` }],
        };
      },
    });
  };
}