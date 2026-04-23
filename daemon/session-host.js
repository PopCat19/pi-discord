import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { buildInjectedContext } from "./prompt-shaper.js";
import { createHeadlessUi } from "./headless-ui.js";
import { createRouteSessionExtension } from "./session-extension.js";
import { pathExists } from "../lib/fs.js";

export class RouteSessionHost {
  /**
   * @param {{
   *   agentDir: string,
   *   config: import('../lib/config.js').PiDiscordConfig,
   *   manifest: import('./registry.js').RouteManifest,
   *   routePaths: ReturnType<import('../lib/paths.js').getRoutePaths>,
   *   journal: import('./journal.js').JournalStore,
   *   logger: import('./logger.js').Logger,
   *   uploadFile: (filePath: string, options?: { title?: string }) => Promise<{ messageId: string, url?: string }>,
   *   addReaction: (emoji: string) => Promise<void>,
   *   createThread: (name: string, options?: { message?: string }) => Promise<{ threadId: string, threadUrl: string }>,
   *   persistManifest: () => Promise<void>
   * }} options
   */
  constructor(options) {
    this.agentDir = options.agentDir;
    this.config = options.config;
    this.manifest = options.manifest;
    this.routePaths = options.routePaths;
    this.journal = options.journal;
    this.logger = options.logger;
    this.uploadFile = options.uploadFile;
    this.addReaction = options.addReaction;
    this.createThread = options.createThread;
    this.persistManifest = options.persistManifest;
    this.currentSourceId = undefined;
    this.session = undefined;
    this.sessionPromise = undefined;
    // Dynamic permission state, updated per-request
    this.currentIsAdmin = false;
    this.currentToolPermissions = { adminOnly: ["bash", "edit", "write"], disabled: [] };
  }

  async ensureSession() {
    if (this.session) return this.session;
    if (!this.sessionPromise) {
      this.sessionPromise = this.createSession()
        .then(async (session) => {
          this.session = session;
          this.manifest.sessionFile = session.sessionFile;
          await this.logger.info("route-session-ready", {
            routeKey: this.manifest.routeKey,
            sessionFile: session.sessionFile,
            executionRoot: this.manifest.executionRoot,
            memoryPath: this.manifest.memoryPath,
          });
          return session;
        })
        .finally(() => {
          this.sessionPromise = undefined;
        });
    }
    return this.sessionPromise;
  }

  async createSession() {
    const authStorage = AuthStorage.create(`${this.agentDir}/auth.json`);
    const modelRegistry = await ModelRegistry.create(authStorage, `${this.agentDir}/models.json`);
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: true, maxRetries: 2 },
      images: { blockImages: !this.config.enableImageInput },
    });

    // Resolve agent-specific settings
    const agentName = this.manifest.currentAgent ?? this.config.defaultAgent;
    const agent = agentName && this.config.agents?.[agentName];
    
    // Skip default persona if useThreadPersona is enabled
    // This allows the thread history to define the persona for Pi tasks
    const systemPrompt = this.config.useThreadPersona
      ? undefined
      : (agent?.systemPrompt ?? this.config.systemPrompt);
    
    const agentModel = agent?.defaultModel ?? this.config.defaultModel;
    const agentThinkingLevel = agent?.defaultThinkingLevel ?? this.config.defaultThinkingLevel;

    const resourceLoader = new DefaultResourceLoader({
      cwd: this.manifest.executionRoot,
      agentDir: this.agentDir,
      settingsManager,
      noExtensions: !this.config.allowProjectExtensions,
      noPromptTemplates: true,
      noThemes: true,
      systemPrompt,
      extensionFactories: [
        createRouteSessionExtension({
          getInjectedContext: () => buildInjectedContext({
            memoryPath: this.manifest.memoryPath,
            journal: this.journal,
            excludeSourceId: this.currentSourceId,
          }),
          uploadFile: this.uploadFile,
          addReaction: (emoji) => this.addReaction(emoji),
          createThread: (name, opts) => this.createThread(name, opts),
          setAgent: (agentName) => this.setAgent(agentName),
          getIsAdmin: () => this.currentIsAdmin,
          getToolPermissions: () => this.currentToolPermissions,
        }),
      ],
    });
    await resourceLoader.reload();

    const sessionManager = (this.manifest.sessionFile && await pathExists(this.manifest.sessionFile))
      ? SessionManager.open(this.manifest.sessionFile)
      : SessionManager.create(this.manifest.executionRoot, this.routePaths.sessionsDir);

    let model;
    if (agentModel) {
      const [provider, ...rest] = agentModel.split("/");
      if (provider && rest.length > 0) {
        model = modelRegistry.find(provider, rest.join("/"));
      }
    }

    const { session } = await createAgentSession({
      cwd: this.manifest.executionRoot,
      agentDir: this.agentDir,
      authStorage,
      modelRegistry,
      sessionManager,
      settingsManager,
      resourceLoader,
      model,
      thinkingLevel: agentThinkingLevel,
    });

    await session.bindExtensions({
      uiContext: createHeadlessUi(),
      commandContextActions: {
        waitForIdle: async () => undefined,
        newSession: async () => ({ cancelled: true }),
        fork: async () => ({ cancelled: true }),
        navigateTree: async () => ({ cancelled: true }),
        switchSession: async () => ({ cancelled: true }),
        reload: async () => undefined,
      },
      onError: (error) => {
        void this.logger.error("route-session-extension-error", error);
      },
    });

    return session;
  }

  async setAgent(agentName) {
    if (!this.config.agents?.[agentName]) {
      throw new Error(`Unknown agent: ${agentName}. Available agents: ${Object.keys(this.config.agents || {}).join(', ') || 'none'}`);
    }
    this.manifest.currentAgent = agentName;
    if (this.persistManifest) await this.persistManifest();
    await this.dispose();
    return { agent: agentName };
  }

  async dispose() {
    this.currentSourceId = undefined;
    const session = this.session ?? await this.sessionPromise?.catch(() => undefined);
    if (!session) return;
    session.dispose();
    if (this.session === session) {
      this.session = undefined;
    }
  }
}