import { join } from "node:path";
import { Agent, type AgentMessage, type ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Message, Model } from "@mariozechner/pi-ai";
import { getAgentDir, getDocsPath } from "../config.js";
import { createAskUserTool } from "./ask-user-tool.js";
import { AgentSession } from "./agent-session.js";
import { AuthStorage } from "./auth-storage.js";
import { DEFAULT_THINKING_LEVEL } from "./defaults.js";
import type { ExtensionRunner, LoadExtensionsResult, ToolDefinition } from "./extensions/index.js";
import { convertToLlm } from "./messages.js";
import { ModelRegistry } from "./model-registry.js";
import { findInitialModel } from "./model-resolver.js";
import type { ResourceLoader } from "./resource-loader.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";
import { loadCustomSubagents, resolveCustomSubagentReference } from "./subagents.js";
import { time } from "./timings.js";
import { patchAgentForParallelTaskExecution } from "./parallel-task-agent.js";
import {
	allTools,
	bashTool,
	codingTools,
	createBashTool,
	createCodingTools,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadOnlyTools,
	createReadTool,
	createTaskTool,
	createToolsFromNames,
	createWriteTool,
	editTool,
	findTool,
	grepTool,
	lsTool,
	readOnlyTools,
	readTool,
	todoReadTool,
	todoWriteTool,
	type TaskToolProgress,
	type TaskToolProgressPhase,
	type Tool,
	type ToolName,
	writeTool,
} from "./tools/index.js";
import { getAgentProfile, type AgentProfileName } from "./agent-profiles.js";

export interface CreateAgentSessionOptions {
	/** Working directory for project-local discovery. Default: process.cwd() */
	cwd?: string;
	/** Global config directory. Default: ~/.iosm/agent */
	agentDir?: string;

	/** Auth storage for credentials. Default: AuthStorage.create(agentDir/auth.json) */
	authStorage?: AuthStorage;
	/** Model registry. Default: new ModelRegistry(authStorage, agentDir/models.json) */
	modelRegistry?: ModelRegistry;

	/** Model to use. Default: from settings, else first available */
	model?: Model<any>;
	/** Require explicit model selection by the user; disables automatic model fallback/selection for new sessions. */
	requireExplicitModelSelection?: boolean;
	/** Thinking level. Default: from settings, else 'medium' (clamped to model capabilities) */
	thinkingLevel?: ThinkingLevel;
	/** Models available for cycling (Ctrl+P in interactive mode) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	/** Built-in tools to use. Default: codingTools [read, bash, edit, write] */
	tools?: Tool[];
	/** Custom tools to register (in addition to built-in tools). */
	customTools?: ToolDefinition[];
	/** Enable the interactive ask_user clarification tool. Best used in interactive or RPC sessions. */
	enableAskUserTool?: boolean;

	/** Resource loader. When omitted, DefaultResourceLoader is used. */
	resourceLoader?: ResourceLoader;

	/** Session manager. Default: SessionManager.create(cwd) */
	sessionManager?: SessionManager;

	/** Settings manager. Default: SettingsManager.create(cwd, agentDir) */
	settingsManager?: SettingsManager;

	/**
	 * Agent profile name. Overrides tools and thinkingLevel with profile defaults.
	 * Profiles: explore, plan, iosm_analyst, iosm_verifier, cycle_planner, full (default).
	 */
	profile?: AgentProfileName | string;

	/**
	 * Whether to register the Task tool (subagent spawning).
	 * Default: true for interactive/print sessions; false for subagent sessions to avoid recursion.
	 */
	enableTaskTool?: boolean;
}

/** Result from createAgentSession */
export interface CreateAgentSessionResult {
	/** The created session */
	session: AgentSession;
	/** Extensions result (for UI context setup in interactive mode) */
	extensionsResult: LoadExtensionsResult;
	/** Warning if session was restored with a different model than saved */
	modelFallbackMessage?: string;
}

// Re-exports

export type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	SlashCommandInfo,
	SlashCommandLocation,
	SlashCommandSource,
	ToolDefinition,
} from "./extensions/index.js";
export type { PromptTemplate } from "./prompt-templates.js";
export type { Skill } from "./skills.js";
export type { Tool } from "./tools/index.js";

export {
	createAskUserTool,
	// Pre-built tools (use process.cwd())
	readTool,
	bashTool,
	editTool,
	writeTool,
	grepTool,
	findTool,
	lsTool,
	codingTools,
	readOnlyTools,
	allTools as allBuiltInTools,
	// Tool factories (for custom cwd)
	createCodingTools,
	createReadOnlyTools,
	createReadTool,
	createBashTool,
	createEditTool,
	createWriteTool,
	createGrepTool,
	createFindTool,
	createLsTool,
};

// Helper Functions

function getDefaultAgentDir(): string {
	return getAgentDir();
}

function resolveModelBySpecifier(
	modelRegistry: ModelRegistry,
	specifier: string,
	preferredProvider?: string,
): Model<any> | undefined {
	const raw = specifier.trim();
	if (!raw) return undefined;
	const slash = raw.indexOf("/");
	if (slash > 0 && slash < raw.length - 1) {
		const provider = raw.slice(0, slash);
		const modelId = raw.slice(slash + 1);
		return modelRegistry.find(provider, modelId);
	}

	const all = modelRegistry.getAll().filter((candidate) => candidate.id === raw);
	if (all.length === 0) return undefined;
	if (preferredProvider) {
		const preferred = all.find((candidate) => candidate.provider === preferredProvider);
		if (preferred) return preferred;
	}
	return all[0];
}

/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model
 * import { getModel } from '@mariozechner/pi-ai';
 * const { session } = await createAgentSession({
 *   model: getModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // Continue previous session
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // Full control
 * const loader = new DefaultResourceLoader({
 *   cwd: process.cwd(),
 *   agentDir: getAgentDir(),
 *   settingsManager: SettingsManager.create(),
 * });
 * await loader.reload();
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   tools: [readTool, bashTool],
 *   resourceLoader: loader,
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	const cwd = options.cwd ?? process.cwd();
	const agentDir = options.agentDir ?? getDefaultAgentDir();
	const contextProfile = options.profile?.toString().toLowerCase() === "iosm" ? "iosm" : "standard";
	let resourceLoader = options.resourceLoader;

	// Use provided or create AuthStorage and ModelRegistry
	const authPath = options.agentDir ? join(agentDir, "auth.json") : undefined;
	const modelsPath = options.agentDir ? join(agentDir, "models.json") : undefined;
	const authStorage = options.authStorage ?? AuthStorage.create(authPath);
	const modelRegistry = options.modelRegistry ?? new ModelRegistry(authStorage, modelsPath);

	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const sessionManager = options.sessionManager ?? SessionManager.create(cwd);

	if (!resourceLoader) {
		resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, contextProfile });
		await resourceLoader.reload();
		time("resourceLoader.reload");
	}

	// Check if session has existing data to restore
	const existingSession = sessionManager.buildSessionContext();
	const hasExistingSession = existingSession.messages.length > 0;
	const hasThinkingEntry = sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change");

	let model = options.model;
	let modelFallbackMessage: string | undefined;
	const requireExplicitModelSelection = options.requireExplicitModelSelection === true;

	// If session has data, try to restore model from it
	if (!model && hasExistingSession && existingSession.model) {
		const restoredModel = modelRegistry.find(existingSession.model.provider, existingSession.model.modelId);
		if (restoredModel && (await modelRegistry.getApiKey(restoredModel))) {
			model = restoredModel;
		}
		if (!model) {
			modelFallbackMessage = `Could not restore model ${existingSession.model.provider}/${existingSession.model.modelId}`;
		}
	}

	// If still no model, use findInitialModel unless explicit selection is required.
	if (!model && !requireExplicitModelSelection) {
		const result = await findInitialModel({
			scopedModels: options.scopedModels ?? [],
			isContinuing: hasExistingSession,
			defaultProvider: settingsManager.getDefaultProvider(),
			defaultModelId: settingsManager.getDefaultModel(),
			defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
			modelRegistry,
		});
		model = result.model;
		if (!model) {
			modelFallbackMessage = `No models available. Use /login or set an API key environment variable. See ${join(getDocsPath(), "providers.md")}. Then use /model to select a model.`;
		} else if (modelFallbackMessage) {
			modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
		}
	} else if (!model && requireExplicitModelSelection && !hasExistingSession) {
		modelFallbackMessage = "No model selected. Choose one with /model or pass --provider and --model.";
	}

	let thinkingLevel = options.thinkingLevel;

	// If session has data, restore thinking level from it
	if (thinkingLevel === undefined && hasExistingSession) {
		thinkingLevel = hasThinkingEntry
			? (existingSession.thinkingLevel as ThinkingLevel)
			: (settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
	}

	// Fall back to settings default
	if (thinkingLevel === undefined) {
		thinkingLevel = settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
	}

	// Clamp to model capabilities
	if (!model || !model.reasoning) {
		thinkingLevel = "off";
	}

	// Apply agent profile: overrides tools + thinkingLevel unless caller provided them explicitly
	const profile = options.profile ? getAgentProfile(options.profile) : undefined;
	if (profile && profile.name !== "full") {
		// Profile overrides thinking level only when caller did not explicitly pass one
		if (options.thinkingLevel === undefined && !hasExistingSession) {
			thinkingLevel = profile.thinkingLevel;
			// Re-clamp to model capabilities
			if (!model || !model.reasoning) {
				thinkingLevel = "off";
			}
		}
	}

	const enableTaskTool = options.enableTaskTool !== false; // default true
	const defaultActiveToolNames: string[] = [
		"read",
		"bash",
		"edit",
		"write",
		...(enableTaskTool ? ["task"] : []),
		"todo_write",
		"todo_read",
	];
	const profileToolNames: string[] = profile
		? [...profile.tools, ...(enableTaskTool ? ["task"] : []), "todo_write", "todo_read"].filter(
				(n) => n === "task" || n in allTools,
			)
		: defaultActiveToolNames;

	const initialActiveToolNames: string[] = options.tools
		? options.tools.map((t) => t.name).filter((n) => n === "task" || n in allTools)
		: profileToolNames;

	let agent: Agent;

	// Create convertToLlm wrapper that filters images if blockImages is enabled (defense-in-depth)
	const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
		const converted = convertToLlm(messages);
		// Check setting dynamically so mid-session changes take effect
		if (!settingsManager.getBlockImages()) {
			return converted;
		}
		// Filter out ImageContent from all messages, replacing with text placeholder
		return converted.map((msg) => {
			if (msg.role === "user" || msg.role === "toolResult") {
				const content = msg.content;
				if (Array.isArray(content)) {
					const hasImages = content.some((c) => c.type === "image");
					if (hasImages) {
						const filteredContent = content
							.map((c) =>
								c.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : c,
							)
							.filter(
								(c, i, arr) =>
									// Dedupe consecutive "Image reading is disabled." texts
									!(
										c.type === "text" &&
										c.text === "Image reading is disabled." &&
										i > 0 &&
										arr[i - 1].type === "text" &&
										(arr[i - 1] as { type: "text"; text: string }).text === "Image reading is disabled."
									),
							);
						return { ...msg, content: filteredContent };
					}
				}
			}
			return msg;
		});
	};

	const extensionRunnerRef: { current?: ExtensionRunner } = {};

	agent = new Agent({
		initialState: {
			systemPrompt: "",
			model,
			thinkingLevel,
			tools: [],
		},
		convertToLlm: convertToLlmWithBlockImages,
		sessionId: sessionManager.getSessionId(),
		transformContext: async (messages) => {
			const runner = extensionRunnerRef.current;
			if (!runner) return messages;
			return runner.emitContext(messages);
		},
		steeringMode: settingsManager.getSteeringMode(),
		followUpMode: settingsManager.getFollowUpMode(),
		transport: settingsManager.getTransport(),
		thinkingBudgets: settingsManager.getThinkingBudgets(),
		maxRetryDelayMs: settingsManager.getRetrySettings().maxDelayMs,
		getApiKey: async (provider) => {
			// Use the provider argument from the in-flight request;
			// agent.state.model may already be switched mid-turn.
			const resolvedProvider = provider || agent.state.model?.provider;
			if (!resolvedProvider) {
				throw new Error("No model selected");
			}
			const key = await modelRegistry.getApiKeyForProvider(resolvedProvider);
			if (!key) {
				const model = agent.state.model;
				const isOAuth = model && modelRegistry.isUsingOAuth(model);
				if (isOAuth) {
					throw new Error(
						`Authentication failed for "${resolvedProvider}". ` +
							`Credentials may have expired or network is unavailable. ` +
							`Run '/login ${resolvedProvider}' to re-authenticate.`,
					);
				}
				throw new Error(
					`No API key found for "${resolvedProvider}". ` +
						`Set an API key environment variable or run '/login ${resolvedProvider}'.`,
				);
			}
			return key;
		},
	});
	patchAgentForParallelTaskExecution(agent);

	// Restore messages if session has existing data
	if (hasExistingSession) {
		agent.replaceMessages(existingSession.messages);
		if (!hasThinkingEntry) {
			sessionManager.appendThinkingLevelChange(thinkingLevel);
		}
	} else {
		// Save initial model and thinking level for new sessions so they can be restored on resume
		if (model) {
			sessionManager.appendModelChange(model.provider, model.id);
		}
		sessionManager.appendThinkingLevelChange(thinkingLevel);
	}

	// Build Task tool SubagentRunner — spawns isolated sub-sessions without circular imports
	const taskToolRunner = enableTaskTool
		? async (runnerOptions: {
				systemPrompt: string;
				tools: string[];
				prompt: string;
				cwd: string;
				modelOverride?: string;
				signal?: AbortSignal;
				onProgress?: (progress: TaskToolProgress) => void;
			}): Promise<
				string | { output: string; sessionId?: string; stats?: { toolCallsStarted: number; toolCallsCompleted: number; assistantMessages: number } }
			> => {
				let subModel = model;
				if (runnerOptions.modelOverride) {
					const resolved = resolveModelBySpecifier(
						modelRegistry,
						runnerOptions.modelOverride,
						model?.provider,
					);
					if (!resolved) {
						throw new Error(`Unknown model override: ${runnerOptions.modelOverride}`);
					}
					if (!(await modelRegistry.getApiKey(resolved))) {
						throw new Error(`No API key available for model override: ${resolved.provider}/${resolved.id}`);
					}
					subModel = resolved;
				}
				const { session: sub } = await createAgentSession({
					cwd: runnerOptions.cwd,
					agentDir,
					authStorage,
					modelRegistry,
					model: subModel,
					tools: createToolsFromNames(runnerOptions.cwd, runnerOptions.tools),
					sessionManager: SessionManager.inMemory(),
					settingsManager,
					enableTaskTool: false, // prevent recursive subagent spawning
				});

				// Apply profile system prompt by appending it to the base after session init
				if (runnerOptions.systemPrompt) {
					const base = sub.agent.state.systemPrompt;
					sub.agent.setSystemPrompt(
						base ? `${base}\n\n${runnerOptions.systemPrompt}` : runnerOptions.systemPrompt,
					);
				}

				// Collect all assistant text from the sub-session
				const chunks: string[] = [];
				const abortSubagent = (): void => {
					void sub.abort();
				};
				if (runnerOptions.signal?.aborted) {
					abortSubagent();
					throw new Error("Operation aborted");
				}
				runnerOptions.signal?.addEventListener("abort", abortSubagent, { once: true });
				const progressState = {
					toolCallsStarted: 0,
					toolCallsCompleted: 0,
					assistantMessages: 0,
					activeTool: undefined as string | undefined,
				};
				const trimInline = (value: string, max = 60): string => {
					const compact = value.trim().replace(/\s+/g, " ");
					return compact.length > max ? `${compact.slice(0, Math.max(1, max - 3))}...` : compact;
				};
				const summarizeToolTarget = (toolName: string, args: unknown): string => {
					if (!args || typeof args !== "object") return `running ${toolName}`;
					const record = args as Record<string, unknown>;
					const filePath =
						typeof record.file_path === "string"
							? record.file_path
							: typeof record.path === "string"
								? record.path
								: undefined;
					if (filePath) {
						return `running ${toolName} (${trimInline(filePath, 50)})`;
					}
					const command =
						typeof record.command === "string"
							? record.command
							: typeof record.cmd === "string"
								? record.cmd
								: undefined;
					if (command) {
						return `running ${toolName} (${trimInline(command, 50)})`;
					}
					return `running ${toolName}`;
				};
				const emitProgress = (phase: TaskToolProgressPhase, message: string, activeTool?: string): void => {
					progressState.activeTool = activeTool;
					runnerOptions.onProgress?.({
						kind: "subagent_progress",
						phase,
						message,
						cwd: runnerOptions.cwd,
						activeTool: progressState.activeTool,
						toolCallsStarted: progressState.toolCallsStarted,
						toolCallsCompleted: progressState.toolCallsCompleted,
						assistantMessages: progressState.assistantMessages,
					});
				};
				emitProgress("starting", "booting subagent", undefined);

				try {
					sub.subscribe((event) => {
						if (event.type === "message_end" && event.message.role === "assistant") {
							progressState.assistantMessages += 1;
							for (const part of event.message.content) {
								if (part.type === "text" && part.text.trim()) {
									chunks.push(part.text.trim());
								}
							}
							if (chunks.length > 0) {
								emitProgress("responding", "drafting response", undefined);
							}
						}
						if (event.type === "tool_execution_start") {
							progressState.toolCallsStarted += 1;
							const toolName = event.toolName ?? "tool";
							emitProgress("running", summarizeToolTarget(toolName, event.args), toolName);
						}
						if (event.type === "tool_execution_end") {
							progressState.toolCallsCompleted += 1;
							const toolName = event.toolName ?? "tool";
							const nextActive = progressState.activeTool === toolName ? undefined : progressState.activeTool;
							emitProgress("running", `completed ${toolName}`, nextActive);
						}
					});

					await sub.prompt(runnerOptions.prompt, { skipIosmAutopilot: true });
					if (runnerOptions.signal?.aborted) {
						throw new Error("Operation aborted");
					}
					emitProgress("responding", "finalizing response", undefined);
					const sessionId = sub.sessionManager.getSessionId();
					return {
						output: chunks.join("\n\n"),
						sessionId,
						stats: {
							toolCallsStarted: progressState.toolCallsStarted,
							toolCallsCompleted: progressState.toolCallsCompleted,
							assistantMessages: progressState.assistantMessages,
						},
					};
				} finally {
					runnerOptions.signal?.removeEventListener("abort", abortSubagent);
					sub.dispose();
				}
			}
		: undefined;

	let sessionRef: AgentSession | undefined;
	const initialCustomSubagents = loadCustomSubagents({ cwd, agentDir });
	for (const diagnostic of initialCustomSubagents.diagnostics) {
		console.warn(`Warning: invalid subagent ${diagnostic.path}: ${diagnostic.message}`);
	}
	const taskTool = taskToolRunner
		? createTaskTool(cwd, taskToolRunner, {
				resolveCustomSubagent: (name) => {
					// Resolve against live on-disk definitions so newly created agents
					// are immediately callable in the same interactive session.
					const current = loadCustomSubagents({ cwd, agentDir });
					const resolvedName = resolveCustomSubagentReference(name, current.agents);
					return resolvedName ? current.agents.find((agent) => agent.name === resolvedName) : undefined;
				},
				availableCustomSubagents: initialCustomSubagents.agents.map((agent) => agent.name),
				availableCustomSubagentHints: initialCustomSubagents.agents.map((agent) => ({
					name: agent.name,
					description: agent.description,
				})),
				getMetaMessages: () => sessionRef?.getMetaMessages() ?? [],
			})
		: undefined;

	// Wire in ask_user, task tool, and any caller-supplied custom tools
	const baseCustomTools: ToolDefinition[] = [
		...(options.customTools ?? []).filter(
			(t) => t.name !== "ask_user" && t.name !== "task",
		),
		...(taskTool ? [taskTool as unknown as ToolDefinition] : []),
	];

	const customTools: ToolDefinition[] | undefined = options.enableAskUserTool
		? [
				...baseCustomTools.filter((tool) => tool.name !== "ask_user"),
				createAskUserTool() as unknown as ToolDefinition,
			]
		: baseCustomTools.length > 0
			? baseCustomTools
			: options.customTools;

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd,
		scopedModels: options.scopedModels,
		resourceLoader,
		customTools,
		modelRegistry,
		initialActiveToolNames,
		extensionRunnerRef,
		systemPromptSuffix: profile?.systemPromptAppend || undefined,
		iosmAutopilotEnabled: profile?.name === "iosm",
	});
	sessionRef = session;
	const extensionsResult = resourceLoader.getExtensions();

	return {
		session,
		extensionsResult,
		modelFallbackMessage,
	};
}
