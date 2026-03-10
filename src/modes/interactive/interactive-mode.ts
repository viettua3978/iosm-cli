/**
 * Interactive mode for the coding agent.
 * Handles TUI rendering and user interaction, delegating business logic to AgentSession.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ImageContent, Message, Model, OAuthProviderId } from "@mariozechner/pi-ai";
import type {
	AutocompleteItem,
	AutocompleteProvider,
	EditorAction,
	EditorComponent,
	EditorTheme,
	KeyId,
	MarkdownTheme,
	OverlayHandle,
	OverlayOptions,
	SlashCommand,
} from "@mariozechner/pi-tui";
import {
	CombinedAutocompleteProvider,
	type Component,
	Container,
	fuzzyFilter,
	Loader,
	Markdown,
	matchesKey,
	ProcessTerminal,
	Spacer,
	Text,
	TruncatedText,
	TUI,
	visibleWidth,
} from "@mariozechner/pi-tui";
import { spawn, spawnSync } from "child_process";
import {
	APP_NAME,
	CHANGELOG_URL,
	ENV_SESSION_TRACE,
	ENV_OFFLINE,
	ENV_SKIP_VERSION_CHECK,
	getAgentDir,
	getAuthPath,
	getDebugLogPath,
	getModelsPath,
	getSessionTracePath,
	getShareViewerUrl,
	getUpdateInstruction,
	isSessionTraceEnabled,
	PACKAGE_NAME,
	VERSION,
} from "../../config.js";
import { AuthStorage } from "../../core/auth-storage.js";
import {
	getAgentProfile,
	getMainProfileNames,
	getProfileNames,
	isValidProfileName,
	type AgentProfileName,
} from "../../core/agent-profiles.js";
import { type AgentSession, type AgentSessionEvent, parseSkillBlock } from "../../core/agent-session.js";
import type { CompactionResult } from "../../core/compaction/index.js";
import type {
	ExtensionContext,
	ExtensionRunner,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
} from "../../core/extensions/index.js";
import { FooterDataProvider, type ReadonlyFooterDataProvider } from "../../core/footer-data-provider.js";
import { type AppAction, KeybindingsManager } from "../../core/keybindings.js";
import {
	createCompactionSummaryMessage,
	INTERNAL_UI_META_CUSTOM_TYPE,
	isInternalUiMetaDetails,
} from "../../core/messages.js";
import { ModelRegistry } from "../../core/model-registry.js";
import { resolveModelScope } from "../../core/model-resolver.js";
import {
	getMcpCommandHelp,
	parseMcpAddCommand,
	parseMcpTargetCommand,
	type McpServerConfig,
	type McpRuntime,
	type McpScope,
} from "../../core/mcp/index.js";
import {
	addMemoryEntry,
	getMemoryFilePath,
	readMemoryEntries,
	removeMemoryEntry,
	updateMemoryEntry,
	type MemoryScope,
} from "../../core/memory.js";
import { DefaultResourceLoader } from "../../core/resource-loader.js";
import { createAgentSession } from "../../core/sdk.js";
import { createTeamRun, getTeamRun, listTeamRuns } from "../../core/agent-teams.js";
import {
	loadCustomSubagents,
	resolveCustomSubagentReference,
	type CustomSubagentEntry,
} from "../../core/subagents.js";
import { getSubagentRun, listSubagentRuns } from "../../core/subagent-runs.js";
import type { ResourceDiagnostic } from "../../core/resource-loader.js";
import { type SessionContext, SessionManager } from "../../core/session-manager.js";
import { SettingsManager } from "../../core/settings-manager.js";
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.js";
import type { ToolPermissionRequest } from "../../core/tools/index.js";
import { isTaskPlanSnapshot, TASK_PLAN_CUSTOM_TYPE } from "../../core/task-plan.js";
import type { TruncationResult } from "../../core/tools/truncate.js";
import {
	buildIosmAutomationPrompt,
	buildIosmAgentVerificationPrompt,
	buildIosmGuideAuthoringPrompt,
	buildIosmPriorityChecklist,
	createMetricSnapshot,
	extractAssistantText,
	evaluateIosmAutomationProgress,
	formatMetricSnapshot,
	hasReachedIosmTarget,
	getIosmGuidePath,
	initIosmWorkspace,
	inspectIosmCycle,
	listIosmCycles,
	loadIosmConfig,
	planIosmCycle,
	readIosmCycleReport,
	recordIosmCycleHistory,
	resolveIosmAutomationSettings,
	summarizeMetricDelta,
	normalizeIosmGuideMarkdown,
	writeIosmGuideDocument,
	type IosmInitResult,
	type IosmDecision,
	type IosmMetricSnapshot,
} from "../../iosm/index.js";
import { getChangelogPath, getNewEntries, parseChangelog } from "../../utils/changelog.js";
import { copyToClipboard } from "../../utils/clipboard.js";
import { extensionForImageMimeType, readClipboardImage } from "../../utils/clipboard-image.js";
import { ensureTool } from "../../utils/tools-manager.js";
import { ArminComponent } from "./components/armin.js";
import { AsciiLogoComponent } from "./components/ascii-logo.js";
import { AssistantMessageComponent } from "./components/assistant-message.js";
import { DecryptLoader } from "./components/decrypt-loader.js";
import { BashExecutionComponent } from "./components/bash-execution.js";
import { BorderedLoader } from "./components/bordered-loader.js";
import { BranchSummaryMessageComponent } from "./components/branch-summary-message.js";
import { CompactionSummaryMessageComponent } from "./components/compaction-summary-message.js";
import { CustomEditor } from "./components/custom-editor.js";
import { CustomMessageComponent } from "./components/custom-message.js";
import { DaxnutsComponent } from "./components/daxnuts.js";
import { DynamicBorder } from "./components/dynamic-border.js";
import { ExtensionEditorComponent } from "./components/extension-editor.js";
import { ExtensionInputComponent } from "./components/extension-input.js";
import { ExtensionSelectorComponent } from "./components/extension-selector.js";
import { FooterComponent } from "./components/footer.js";
import { appKey, appKeyHint, editorKey } from "./components/keybinding-hints.js";
import { LoginDialogComponent } from "./components/login-dialog.js";
import { McpSelectorComponent } from "./components/mcp-selector.js";
import { ModelSelectorComponent } from "./components/model-selector.js";
import { OAuthSelectorComponent } from "./components/oauth-selector.js";
import { ScopedModelsSelectorComponent } from "./components/scoped-models-selector.js";
import { SessionSelectorComponent } from "./components/session-selector.js";
import { SettingsSelectorComponent } from "./components/settings-selector.js";
import { SkillInvocationMessageComponent } from "./components/skill-invocation-message.js";
import {
	SubagentMessageComponent,
	type SubagentDelegateItem,
	type SubagentInfo,
	type SubagentPhaseState,
} from "./components/subagent-message.js";
import { TaskPlanMessageComponent } from "./components/task-plan-message.js";
import { ToolExecutionComponent } from "./components/tool-execution.js";
import { TreeSelectorComponent } from "./components/tree-selector.js";
import { UserMessageComponent } from "./components/user-message.js";
import { UserMessageSelectorComponent } from "./components/user-message-selector.js";
import {
	getAvailableThemes,
	getAvailableThemesWithPaths,
	getEditorTheme,
	getMarkdownTheme,
	getThemeByName,
	initTheme,
	onThemeChange,
	setRegisteredThemes,
	setTheme,
	setThemeInstance,
	Theme,
	type ThemeColor,
	theme,
} from "./theme/theme.js";

/** Interface for components that can be expanded/collapsed */
interface Expandable {
	setExpanded(expanded: boolean): void;
}

function isExpandable(obj: unknown): obj is Expandable {
	return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
}

type CompactionQueuedMessage = {
	text: string;
	mode: "steer" | "followUp" | "meta";
};

type IosmInitVerificationSummary = {
	completed: boolean;
	cancelled?: boolean;
	skippedReason?: string;
	error?: string;
	current?: IosmMetricSnapshot;
	historyPath?: string;
	tracePath?: string;
	guidePath?: string;
	toolCalls?: number;
	activityLog?: string[];
};

type IosmAutomationLoopStatus = "stabilized" | "threshold_reached" | "max_iterations" | "cancelled" | "failed";

const IOSM_PROFILE_ONLY_COMMANDS = new Set(["iosm", "cycle-list", "cycle-plan", "cycle-status", "cycle-report"]);
const CHECKPOINT_LABEL_PREFIX = "checkpoint:";

type IosmAutomationRunState = {
	cancelRequested: boolean;
	targetIndex?: number;
	maxIterations?: number;
	iterationsCompleted: number;
};

type IosmAutomationRefreshResult = {
	initResult: IosmInitResult;
	verification?: IosmInitVerificationSummary;
	snapshot: IosmMetricSnapshot;
	guidePath: string;
	cycleDecision?: IosmDecision;
};

type SessionCheckpoint = {
	name: string;
	targetId: string;
	labelEntryId: string;
	timestamp: string;
};

type DoctorCheckLevel = "ok" | "warn" | "fail";

type DoctorCheckItem = {
	level: DoctorCheckLevel;
	label: string;
	detail: string;
	fix?: string;
};

const OPENROUTER_PROVIDER_ID = "openrouter";

type OrchestrationMode = "parallel" | "sequential";

type ParsedOrchestrateCommand = {
	mode: OrchestrationMode;
	agents: number;
	maxParallel?: number;
	profile?: AgentProfileName;
	profiles?: AgentProfileName[];
	cwds?: string[];
	locks?: string[];
	isolation?: "none" | "worktree";
	dependencies?: Array<{ agent: number; dependsOn: number[] }>;
	task: string;
};

function isAbortLikeMessage(message: string): boolean {
	const normalized = message.trim().toLowerCase();
	return normalized.includes("aborted") || normalized.includes("cancelled");
}

const SUBAGENT_PHASE_STATES = new Set<SubagentPhaseState>(["queued", "starting", "running", "responding"]);
const SUBAGENT_DELEGATE_STATUSES = new Set<SubagentDelegateItem["status"]>(["pending", "running", "done", "failed"]);

function isSubagentPhaseState(value: unknown): value is SubagentPhaseState {
	return typeof value === "string" && SUBAGENT_PHASE_STATES.has(value as SubagentPhaseState);
}

function isSubagentDelegateStatus(value: unknown): value is SubagentDelegateItem["status"] {
	return typeof value === "string" && SUBAGENT_DELEGATE_STATUSES.has(value as SubagentDelegateItem["status"]);
}

function parseSubagentDelegateItems(value: unknown): SubagentDelegateItem[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const parsed: SubagentDelegateItem[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== "object") continue;
		const candidate = raw as Record<string, unknown>;
		const indexRaw = candidate.index;
		const index =
			typeof indexRaw === "number" && Number.isFinite(indexRaw) && indexRaw > 0 ? Math.floor(indexRaw) : undefined;
		const description =
			typeof candidate.description === "string" && candidate.description.trim().length > 0
				? candidate.description.trim()
				: undefined;
		const profile =
			typeof candidate.profile === "string" && candidate.profile.trim().length > 0
				? candidate.profile.trim()
				: undefined;
		const status = isSubagentDelegateStatus(candidate.status) ? candidate.status : undefined;
		if (!index || !description || !profile || !status) continue;
		parsed.push({ index, description, profile, status });
		if (parsed.length >= 20) break;
	}
	return parsed;
}

function hasDependencyCycle(
	agents: number,
	dependencies: Array<{ agent: number; dependsOn: number[] }>,
): boolean {
	const graph = new Map<number, number[]>();
	for (let agent = 1; agent <= agents; agent++) {
		graph.set(agent, []);
	}
	for (const dep of dependencies) {
		graph.set(dep.agent, [...dep.dependsOn]);
	}

	const visiting = new Set<number>();
	const visited = new Set<number>();

	const dfs = (node: number): boolean => {
		if (visiting.has(node)) return true;
		if (visited.has(node)) return false;

		visiting.add(node);
		for (const next of graph.get(node) ?? []) {
			if (dfs(next)) return true;
		}
		visiting.delete(node);
		visited.add(node);
		return false;
	};

	for (let agent = 1; agent <= agents; agent++) {
		if (dfs(agent)) return true;
	}
	return false;
}

/**
 * Options for InteractiveMode initialization.
 */
export interface InteractiveModeOptions {
	/** Providers that were migrated to auth.json (shows warning) */
	migratedProviders?: string[];
	/** Warning message if session model couldn't be restored */
	modelFallbackMessage?: string;
	/** Initial message to send on startup (can include @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
	/** Additional messages to send after the initial message */
	initialMessages?: string[];
	/** Force verbose startup (overrides quietStartup setting) */
	verbose?: boolean;
	/** Whether the session was started in plan mode (shows [PLAN] badge in footer) */
	planMode?: boolean;
	/** Active agent profile name (shows profile badge in footer when not "full") */
	profile?: string;
	/** MCP runtime for /mcp command and dynamic MCP tool updates */
	mcpRuntime?: McpRuntime;
}

export class InteractiveMode {
	private session: AgentSession;
	private ui: TUI;
	private chatContainer: Container;
	private pendingMessagesContainer: Container;
	private statusContainer: Container;
	private defaultEditor: CustomEditor;
	private editor: EditorComponent;
	private autocompleteProvider: AutocompleteProvider | undefined;
	private fdPath: string | undefined;
	private editorContainer: Container;
	private footer: FooterComponent;
	private footerDataProvider: FooterDataProvider;
	private keybindings: KeybindingsManager;
	private version: string;
	private isInitialized = false;
	private onInputCallback?: (text: string) => void;
	private loadingAnimation: DecryptLoader | undefined = undefined;
	private pendingWorkingMessage: string | undefined = undefined;
	private readonly defaultWorkingMessage = "Working...";
	private activeProfileName: AgentProfileName = "full";
	private permissionMode: "ask" | "auto" | "yolo" = "ask";
	private permissionAllowRules: string[] = [];
	private permissionDenyRules: string[] = [];
	private permissionPromptLock: Promise<void> = Promise.resolve();
	private sessionAllowedToolSignatures = new Set<string>();

	private lastSigintTime = 0;
	private lastEscapeTime = 0;
	private changelogMarkdown: string | undefined = undefined;

	// Status line tracking (for mutating immediately-sequential status updates)
	private lastStatusSpacer: Spacer | undefined = undefined;
	private lastStatusText: Text | undefined = undefined;

	// Streaming message tracking
	private streamingComponent: AssistantMessageComponent | undefined = undefined;
	private streamingMessage: AssistantMessage | undefined = undefined;

	// Tool execution tracking: toolCallId -> component
	private pendingTools = new Map<string, ToolExecutionComponent>();

	// Subagent execution tracking with live progress/metadata for task tool calls.
	private subagentComponents = new Map<
		string,
		{
			component: SubagentMessageComponent;
			startTime: number;
			profile: string;
			description: string;
			cwd?: string;
			agent?: string;
			lockKey?: string;
			isolation?: "none" | "worktree";
			phase?: string;
			phaseState?: SubagentPhaseState;
			activeTool?: string;
			toolCallsStarted: number;
			toolCallsCompleted: number;
			assistantMessages: number;
			delegatedTasks?: number;
			delegatedSucceeded?: number;
			delegatedFailed?: number;
			delegateIndex?: number;
			delegateTotal?: number;
			delegateDescription?: string;
			delegateProfile?: string;
			delegateItems?: SubagentDelegateItem[];
		}
	>();

	// Internal UI metadata emitted by runtime for orchestration rendering.
	private pendingInternalUserDisplayAliases: Array<{ rawPrompt: string; displayText: string }> = [];
	private pendingAssistantOrchestrationContexts = 0;
	private activeAssistantOrchestrationContext = false;

	// Tool output expansion state
	private toolOutputExpanded = false;

	// Thinking block visibility state
	private hideThinkingBlock = false;

	// Skill commands: command name -> skill file path
	private skillCommands = new Map<string, string>();
	private mcpRuntime?: McpRuntime;

	// Agent subscription unsubscribe function
	private unsubscribe?: () => void;

	// Track if editor is in bash mode (text starts with !)
	private isBashMode = false;

	// Track current bash execution component
	private bashComponent: BashExecutionComponent | undefined = undefined;

	// Track pending bash components (shown in pending area, moved to chat on submit)
	private pendingBashComponents: BashExecutionComponent[] = [];

	// Auto-compaction state
	private autoCompactionLoader: Loader | undefined = undefined;
	private autoCompactionEscapeHandler?: () => void;

	// Auto-retry state
	private retryLoader: Loader | undefined = undefined;
	private retryEscapeHandler?: () => void;

	// Messages queued while compaction is running
	private compactionQueuedMessages: CompactionQueuedMessage[] = [];

	// Shutdown state
	private shutdownRequested = false;

	// IOSM automation state
	private iosmAutomationRun: IosmAutomationRunState | undefined = undefined;
	private iosmVerificationSession: AgentSession | undefined = undefined;

	// Extension UI state
	private extensionSelector: ExtensionSelectorComponent | undefined = undefined;
	private extensionInput: ExtensionInputComponent | undefined = undefined;
	private extensionEditor: ExtensionEditorComponent | undefined = undefined;
	private extensionTerminalInputUnsubscribers = new Set<() => void>();

	// Extension widgets (components rendered above/below the editor)
	private extensionWidgetsAbove = new Map<string, Component & { dispose?(): void }>();
	private extensionWidgetsBelow = new Map<string, Component & { dispose?(): void }>();
	private widgetContainerAbove!: Container;
	private widgetContainerBelow!: Container;

	// Custom footer from extension (undefined = use built-in footer)
	private customFooter: (Component & { dispose?(): void }) | undefined = undefined;

	// Header container that holds the built-in or custom header
	private headerContainer: Container;

	// Built-in header (logo + keybinding hints + changelog)
	private builtInHeader: Text | undefined = undefined;

	// ASCII logo component for startup screen
	private asciiLogo: AsciiLogoComponent | undefined = undefined;

	// Custom header from extension (undefined = use built-in header)
	private customHeader: (Component & { dispose?(): void }) | undefined = undefined;

	// Convenience accessors
	private get agent() {
		return this.session.agent;
	}
	private get sessionManager() {
		return this.session.sessionManager;
	}
	private get settingsManager() {
		return this.session.settingsManager;
	}

	constructor(
		session: AgentSession,
		private options: InteractiveModeOptions = {},
	) {
		this.session = session;
		this.version = VERSION;
		this.ui = new TUI(new ProcessTerminal(), this.settingsManager.getShowHardwareCursor());
		this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
		this.headerContainer = new Container();
		this.chatContainer = new Container();
		this.pendingMessagesContainer = new Container();
		this.statusContainer = new Container();
		this.widgetContainerAbove = new Container();
		this.widgetContainerBelow = new Container();
		this.keybindings = KeybindingsManager.create();
		const editorPaddingX = this.settingsManager.getEditorPaddingX();
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		this.defaultEditor = new CustomEditor(this.ui, getEditorTheme(), this.keybindings, {
			paddingX: editorPaddingX,
			autocompleteMaxVisible,
		});
		this.editor = this.defaultEditor;
		this.editorContainer = new Container();
		this.editorContainer.addChild(this.editor as Component);
		this.footerDataProvider = new FooterDataProvider();
		this.footer = new FooterComponent(session, this.footerDataProvider);
		this.footer.setAutoCompactEnabled(session.autoCompactionEnabled);
		this.activeProfileName = getAgentProfile(options.profile).name;
		this.mcpRuntime = options.mcpRuntime;

		// Apply plan mode and profile badges immediately if set
		if (options.planMode || this.activeProfileName === "plan") {
			this.footer.setPlanMode(true);
		}
		this.footer.setActiveProfile(this.activeProfileName);
		this.session.setIosmAutopilotEnabled(this.activeProfileName === "iosm");
		this.permissionMode = this.settingsManager.getPermissionMode();
		this.permissionAllowRules = this.settingsManager.getPermissionAllowRules();
		this.permissionDenyRules = this.settingsManager.getPermissionDenyRules();
		this.session.setToolPermissionHandler((request) => this.requestToolPermission(request));
		this.mcpRuntime?.setPermissionGuard((request) => this.requestToolPermission(request));

		// Load hide thinking block setting
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();

		// Register themes from resource loader and initialize
		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		initTheme(this.settingsManager.getTheme(), true);
	}

	private getToolPermissionSignature(request: ToolPermissionRequest): string {
		const summary = request.summary.trim().replace(/\s+/g, " ");
		return `${request.toolName}:${summary}`;
	}

	private matchesPermissionRule(rule: string, request: ToolPermissionRequest): boolean {
		const [ruleToolRaw, ...rest] = rule.split(":");
		const ruleTool = (ruleToolRaw ?? "").trim();
		const ruleNeedle = rest.join(":").trim().toLowerCase();
		const toolMatches = !ruleTool || ruleTool === "*" || ruleTool === request.toolName;
		if (!toolMatches) return false;
		return !ruleNeedle || request.summary.toLowerCase().includes(ruleNeedle);
	}

	private async withPermissionDialogLock<T>(fn: () => Promise<T>): Promise<T> {
		const previous = this.permissionPromptLock;
		let release: (() => void) | undefined;
		this.permissionPromptLock = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await fn();
		} finally {
			release?.();
		}
	}

	private async requestToolPermission(request: ToolPermissionRequest): Promise<boolean> {
		for (const rule of this.permissionDenyRules) {
			if (this.matchesPermissionRule(rule, request)) {
				this.showWarning(`Denied by rule: ${rule}`);
				return false;
			}
		}

		for (const rule of this.permissionAllowRules) {
			if (this.matchesPermissionRule(rule, request)) {
				return true;
			}
		}

		if (this.permissionMode === "yolo") {
			return true;
		}
		if (this.permissionMode === "auto") {
			// Auto mode mirrors "accept edits": allow edit/write without prompts,
			// still ask for shell execution.
			if (request.toolName === "edit" || request.toolName === "write") {
				return true;
			}
		}

		const signature = this.getToolPermissionSignature(request);
		if (this.sessionAllowedToolSignatures.has(signature)) {
			return true;
		}

		return this.withPermissionDialogLock(async () => {
			if (this.permissionMode === "yolo") return true;
			if (this.sessionAllowedToolSignatures.has(signature)) return true;

			const label = `${request.toolName}: ${request.summary}`;
			const choice = await this.showExtensionSelector("Permission required", [
				"Allow once",
				"Deny",
				"Always allow this command (session)",
			]);
			if (!choice || choice === "Deny") {
				this.showWarning(`Permission denied: ${label}`);
				return false;
			}
			if (choice === "Always allow this command (session)") {
				this.sessionAllowedToolSignatures.add(signature);
			}
			return true;
		});
	}

	private getHookPolicySummary():
		| {
			sources: string[];
			userPromptSubmit: number;
			preToolUse: number;
			postToolUse: number;
			stop: number;
		}
		| undefined {
		const hooks = this.session.resourceLoader.getHooks?.();
		if (!hooks) return undefined;
		return {
			sources: hooks.sources,
			userPromptSubmit: hooks.userPromptSubmit.length,
			preToolUse: hooks.preToolUse.length,
			postToolUse: hooks.postToolUse.length,
			stop: hooks.stop.length,
		};
	}

	private handleYoloCommand(text: string): void {
		const args = this.parseSlashArgs(text).slice(1);
		const value = args[0]?.toLowerCase();
		if (!value) {
			this.permissionMode = this.permissionMode === "yolo" ? "ask" : "yolo";
			this.settingsManager.setPermissionMode(this.permissionMode);
			this.showStatus(`YOLO mode: ${this.permissionMode === "yolo" ? "ON" : "OFF"}`);
			return;
		}
		if (value === "status") {
			this.showStatus(`YOLO mode: ${this.permissionMode === "yolo" ? "ON" : "OFF"}`);
			return;
		}
		if (value === "on") {
			this.permissionMode = "yolo";
			this.settingsManager.setPermissionMode("yolo");
			this.showStatus("YOLO mode: ON (tool confirmations disabled)");
			return;
		}
		if (value === "off") {
			this.permissionMode = "ask";
			this.settingsManager.setPermissionMode("ask");
			this.showStatus("YOLO mode: OFF (tool confirmations enabled)");
			return;
		}
		this.showWarning("Usage: /yolo [on|off|status]");
	}

	private getPermissionsStatusText(): string {
		const hookSummary = this.getHookPolicySummary();
		const hookSegment = hookSummary
			? ` · hooks: U${hookSummary.userPromptSubmit}/P${hookSummary.preToolUse}/T${hookSummary.postToolUse}/S${hookSummary.stop}`
			: "";
		return `Permissions: ${this.permissionMode}${this.permissionAllowRules.length > 0 ? ` · allow rules: ${this.permissionAllowRules.length}` : ""}${this.permissionDenyRules.length > 0 ? ` · deny rules: ${this.permissionDenyRules.length}` : ""}${hookSegment}`;
	}

	private async runPermissionRulesMenu(kind: "allow" | "deny"): Promise<void> {
		while (true) {
			const isAllow = kind === "allow";
			const rules = isAllow ? this.permissionAllowRules : this.permissionDenyRules;
			const selected = await this.showExtensionSelector(`/permissions ${kind} (${rules.length} rule${rules.length === 1 ? "" : "s"})`, [
				"Add rule",
				"Remove rule",
				"Show rules",
				"Back",
			]);
			if (!selected || selected === "Back") {
				return;
			}

			if (selected === "Show rules") {
				if (rules.length === 0) {
					this.showStatus(`Permissions ${kind} rules: (empty)`);
					continue;
				}
				this.showCommandTextBlock(
					`Permissions ${isAllow ? "Allow" : "Deny"} Rules`,
					rules.map((rule) => `- ${rule}`).join("\n"),
				);
				continue;
			}

			if (selected === "Add rule") {
				const input = await this.showExtensionInput(
					`/permissions ${kind} add`,
					"tool:match (example: bash:git *, edit:*.env)",
				);
				if (input === undefined) continue;
				const rawRule = input.trim();
				if (!rawRule || !rawRule.includes(":")) {
					this.showWarning(`Invalid rule "${rawRule || "(empty)"}". Expected <tool:match>.`);
					continue;
				}
				if (isAllow) {
					if (!this.permissionAllowRules.includes(rawRule)) {
						this.permissionAllowRules.push(rawRule);
						this.settingsManager.setPermissionAllowRules(this.permissionAllowRules);
					}
				} else {
					if (!this.permissionDenyRules.includes(rawRule)) {
						this.permissionDenyRules.push(rawRule);
						this.settingsManager.setPermissionDenyRules(this.permissionDenyRules);
					}
				}
				this.showStatus(`Added ${kind} rule: ${rawRule}`);
				continue;
			}

			if (selected === "Remove rule") {
				if (rules.length === 0) {
					this.showStatus(`No ${kind} rules to remove.`);
					continue;
				}
				const pickedRule = await this.showExtensionSelector(
					`/permissions ${kind}: remove rule`,
					rules.map((rule) => rule),
				);
				if (!pickedRule) continue;

				if (isAllow) {
					this.permissionAllowRules = this.permissionAllowRules.filter((rule) => rule !== pickedRule);
					this.settingsManager.setPermissionAllowRules(this.permissionAllowRules);
				} else {
					this.permissionDenyRules = this.permissionDenyRules.filter((rule) => rule !== pickedRule);
					this.settingsManager.setPermissionDenyRules(this.permissionDenyRules);
				}
				this.showStatus(`Removed ${kind} rule: ${pickedRule}`);
			}
		}
	}

	private async runPermissionsInteractiveMenu(): Promise<void> {
		while (true) {
			const selected = await this.showExtensionSelector("/permissions", [
				`Mode (${this.permissionMode})`,
				`Allow Rules (${this.permissionAllowRules.length})`,
				`Deny Rules (${this.permissionDenyRules.length})`,
				"Hooks Summary",
				"Show Status",
				"Close",
			]);
			if (!selected || selected === "Close") {
				return;
			}

			if (selected.startsWith("Mode")) {
				const modeChoice = await this.showExtensionSelector("/permissions: mode", [
					"ask (Recommended)",
					"auto",
					"yolo",
				]);
				if (!modeChoice) continue;
				const nextMode = modeChoice.startsWith("ask")
					? "ask"
					: modeChoice.startsWith("auto")
						? "auto"
						: "yolo";
				this.permissionMode = nextMode;
				this.settingsManager.setPermissionMode(nextMode);
				this.showStatus(`Permissions: ${nextMode}`);
				continue;
			}

			if (selected.startsWith("Allow Rules")) {
				await this.runPermissionRulesMenu("allow");
				continue;
			}

			if (selected.startsWith("Deny Rules")) {
				await this.runPermissionRulesMenu("deny");
				continue;
			}

			if (selected === "Hooks Summary") {
				const summary = this.getHookPolicySummary();
				if (!summary) {
					this.showWarning("Hooks policy is unavailable in current session.");
					continue;
				}
				const sourceLines =
					summary.sources.length > 0 ? summary.sources.map((source) => `- ${source}`) : ["- (none loaded)"];
				const lines = [
					`UserPromptSubmit: ${summary.userPromptSubmit}`,
					`PreToolUse: ${summary.preToolUse}`,
					`PostToolUse: ${summary.postToolUse}`,
					`Stop: ${summary.stop}`,
					"",
					"Sources:",
					...sourceLines,
				];
				this.showCommandTextBlock("Hook Policies", lines.join("\n"));
				continue;
			}

			if (selected === "Show Status") {
				this.showStatus(this.getPermissionsStatusText());
			}
		}
	}

	private async handlePermissionsCommand(text: string): Promise<void> {
		const args = this.parseSlashArgs(text).slice(1);
		const value = args[0]?.toLowerCase();
		if (!value) {
			await this.runPermissionsInteractiveMenu();
			return;
		}
		if (value === "hooks") {
			const mode = args[1]?.toLowerCase();
			const summary = this.getHookPolicySummary();
			if (!summary) {
				this.showWarning("Hooks policy is unavailable in current session.");
				return;
			}
			if (mode === "json") {
				this.showCommandJsonBlock("Hook Policies", summary);
				return;
			}
			const sourceLines =
				summary.sources.length > 0 ? summary.sources.map((source) => `- ${source}`) : ["- (none loaded)"];
			const lines = [
				`UserPromptSubmit: ${summary.userPromptSubmit}`,
				`PreToolUse: ${summary.preToolUse}`,
				`PostToolUse: ${summary.postToolUse}`,
				`Stop: ${summary.stop}`,
				"",
				"Sources:",
				...sourceLines,
			];
			this.showCommandTextBlock("Hook Policies", lines.join("\n"));
			return;
		}
		if (value === "allow") {
			const action = args[1]?.toLowerCase();
			if (action === "list") {
				if (this.permissionAllowRules.length === 0) {
					this.showStatus("Permissions allow rules: (empty)");
					return;
				}
				this.showCommandTextBlock("Permissions Allow Rules", this.permissionAllowRules.map((r) => `- ${r}`).join("\n"));
				return;
			}
			if (action === "add") {
				const rawRule = args.slice(2).join(" ").trim();
				if (!rawRule || !rawRule.includes(":")) {
					this.showWarning("Usage: /permissions allow add <tool:match>");
					return;
				}
				if (!this.permissionAllowRules.includes(rawRule)) {
					this.permissionAllowRules.push(rawRule);
					this.settingsManager.setPermissionAllowRules(this.permissionAllowRules);
				}
				this.showStatus(`Added allow rule: ${rawRule}`);
				return;
			}
			if (action === "remove") {
				const rawRule = args.slice(2).join(" ").trim();
				if (!rawRule) {
					this.showWarning("Usage: /permissions allow remove <tool:match>");
					return;
				}
				this.permissionAllowRules = this.permissionAllowRules.filter((r) => r !== rawRule);
				this.settingsManager.setPermissionAllowRules(this.permissionAllowRules);
				this.showStatus(`Removed allow rule: ${rawRule}`);
				return;
			}
			this.showWarning("Usage: /permissions allow [list|add|remove]");
			return;
		}
		if (value === "deny") {
			const action = args[1]?.toLowerCase();
			if (action === "list") {
				if (this.permissionDenyRules.length === 0) {
					this.showStatus("Permissions deny rules: (empty)");
					return;
				}
				this.showCommandTextBlock("Permissions Deny Rules", this.permissionDenyRules.map((r) => `- ${r}`).join("\n"));
				return;
			}
			if (action === "add") {
				const rawRule = args.slice(2).join(" ").trim();
				if (!rawRule || !rawRule.includes(":")) {
					this.showWarning("Usage: /permissions deny add <tool:match>");
					return;
				}
				if (!this.permissionDenyRules.includes(rawRule)) {
					this.permissionDenyRules.push(rawRule);
					this.settingsManager.setPermissionDenyRules(this.permissionDenyRules);
				}
				this.showStatus(`Added deny rule: ${rawRule}`);
				return;
			}
			if (action === "remove") {
				const rawRule = args.slice(2).join(" ").trim();
				if (!rawRule) {
					this.showWarning("Usage: /permissions deny remove <tool:match>");
					return;
				}
				this.permissionDenyRules = this.permissionDenyRules.filter((r) => r !== rawRule);
				this.settingsManager.setPermissionDenyRules(this.permissionDenyRules);
				this.showStatus(`Removed deny rule: ${rawRule}`);
				return;
			}
			this.showWarning("Usage: /permissions deny [list|add|remove]");
			return;
		}
		if (value === "status") {
			this.showStatus(this.getPermissionsStatusText());
			return;
		}
		if (value === "ask" || value === "auto" || value === "yolo") {
			this.permissionMode = value;
			this.settingsManager.setPermissionMode(value);
			this.showStatus(`Permissions: ${value}`);
			return;
		}
		this.showWarning("Usage: /permissions [ask|auto|yolo|status|allow|deny|hooks]");
	}

	private getMcpArgumentCompletions(prefix: string): AutocompleteItem[] | null {
		const mcpSubcommands = ["list", "status", "add", "get", "tools", "test", "enable", "disable", "remove", "help"];
		const servers = this.mcpRuntime?.getServers() ?? [];
		const hasTrailingSpace = /\\s$/.test(prefix);
		const tokens = this.parseSlashArgs(prefix);
		const first = tokens[0]?.toLowerCase();

		if (!first || (tokens.length === 1 && !hasTrailingSpace)) {
			const query = first ?? "";
			const candidates = mcpSubcommands.filter((subcommand) => subcommand.includes(query));
			return candidates.map((subcommand) => ({ value: subcommand, label: subcommand }));
		}

		if (["get", "remove", "enable", "disable", "test", "tools"].includes(first)) {
			const query = hasTrailingSpace ? "" : (tokens[1] ?? "");
			const filtered = query
				? fuzzyFilter(servers, query, (server) => `${server.name} ${server.scope}`)
				: servers;
			return filtered.map((server) => ({
				value: server.name,
				label: server.name,
				description: `${server.scope}/${server.transport} · ${server.state}`,
			}));
		}

		if (first === "add" && tokens.length === 2 && !hasTrailingSpace) {
			return [{ value: tokens[1], label: tokens[1], description: "server name" }];
		}

		return null;
	}

	private getMemoryArgumentCompletions(prefix: string): AutocompleteItem[] | null {
		const subcommands = ["list", "add", "edit", "rm", "remove", "path", "ui", "help"];
		const scopeFlags = ["--scope", "--project", "--user"];
		const scopeValues = ["project", "user"];
		const hasTrailingSpace = /\\s$/.test(prefix);
		const tokens = this.parseSlashArgs(prefix);
		const first = tokens[0]?.toLowerCase();

		const scopeFlagIndex = tokens.findIndex((token) => token === "--scope");
		if (scopeFlagIndex >= 0) {
			const needsScopeValue = scopeFlagIndex + 1 >= tokens.length;
			if (needsScopeValue) {
				return scopeValues.map((value) => ({ value, label: value }));
			}
			const currentScopeValue = tokens[scopeFlagIndex + 1] ?? "";
			if (currentScopeValue.length > 0 && !scopeValues.includes(currentScopeValue)) {
				return scopeValues
					.filter((value) => value.startsWith(currentScopeValue))
					.map((value) => ({ value, label: value }));
			}
		}

		if (!first || (tokens.length === 1 && !hasTrailingSpace)) {
			const query = first ?? "";
			const candidates = [...subcommands, ...scopeFlags].filter((item) => item.includes(query));
			return candidates.map((item) => ({ value: item, label: item }));
		}

		const query = hasTrailingSpace ? "" : (tokens[tokens.length - 1] ?? "");
		if (query.startsWith("--")) {
			return scopeFlags
				.filter((flag) => flag.includes(query))
				.map((flag) => ({ value: flag, label: flag }));
		}

		return null;
	}

	private setupAutocomplete(fdPath: string | undefined): void {
		// Define commands for autocomplete
		const builtinCommands = BUILTIN_SLASH_COMMANDS.filter(
			(command) => this.activeProfileName === "iosm" || !IOSM_PROFILE_ONLY_COMMANDS.has(command.name),
		);
		const slashCommands: SlashCommand[] = builtinCommands.map((command) => ({
			name: command.name,
			description: command.description,
		}));

		const modelCommand = slashCommands.find((command) => command.name === "model");
		if (modelCommand) {
			modelCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
				// Get available models (scoped or from registry)
				const models =
					this.session.scopedModels.length > 0
						? this.session.scopedModels.map((s) => s.model)
						: this.session.modelRegistry.getAvailable();

				if (models.length === 0) return null;

				// Create items with provider/id format
				const items = models.map((m) => ({
					id: m.id,
					provider: m.provider,
					label: `${m.provider}/${m.id}`,
				}));

				// Fuzzy filter by model ID + provider (allows "opus anthropic" to match)
				const filtered = fuzzyFilter(items, prefix, (item) => `${item.id} ${item.provider}`);

				if (filtered.length === 0) return null;

				return filtered.map((item) => ({
					value: item.label,
					label: item.id,
					description: item.provider,
				}));
			};
		}

		const mcpCommand = slashCommands.find((command) => command.name === "mcp");
		if (mcpCommand) {
			mcpCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null =>
				this.getMcpArgumentCompletions(prefix);
		}

		const memoryCommand = slashCommands.find((command) => command.name === "memory");
		if (memoryCommand) {
			memoryCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null =>
				this.getMemoryArgumentCompletions(prefix);
		}

		// Convert prompt templates to SlashCommand format for autocomplete
		const templateCommands: SlashCommand[] = this.session.promptTemplates.map((cmd) => ({
			name: cmd.name,
			description: cmd.description,
		}));

		// Convert extension commands to SlashCommand format
		const builtinCommandNames = new Set(slashCommands.map((c) => c.name));
		const extensionCommands: SlashCommand[] = (
			this.session.extensionRunner?.getRegisteredCommands(builtinCommandNames) ?? []
		).map((cmd) => ({
			name: cmd.name,
			description: cmd.description ?? "(extension command)",
			getArgumentCompletions: cmd.getArgumentCompletions,
		}));

		// Build skill commands from session.skills (if enabled)
		this.skillCommands.clear();
		const skillCommandList: SlashCommand[] = [];
		if (this.settingsManager.getEnableSkillCommands()) {
			for (const skill of this.session.resourceLoader.getSkills().skills) {
				const commandName = `skill:${skill.name}`;
				this.skillCommands.set(commandName, skill.filePath);
				skillCommandList.push({ name: commandName, description: skill.description });
			}
		}

		const customAgentMentionItems = (() => {
			const cwd = this.sessionManager.getCwd();
			const loaded = loadCustomSubagents({ cwd, agentDir: getAgentDir() });
			return loaded.agents.map((agent) => ({
				name: agent.name,
				value: `@${agent.name} `,
				label: `@${agent.name}`,
				description: `${agent.description} · profile=${agent.profile ?? "full"}`,
			}));
		})();

		// Setup autocomplete
		const baseAutocompleteProvider = new CombinedAutocompleteProvider(
			[...slashCommands, ...templateCommands, ...extensionCommands, ...skillCommandList],
			process.cwd(),
			fdPath,
		);

		this.autocompleteProvider = {
			getSuggestions: (lines, cursorLine, cursorCol) => {
				const currentLine = lines[cursorLine] || "";
				const textBeforeCursor = currentLine.slice(0, cursorCol);
				const mentionMatch = textBeforeCursor.match(/(?:^|\s)(@[^\s@]*)$/);
				const mentionPrefix = mentionMatch?.[1] ?? null;
				const fallback = baseAutocompleteProvider.getSuggestions(lines, cursorLine, cursorCol);
				if (!mentionPrefix || customAgentMentionItems.length === 0) {
					return fallback;
				}

				const rawQuery = mentionPrefix.slice(1).trim();
				const normalizedQuery = rawQuery.replace(/\\/g, "/");
				const queryTail = normalizedQuery.split("/").filter(Boolean).pop() ?? normalizedQuery;
				const query = queryTail.replace(/\.md$/i, "");
				const filtered = query
					? fuzzyFilter(customAgentMentionItems, query, (item) => `${item.name} ${item.description ?? ""}`)
					: customAgentMentionItems;
				if (filtered.length === 0) {
					return fallback;
				}

				const mergedItems: AutocompleteItem[] = filtered.map((item) => ({
					value: item.value,
					label: item.label,
					description: item.description,
				}));
				const seen = new Set(mergedItems.map((item) => item.value));
				if (fallback && fallback.prefix === mentionPrefix) {
					for (const item of fallback.items) {
						if (seen.has(item.value)) continue;
						mergedItems.push(item);
					}
				}
				return { items: mergedItems, prefix: mentionPrefix };
			},
			applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => {
				if (prefix.startsWith("@")) {
					const currentLine = lines[cursorLine] || "";
					const replaceStart = Math.max(0, cursorCol - prefix.length);
					const beforePrefix = currentLine.slice(0, replaceStart);
					const afterCursor = currentLine.slice(cursorCol);
					const nextLines = [...lines];
					nextLines[cursorLine] = `${beforePrefix}${item.value}${afterCursor}`;
					return {
						lines: nextLines,
						cursorLine,
						cursorCol: beforePrefix.length + item.value.length,
					};
				}
				return baseAutocompleteProvider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},
		};

		this.defaultEditor.setAutocompleteProvider(this.autocompleteProvider);
		if (this.editor !== this.defaultEditor) {
			this.editor.setAutocompleteProvider?.(this.autocompleteProvider);
		}
	}

	async init(): Promise<void> {
		if (this.isInitialized) return;

		// Load changelog (only show new entries, skip for resumed sessions)
		this.changelogMarkdown = this.getChangelogForDisplay();

		// Ensure fd and rg are available (downloads if missing, adds to PATH via getBinDir)
		// Both are needed: fd for autocomplete, rg for grep tool and bash commands
		const [fdPath] = await Promise.all([ensureTool("fd"), ensureTool("rg")]);
		this.fdPath = fdPath;

		// Add header container as first child
		this.ui.addChild(this.headerContainer);

		// Add header with keybindings from config (unless silenced)
		if (this.options.verbose || !this.settingsManager.getQuietStartup()) {
			this.builtInHeader = new Text(this.buildStartupHeaderContent(), 1, 0);
			this.asciiLogo = new AsciiLogoComponent();

			// Setup UI layout with logo + dashboard
			this.headerContainer.addChild(new Spacer(1));
			this.headerContainer.addChild(this.asciiLogo);
			this.headerContainer.addChild(new DynamicBorder((text) => theme.fg("borderAccent", text)));
			this.headerContainer.addChild(new Spacer(1));
			this.headerContainer.addChild(this.builtInHeader);
			this.headerContainer.addChild(new Spacer(1));
			this.headerContainer.addChild(new DynamicBorder((text) => theme.fg("borderMuted", text)));
			this.headerContainer.addChild(new Spacer(1));

			// Add changelog if provided
			if (this.changelogMarkdown) {
				this.headerContainer.addChild(new DynamicBorder());
				if (this.settingsManager.getCollapseChangelog()) {
					const versionMatch = this.changelogMarkdown.match(/##\s+\[?(\d+\.\d+\.\d+)\]?/);
					const latestVersion = versionMatch ? versionMatch[1] : this.version;
					const condensedText = `Updated to v${latestVersion}. Use ${theme.bold("/changelog")} to view full changelog.`;
					this.headerContainer.addChild(new Text(condensedText, 1, 0));
				} else {
					this.headerContainer.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
					this.headerContainer.addChild(new Spacer(1));
					this.headerContainer.addChild(
						new Markdown(this.changelogMarkdown.trim(), 1, 0, this.getMarkdownThemeWithSettings()),
					);
					this.headerContainer.addChild(new Spacer(1));
				}
				this.headerContainer.addChild(new DynamicBorder());
			}
		} else {
			// Minimal header when silenced
			this.builtInHeader = new Text("", 0, 0);
			this.headerContainer.addChild(this.builtInHeader);
			if (this.changelogMarkdown) {
				// Still show changelog notification even in silent mode
				this.headerContainer.addChild(new Spacer(1));
				const versionMatch = this.changelogMarkdown.match(/##\s+\[?(\d+\.\d+\.\d+)\]?/);
				const latestVersion = versionMatch ? versionMatch[1] : this.version;
				const condensedText = `Updated to v${latestVersion}. Use ${theme.bold("/changelog")} to view full changelog.`;
				this.headerContainer.addChild(new Text(condensedText, 1, 0));
			}
		}

		this.ui.addChild(this.chatContainer);
		this.ui.addChild(this.pendingMessagesContainer);
		this.ui.addChild(this.statusContainer);
		this.renderWidgets(); // Initialize with default spacer
		this.ui.addChild(this.widgetContainerAbove);
		this.ui.addChild(this.editorContainer);
		this.ui.addChild(this.widgetContainerBelow);
		this.ui.addChild(this.footer);
		this.ui.setFocus(this.editor);

		this.setupKeyHandlers();
		this.setupEditorSubmitHandler();

		// Initialize extensions first so resources are shown before messages
		await this.initExtensions();

		// Render initial messages AFTER showing loaded resources
		this.renderInitialMessages();

		// Start the UI
		this.ui.start();
		this.isInitialized = true;

		// Set terminal title
		this.updateTerminalTitle();

		// Subscribe to agent events
		this.subscribeToAgent();

		// Set up theme file watcher
		onThemeChange(() => {
			this.ui.invalidate();
			this.updateEditorBorderColor();
			this.ui.requestRender();
		});

		// Set up git branch watcher (uses provider instead of footer)
		this.footerDataProvider.onBranchChange(() => {
			this.ui.requestRender();
		});

		// Initialize available provider count for footer display
		await this.updateAvailableProviderCount();
	}

	private buildStartupHeaderContent(): string {
		const kb = this.keybindings;
		const hasWorkspace = this.hasIosmWorkspace();
		const iosmMode = this.activeProfileName === "iosm";
		const activeModel = this.session.model;
		const activeModelText = activeModel ? `${activeModel.provider}/${activeModel.id}` : "not configured";
		const modelValue = activeModelText.length > 40 ? `${activeModelText.slice(0, 37)}...` : activeModelText;
		const availableModels = this.session.modelRegistry.getAvailable();
		const authProviders = this.session.modelRegistry.authStorage.list().length;
		const mcpStatuses = this.mcpRuntime?.getServers() ?? [];
		const mcpEnabled = mcpStatuses.filter((status) => status.enabled).length;
		const mcpConnected = mcpStatuses.filter((status) => status.state === "connected").length;
		const projectMemoryCount = this.getMemoryEntryCount("project");
		const userMemoryCount = this.getMemoryEntryCount("user");

		// Status indicator with colored dot
		const indicator = (ok: boolean): string =>
			ok ? theme.fg("success", "●") : theme.fg("warning", "○");

		// Title line: version + profile
		const titleLine =
			theme.bold(theme.fg("accent", `IOSM CLI`)) +
			theme.fg("dim", ` v${this.version}`) +
			theme.fg("dim", " │ ") +
			theme.fg("muted", "profile ") +
			theme.fg(iosmMode ? "accent" : "muted", this.activeProfileName);

		// Status rows with colored dot indicators
		const modeLabel = iosmMode ? (hasWorkspace ? "iosm" : "iosm (no workspace)") : "standard";
		const modeOk = iosmMode ? hasWorkspace : true;

		const modelOk = !!activeModel;
		const authOk = authProviders > 0;
		const readyOk = availableModels.length > 0;

		let mcpText = "none";
		let mcpOk = true;
		if (mcpStatuses.length > 0) {
			mcpText = mcpEnabled === 0
				? `0/${mcpStatuses.length} enabled`
				: `${mcpConnected}/${mcpEnabled} connected`;
			mcpOk = mcpEnabled > 0 && mcpConnected === mcpEnabled;
		}

		let memoryText: string;
		let memoryOk: boolean;
		if (projectMemoryCount !== undefined && userMemoryCount !== undefined) {
			const total = projectMemoryCount + userMemoryCount;
			memoryText = `project ${projectMemoryCount}, user ${userMemoryCount}`;
			memoryOk = total > 0;
		} else {
			memoryText = `project ${projectMemoryCount ?? "?"}, user ${userMemoryCount ?? "?"}`;
			memoryOk = false;
		}

		const pad = "  ";
		const statusRows = [
			`${pad}${indicator(modeOk)}  ${theme.fg("muted", "Mode")}     ${theme.fg(modeOk ? "text" : "warning", modeLabel)}`,
			`${pad}${indicator(modelOk)}  ${theme.fg("muted", "Model")}    ${theme.fg(modelOk ? "text" : "warning", modelValue)}`,
			`${pad}${indicator(authOk)}  ${theme.fg("muted", "Auth")}     ${theme.fg(authOk ? "text" : "warning", `${authProviders} provider${authProviders !== 1 ? "s" : ""}`)}`,
			`${pad}${indicator(readyOk)}  ${theme.fg("muted", "Ready")}    ${theme.fg(readyOk ? "text" : "warning", `${availableModels.length} model${availableModels.length !== 1 ? "s" : ""}`)}`,
			`${pad}${indicator(mcpOk)}  ${theme.fg("muted", "MCP")}      ${theme.fg(mcpOk ? "text" : "warning", mcpText)}`,
			`${pad}${indicator(memoryOk)}  ${theme.fg("muted", "Memory")}   ${theme.fg(memoryOk ? "text" : "warning", memoryText)}`,
		];

		// Contextual guidance
		let guidanceLine: string;
		if (!activeModel && availableModels.length === 0) {
			guidanceLine = `${pad}${theme.fg("dim", "→")} Get started: ${theme.fg("accent", "/login")} ${theme.fg("dim", "→")} ${theme.fg("accent", "/model")} ${theme.fg("dim", "→")} ${theme.fg("accent", "/doctor")}`;
		} else if (!activeModel) {
			guidanceLine = `${pad}${theme.fg("dim", "→")} Select a model: ${theme.fg("accent", "/model")}`;
		} else if (iosmMode && !hasWorkspace) {
			guidanceLine = `${pad}${theme.fg("dim", "→")} Initialize workspace: ${theme.fg("accent", "/init")} or ${theme.fg("accent", "/iosm")}`;
		} else {
			guidanceLine = `${pad}${theme.fg("dim", "→")} Ready. Type a task or use ${theme.fg("accent", "/help")} for commands`;
		}

		// Commands and keys
		const commandsLine =
			`${pad}${theme.fg("dim", "cmds")}  ` +
			["model", "login", "mcp", "memory", "doctor", "new"].map((c) => theme.fg("accent", `/${c}`)).join(theme.fg("dim", "  "));

		const keysLine =
			`${pad}${theme.fg("dim", "keys")}  ` +
			appKeyHint(kb, "interrupt", "stop") +
			theme.fg("dim", "  ") +
			appKeyHint(kb, "selectModel", "model") +
			theme.fg("dim", "  ") +
			appKeyHint(kb, "cycleModelForward", "next-model") +
			theme.fg("dim", "  ") +
			appKeyHint(kb, "cycleProfile", "profile");

		return [
			titleLine,
			"",
			...statusRows,
			"",
			guidanceLine,
			"",
			commandsLine,
			keysLine,
		].join("\n");
	}

	private getMemoryEntryCount(scope: MemoryScope): number | undefined {
		try {
			return readMemoryEntries(this.resolveMemoryPath(scope)).entries.length;
		} catch {
			return undefined;
		}
	}

	private refreshBuiltInHeader(): void {
		if (!this.builtInHeader || this.customHeader || this.settingsManager.getQuietStartup()) {
			return;
		}
		this.builtInHeader.setText(this.buildStartupHeaderContent());
		this.ui.requestRender();
	}

	private hasIosmWorkspace(): boolean {
		return fs.existsSync(path.join(this.sessionManager.getCwd(), ".iosm"));
	}

	private requireIosmMode(commandName: string): boolean {
		if (this.activeProfileName === "iosm") return true;
		this.showWarning(`\`${commandName}\` is available only in IOSM profile. Switch profile to \`iosm\` (Shift+Tab).`);
		return false;
	}

	/**
	 * Update terminal title with session name and cwd.
	 */
	private updateTerminalTitle(): void {
		const cwdBasename = path.basename(process.cwd());
		const sessionName = this.sessionManager.getSessionName();
		if (sessionName) {
			this.ui.terminal.setTitle(`${APP_NAME} - ${sessionName} - ${cwdBasename}`);
		} else {
			this.ui.terminal.setTitle(`${APP_NAME} - ${cwdBasename}`);
		}
	}

	/**
	 * Run the interactive mode. This is the main entry point.
	 * Initializes the UI, shows warnings, processes initial messages, and starts the interactive loop.
	 */
	async run(): Promise<void> {
		await this.init();

		// Start version check asynchronously
		this.checkForNewVersion().then((newVersion) => {
			if (newVersion) {
				this.showNewVersionNotification(newVersion);
			}
		});

		// Show startup warnings
		const { migratedProviders, modelFallbackMessage, initialMessage, initialImages, initialMessages } = this.options;

		if (migratedProviders && migratedProviders.length > 0) {
			this.showWarning(`Migrated credentials to auth.json: ${migratedProviders.join(", ")}`);
		}

		const modelsJsonError = this.session.modelRegistry.getError();
		if (modelsJsonError) {
			this.showError(`models.json error: ${modelsJsonError}`);
		}

		if (modelFallbackMessage) {
			this.showWarning(modelFallbackMessage);
		}
		if (!this.session.model) {
			this.showWarning("No model selected. Choose a model to start.");
			await this.showModelProviderSelector();
		}

		// Process initial messages
		if (initialMessage && this.session.model) {
			try {
				await this.session.prompt(initialMessage, { images: initialImages });
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				this.showError(errorMessage);
			}
		} else if (initialMessage && !this.session.model) {
			this.showWarning("Initial message not sent: select a model first.");
		}

		if (initialMessages && this.session.model) {
			for (const message of initialMessages) {
				try {
					await this.session.prompt(message);
				} catch (error: unknown) {
					const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
					this.showError(errorMessage);
				}
			}
		} else if (initialMessages && initialMessages.length > 0 && !this.session.model) {
			this.showWarning("Initial messages not sent: select a model first.");
		}

		// Main interactive loop
		while (true) {
			const userInput = await this.getUserInput();
			try {
				await this.promptWithTaskFallback(userInput);
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				this.showError(errorMessage);
			}
		}
	}

	/**
	 * Check npm registry for a newer version.
	 */
	private async checkForNewVersion(): Promise<string | undefined> {
		if (
			process.env[ENV_SKIP_VERSION_CHECK] ||
			process.env.PI_SKIP_VERSION_CHECK ||
			process.env[ENV_OFFLINE] ||
			process.env.PI_OFFLINE
		) {
			return undefined;
		}

		try {
			const response = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
				signal: AbortSignal.timeout(10000),
			});
			if (!response.ok) return undefined;

			const data = (await response.json()) as { version?: string };
			const latestVersion = data.version;

			if (latestVersion && latestVersion !== this.version) {
				return latestVersion;
			}

			return undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Get changelog entries to display on startup.
	 * Only shows new entries since last seen version, skips for resumed sessions.
	 */
	private getChangelogForDisplay(): string | undefined {
		// Skip changelog for resumed/continued sessions (already have messages)
		if (this.session.state.messages.length > 0) {
			return undefined;
		}

		const lastVersion = this.settingsManager.getLastChangelogVersion();
		const changelogPath = getChangelogPath();
		const entries = parseChangelog(changelogPath);

		if (!lastVersion) {
			// Fresh install - just record the version, don't show changelog
			this.settingsManager.setLastChangelogVersion(VERSION);
			return undefined;
		} else {
			const newEntries = getNewEntries(entries, lastVersion);
			if (newEntries.length > 0) {
				this.settingsManager.setLastChangelogVersion(VERSION);
				return newEntries.map((e) => e.content).join("\n\n");
			}
		}

		return undefined;
	}

	private getMarkdownThemeWithSettings(): MarkdownTheme {
		return {
			...getMarkdownTheme(),
			codeBlockIndent: this.settingsManager.getCodeBlockIndent(),
		};
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	private formatDisplayPath(p: string): string {
		const home = os.homedir();
		let result = p;

		// Replace home directory with ~
		if (result.startsWith(home)) {
			result = `~${result.slice(home.length)}`;
		}

		return result;
	}

	/**
	 * Get a short path relative to the package root for display.
	 */
	private getShortPath(fullPath: string, source: string): string {
		// For npm packages, show path relative to node_modules/pkg/
		const npmMatch = fullPath.match(/node_modules\/(@?[^/]+(?:\/[^/]+)?)\/(.*)/);
		if (npmMatch && source.startsWith("npm:")) {
			return npmMatch[2];
		}

		// For git packages, show path relative to repo root
		const gitMatch = fullPath.match(/git\/[^/]+\/[^/]+\/(.*)/);
		if (gitMatch && source.startsWith("git:")) {
			return gitMatch[1];
		}

		// For local/auto, just use formatDisplayPath
		return this.formatDisplayPath(fullPath);
	}

	private getDisplaySourceInfo(
		source: string,
		scope: string,
	): { label: string; scopeLabel?: string; color: "accent" | "muted" } {
		if (source === "local") {
			if (scope === "user") {
				return { label: "user", color: "muted" };
			}
			if (scope === "project") {
				return { label: "project", color: "muted" };
			}
			if (scope === "temporary") {
				return { label: "path", scopeLabel: "temp", color: "muted" };
			}
			return { label: "path", color: "muted" };
		}

		if (source === "cli") {
			return { label: "path", scopeLabel: scope === "temporary" ? "temp" : undefined, color: "muted" };
		}

		const scopeLabel =
			scope === "user" ? "user" : scope === "project" ? "project" : scope === "temporary" ? "temp" : undefined;
		return { label: source, scopeLabel, color: "accent" };
	}

	private getScopeGroup(source: string, scope: string): "user" | "project" | "path" {
		if (source === "cli" || scope === "temporary") return "path";
		if (scope === "user") return "user";
		if (scope === "project") return "project";
		return "path";
	}

	private isPackageSource(source: string): boolean {
		return source.startsWith("npm:") || source.startsWith("git:");
	}

	private buildScopeGroups(
		paths: string[],
		metadata: Map<string, { source: string; scope: string; origin: string }>,
	): Array<{ scope: "user" | "project" | "path"; paths: string[]; packages: Map<string, string[]> }> {
		const groups: Record<
			"user" | "project" | "path",
			{ scope: "user" | "project" | "path"; paths: string[]; packages: Map<string, string[]> }
		> = {
			user: { scope: "user", paths: [], packages: new Map() },
			project: { scope: "project", paths: [], packages: new Map() },
			path: { scope: "path", paths: [], packages: new Map() },
		};

		for (const p of paths) {
			const meta = this.findMetadata(p, metadata);
			const source = meta?.source ?? "local";
			const scope = meta?.scope ?? "project";
			const groupKey = this.getScopeGroup(source, scope);
			const group = groups[groupKey];

			if (this.isPackageSource(source)) {
				const list = group.packages.get(source) ?? [];
				list.push(p);
				group.packages.set(source, list);
			} else {
				group.paths.push(p);
			}
		}

		return [groups.project, groups.user, groups.path].filter(
			(group) => group.paths.length > 0 || group.packages.size > 0,
		);
	}

	private formatScopeGroups(
		groups: Array<{ scope: "user" | "project" | "path"; paths: string[]; packages: Map<string, string[]> }>,
		options: {
			formatPath: (p: string) => string;
			formatPackagePath: (p: string, source: string) => string;
		},
	): string {
		const lines: string[] = [];

		for (const group of groups) {
			lines.push(`  ${theme.fg("accent", group.scope)}`);

			const sortedPaths = [...group.paths].sort((a, b) => a.localeCompare(b));
			for (const p of sortedPaths) {
				lines.push(theme.fg("dim", `    ${options.formatPath(p)}`));
			}

			const sortedPackages = Array.from(group.packages.entries()).sort(([a], [b]) => a.localeCompare(b));
			for (const [source, paths] of sortedPackages) {
				lines.push(`    ${theme.fg("mdLink", source)}`);
				const sortedPackagePaths = [...paths].sort((a, b) => a.localeCompare(b));
				for (const p of sortedPackagePaths) {
					lines.push(theme.fg("dim", `      ${options.formatPackagePath(p, source)}`));
				}
			}
		}

		return lines.join("\n");
	}

	/**
	 * Find metadata for a path, checking parent directories if exact match fails.
	 * Package manager stores metadata for directories, but we display file paths.
	 */
	private findMetadata(
		p: string,
		metadata: Map<string, { source: string; scope: string; origin: string }>,
	): { source: string; scope: string; origin: string } | undefined {
		// Try exact match first
		const exact = metadata.get(p);
		if (exact) return exact;

		// Try parent directories (package manager stores directory paths)
		let current = p;
		while (current.includes("/")) {
			current = current.substring(0, current.lastIndexOf("/"));
			const parent = metadata.get(current);
			if (parent) return parent;
		}

		return undefined;
	}

	/**
	 * Format a path with its source/scope info from metadata.
	 */
	private formatPathWithSource(
		p: string,
		metadata: Map<string, { source: string; scope: string; origin: string }>,
	): string {
		const meta = this.findMetadata(p, metadata);
		if (meta) {
			const shortPath = this.getShortPath(p, meta.source);
			const { label, scopeLabel } = this.getDisplaySourceInfo(meta.source, meta.scope);
			const labelText = scopeLabel ? `${label} (${scopeLabel})` : label;
			return `${labelText} ${shortPath}`;
		}
		return this.formatDisplayPath(p);
	}

	/**
	 * Format resource diagnostics with nice collision display using metadata.
	 */
	private formatDiagnostics(
		diagnostics: readonly ResourceDiagnostic[],
		metadata: Map<string, { source: string; scope: string; origin: string }>,
	): string {
		const lines: string[] = [];

		// Group collision diagnostics by name
		const collisions = new Map<string, ResourceDiagnostic[]>();
		const otherDiagnostics: ResourceDiagnostic[] = [];

		for (const d of diagnostics) {
			if (d.type === "collision" && d.collision) {
				const list = collisions.get(d.collision.name) ?? [];
				list.push(d);
				collisions.set(d.collision.name, list);
			} else {
				otherDiagnostics.push(d);
			}
		}

		// Format collision diagnostics grouped by name
		for (const [name, collisionList] of collisions) {
			const first = collisionList[0]?.collision;
			if (!first) continue;
			lines.push(theme.fg("warning", `  "${name}" collision:`));
			// Show winner
			lines.push(
				theme.fg("dim", `    ${theme.fg("success", "✓")} ${this.formatPathWithSource(first.winnerPath, metadata)}`),
			);
			// Show all losers
			for (const d of collisionList) {
				if (d.collision) {
					lines.push(
						theme.fg(
							"dim",
							`    ${theme.fg("warning", "✗")} ${this.formatPathWithSource(d.collision.loserPath, metadata)} (skipped)`,
						),
					);
				}
			}
		}

		// Format other diagnostics (skill name collisions, parse errors, etc.)
		for (const d of otherDiagnostics) {
			if (d.path) {
				// Use metadata-aware formatting for paths
				const sourceInfo = this.formatPathWithSource(d.path, metadata);
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${sourceInfo}`));
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `    ${d.message}`));
			} else {
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${d.message}`));
			}
		}

		return lines.join("\n");
	}

	private showLoadedResources(options?: {
		extensionPaths?: string[];
		force?: boolean;
		showDiagnosticsWhenQuiet?: boolean;
	}): void {
		const showListing = options?.force || this.options.verbose || !this.settingsManager.getQuietStartup();
		const showDiagnostics = showListing || options?.showDiagnosticsWhenQuiet === true;
		if (!showListing && !showDiagnostics) {
			return;
		}

		const metadata = this.session.resourceLoader.getPathMetadata();
		const sectionHeader = (name: string, color: ThemeColor = "mdHeading") => theme.fg(color, `[${name}]`);

		const skillsResult = this.session.resourceLoader.getSkills();
		const promptsResult = this.session.resourceLoader.getPrompts();
		const themesResult = this.session.resourceLoader.getThemes();
		const contextFiles = this.session.resourceLoader.getAgentsFiles().agentsFiles.filter((file) => {
			const normalized = file.path.replace(/\\/g, "/");
			const isIosmPlaybook = normalized.endsWith("/IOSM.md");
			const isAgentsPlaybook = normalized.endsWith("/AGENTS.md");
			if (!isIosmPlaybook && !isAgentsPlaybook) return true;
			return this.activeProfileName === "iosm" ? isIosmPlaybook : isAgentsPlaybook;
		});
		const loadedThemes = themesResult.themes;
		const customThemes = loadedThemes.filter((t) => t.sourcePath);
		const extensionPaths = options?.extensionPaths ?? [];

		if (showListing) {
			const summaryParts = [];
			if (contextFiles.length > 0) summaryParts.push(theme.fg("accent", `${contextFiles.length} context`));
			if (skillsResult.skills.length > 0) summaryParts.push(theme.fg("accent", `${skillsResult.skills.length} skills`));
			if (this.session.promptTemplates.length > 0) {
				summaryParts.push(theme.fg("accent", `${this.session.promptTemplates.length} prompts`));
			}
			if (extensionPaths.length > 0) summaryParts.push(theme.fg("accent", `${extensionPaths.length} extensions`));
			if (customThemes.length > 0) summaryParts.push(theme.fg("accent", `${customThemes.length} themes`));
			if (summaryParts.length > 0) {
				// Build compact resource block: summary + inline items
				const lines: string[] = [];
				lines.push(
					`${theme.fg("dim", "resources")}  ${summaryParts.join(theme.fg("dim", " · "))}`,
				);

				// Context: show file basenames inline
				if (contextFiles.length > 0) {
					const names = contextFiles.map((f) => theme.fg("dim", this.formatDisplayPath(f.path)));
					lines.push(`  ${theme.fg("muted", "ctx")}  ${names.join(theme.fg("dim", ", "))}`);
				}

				// Skills: show file basenames inline
				if (skillsResult.skills.length > 0) {
					const names = skillsResult.skills.map((s) => {
						const parts = s.filePath.replace(/\\/g, "/").split("/");
						// Use the parent directory name as skill name (directory before SKILL.md)
						const skillDir = parts[parts.length - 2] || parts[parts.length - 1];
						return theme.fg("dim", skillDir);
					});
					lines.push(`  ${theme.fg("muted", "ski")}  ${names.join(theme.fg("dim", ", "))}`);
				}

				// Prompts: show command names inline
				if (this.session.promptTemplates.length > 0) {
					const names = this.session.promptTemplates.map((t) => theme.fg("dim", `/${t.name}`));
					lines.push(`  ${theme.fg("muted", "cmd")}  ${names.join(theme.fg("dim", ", "))}`);
				}

				// Extensions: show basenames inline
				if (extensionPaths.length > 0) {
					const names = extensionPaths.map((p) => theme.fg("dim", this.formatDisplayPath(p)));
					lines.push(`  ${theme.fg("muted", "ext")}  ${names.join(theme.fg("dim", ", "))}`);
				}

				this.chatContainer.addChild(new Spacer(1));
				this.chatContainer.addChild(new Text(lines.join("\n"), 0, 0));
			}
		}

		if (showDiagnostics) {
			const skillDiagnostics = skillsResult.diagnostics;
			if (skillDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(skillDiagnostics, metadata);
				this.chatContainer.addChild(new Text(`${theme.fg("warning", "[Skill conflicts]")}\n${warningLines}`, 0, 0));
				this.chatContainer.addChild(new Spacer(1));
			}

			const promptDiagnostics = promptsResult.diagnostics;
			if (promptDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(promptDiagnostics, metadata);
				this.chatContainer.addChild(
					new Text(`${theme.fg("warning", "[Prompt conflicts]")}\n${warningLines}`, 0, 0),
				);
				this.chatContainer.addChild(new Spacer(1));
			}

			const extensionDiagnostics: ResourceDiagnostic[] = [];
			const extensionErrors = this.session.resourceLoader.getExtensions().errors;
			if (extensionErrors.length > 0) {
				for (const error of extensionErrors) {
					extensionDiagnostics.push({ type: "error", message: error.error, path: error.path });
				}
			}

			const commandDiagnostics = this.session.extensionRunner?.getCommandDiagnostics() ?? [];
			extensionDiagnostics.push(...commandDiagnostics);

			const shortcutDiagnostics = this.session.extensionRunner?.getShortcutDiagnostics() ?? [];
			extensionDiagnostics.push(...shortcutDiagnostics);

			if (extensionDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(extensionDiagnostics, metadata);
				this.chatContainer.addChild(
					new Text(`${theme.fg("warning", "[Extension issues]")}\n${warningLines}`, 0, 0),
				);
				this.chatContainer.addChild(new Spacer(1));
			}

			const themeDiagnostics = themesResult.diagnostics;
			if (themeDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(themeDiagnostics, metadata);
				this.chatContainer.addChild(new Text(`${theme.fg("warning", "[Theme conflicts]")}\n${warningLines}`, 0, 0));
				this.chatContainer.addChild(new Spacer(1));
			}
		}
	}

	/**
	 * Initialize the extension system with TUI-based UI context.
	 */
	private async initExtensions(): Promise<void> {
		const uiContext = this.createExtensionUIContext();
		await this.session.bindExtensions({
			uiContext,
			commandContextActions: {
				waitForIdle: () => this.session.agent.waitForIdle(),
				newSession: async (options) => {
					if (this.loadingAnimation) {
						this.loadingAnimation.stop();
						this.loadingAnimation = undefined;
					}
					this.statusContainer.clear();

					// Delegate to AgentSession (handles setup + agent state sync)
					const success = await this.session.newSession(options);
					if (!success) {
						return { cancelled: true };
					}

					// Clear UI state
					this.chatContainer.clear();
					this.pendingMessagesContainer.clear();
					this.compactionQueuedMessages = [];
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
					this.pendingTools.clear();

					// Render any messages added via setup, or show empty session
					this.renderInitialMessages();
					this.ui.requestRender();

					return { cancelled: false };
				},
				fork: async (entryId) => {
					const result = await this.session.fork(entryId);
					if (result.cancelled) {
						return { cancelled: true };
					}

					this.chatContainer.clear();
					this.renderInitialMessages();
					this.editor.setText(result.selectedText);
					this.showStatus("Forked to new session");

					return { cancelled: false };
				},
				navigateTree: async (targetId, options) => {
					const result = await this.session.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					if (result.cancelled) {
						return { cancelled: true };
					}

					this.chatContainer.clear();
					this.renderInitialMessages();
					if (result.editorText && !this.editor.getText().trim()) {
						this.editor.setText(result.editorText);
					}
					this.showStatus("Navigated to selected point");

					return { cancelled: false };
				},
				switchSession: async (sessionPath) => {
					await this.handleResumeSession(sessionPath);
					return { cancelled: false };
				},
				reload: async () => {
					await this.handleReloadCommand();
				},
			},
			shutdownHandler: () => {
				this.shutdownRequested = true;
				if (!this.session.isStreaming) {
					void this.shutdown();
				}
			},
			onError: (error) => {
				this.showExtensionError(error.extensionPath, error.error, error.stack);
			},
		});

		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		this.setupAutocomplete(this.fdPath);

		const extensionRunner = this.session.extensionRunner;
		if (!extensionRunner) {
			this.showLoadedResources({ extensionPaths: [], force: false });
			return;
		}

		this.setupExtensionShortcuts(extensionRunner);
		this.showLoadedResources({ extensionPaths: extensionRunner.getExtensionPaths(), force: false });
	}

	/**
	 * Get a registered tool definition by name (for custom rendering).
	 */
	private getRegisteredToolDefinition(toolName: string) {
		const tools = this.session.extensionRunner?.getAllRegisteredTools() ?? [];
		const registeredTool = tools.find((t) => t.definition.name === toolName);
		return registeredTool?.definition;
	}

	/**
	 * Set up keyboard shortcuts registered by extensions.
	 */
	private setupExtensionShortcuts(extensionRunner: ExtensionRunner): void {
		const shortcuts = extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig());
		if (shortcuts.size === 0) return;

		// Create a context for shortcut handlers
		const createContext = (): ExtensionContext => ({
			ui: this.createExtensionUIContext(),
			hasUI: true,
			cwd: process.cwd(),
			sessionManager: this.sessionManager,
			modelRegistry: this.session.modelRegistry,
			model: this.session.model,
			isIdle: () => !this.session.isStreaming,
			abort: () => this.session.abort(),
			hasPendingMessages: () => this.session.pendingMessageCount > 0,
			shutdown: () => {
				this.shutdownRequested = true;
			},
			getContextUsage: () => this.session.getContextUsage(),
			compact: (options) => {
				void (async () => {
					try {
						const result = await this.executeCompaction(options?.customInstructions, false);
						if (result) {
							options?.onComplete?.(result);
						}
					} catch (error) {
						const err = error instanceof Error ? error : new Error(String(error));
						options?.onError?.(err);
					}
				})();
			},
			getSystemPrompt: () => this.session.systemPrompt,
		});

		// Set up the extension shortcut handler on the default editor
		this.defaultEditor.onExtensionShortcut = (data: string) => {
			for (const [shortcutStr, shortcut] of shortcuts) {
				// Cast to KeyId - extension shortcuts use the same format
				if (matchesKey(data, shortcutStr as KeyId)) {
					// Run handler async, don't block input
					Promise.resolve(shortcut.handler(createContext())).catch((err) => {
						this.showError(`Shortcut handler error: ${err instanceof Error ? err.message : String(err)}`);
					});
					return true;
				}
			}
			return false;
		};
	}

	/**
	 * Set extension status text in the footer.
	 */
	private setExtensionStatus(key: string, text: string | undefined): void {
		this.footerDataProvider.setExtensionStatus(key, text);
		this.ui.requestRender();
	}

	/**
	 * Set an extension widget (string array or custom component).
	 */
	private setExtensionWidget(
		key: string,
		content: string[] | ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined,
		options?: ExtensionWidgetOptions,
	): void {
		const placement = options?.placement ?? "aboveEditor";
		const removeExisting = (map: Map<string, Component & { dispose?(): void }>) => {
			const existing = map.get(key);
			if (existing?.dispose) existing.dispose();
			map.delete(key);
		};

		removeExisting(this.extensionWidgetsAbove);
		removeExisting(this.extensionWidgetsBelow);

		if (content === undefined) {
			this.renderWidgets();
			return;
		}

		let component: Component & { dispose?(): void };

		if (Array.isArray(content)) {
			// Wrap string array in a Container with Text components
			const container = new Container();
			for (const line of content.slice(0, InteractiveMode.MAX_WIDGET_LINES)) {
				container.addChild(new Text(line, 1, 0));
			}
			if (content.length > InteractiveMode.MAX_WIDGET_LINES) {
				container.addChild(new Text(theme.fg("muted", "... (widget truncated)"), 1, 0));
			}
			component = container;
		} else {
			// Factory function - create component
			component = content(this.ui, theme);
		}

		const targetMap = placement === "belowEditor" ? this.extensionWidgetsBelow : this.extensionWidgetsAbove;
		targetMap.set(key, component);
		this.renderWidgets();
	}

	private clearExtensionWidgets(): void {
		for (const widget of this.extensionWidgetsAbove.values()) {
			widget.dispose?.();
		}
		for (const widget of this.extensionWidgetsBelow.values()) {
			widget.dispose?.();
		}
		this.extensionWidgetsAbove.clear();
		this.extensionWidgetsBelow.clear();
		this.renderWidgets();
	}

	private resetExtensionUI(): void {
		if (this.extensionSelector) {
			this.hideExtensionSelector();
		}
		if (this.extensionInput) {
			this.hideExtensionInput();
		}
		if (this.extensionEditor) {
			this.hideExtensionEditor();
		}
		this.ui.hideOverlay();
		this.clearExtensionTerminalInputListeners();
		this.setExtensionFooter(undefined);
		this.setExtensionHeader(undefined);
		this.clearExtensionWidgets();
		this.footerDataProvider.clearExtensionStatuses();
		this.footer.invalidate();
		this.setCustomEditorComponent(undefined);
		this.defaultEditor.onExtensionShortcut = undefined;
		this.updateTerminalTitle();
		if (this.loadingAnimation) {
			this.loadingAnimation.setMessage(
				`${this.defaultWorkingMessage} (${appKey(this.keybindings, "interrupt")} to interrupt)`,
			);
		}
	}

	// Maximum total widget lines to prevent viewport overflow
	private static readonly MAX_WIDGET_LINES = 10;

	/**
	 * Render all extension widgets to the widget container.
	 */
	private renderWidgets(): void {
		if (!this.widgetContainerAbove || !this.widgetContainerBelow) return;
		this.renderWidgetContainer(this.widgetContainerAbove, this.extensionWidgetsAbove, true, true);
		this.renderWidgetContainer(this.widgetContainerBelow, this.extensionWidgetsBelow, false, false);
		this.ui.requestRender();
	}

	private renderWidgetContainer(
		container: Container,
		widgets: Map<string, Component & { dispose?(): void }>,
		spacerWhenEmpty: boolean,
		leadingSpacer: boolean,
	): void {
		container.clear();

		if (widgets.size === 0) {
			if (spacerWhenEmpty) {
				container.addChild(new Spacer(1));
			}
			return;
		}

		if (leadingSpacer) {
			container.addChild(new Spacer(1));
		}
		for (const component of widgets.values()) {
			container.addChild(component);
		}
	}

	/**
	 * Set a custom footer component, or restore the built-in footer.
	 */
	private setExtensionFooter(
		factory:
			| ((tui: TUI, thm: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void })
			| undefined,
	): void {
		// Dispose existing custom footer
		if (this.customFooter?.dispose) {
			this.customFooter.dispose();
		}

		// Remove current footer from UI
		if (this.customFooter) {
			this.ui.removeChild(this.customFooter);
		} else {
			this.ui.removeChild(this.footer);
		}

		if (factory) {
			// Create and add custom footer, passing the data provider
			this.customFooter = factory(this.ui, theme, this.footerDataProvider);
			this.ui.addChild(this.customFooter);
		} else {
			// Restore built-in footer
			this.customFooter = undefined;
			this.ui.addChild(this.footer);
		}

		this.ui.requestRender();
	}

	/**
	 * Set a custom header component, or restore the built-in header.
	 */
	private setExtensionHeader(factory: ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined): void {
		// Header may not be initialized yet if called during early initialization
		if (!this.builtInHeader) {
			return;
		}

		// Dispose existing custom header
		if (this.customHeader?.dispose) {
			this.customHeader.dispose();
		}

		// Find the index of the current header in the header container
		const currentHeader = this.customHeader || this.builtInHeader;
		const index = this.headerContainer.children.indexOf(currentHeader);

		if (factory) {
			// Create and add custom header
			this.customHeader = factory(this.ui, theme);
			if (index !== -1) {
				this.headerContainer.children[index] = this.customHeader;
			} else {
				// If not found (e.g. builtInHeader was never added), add at the top
				this.headerContainer.children.unshift(this.customHeader);
			}
		} else {
			// Restore built-in header
			this.customHeader = undefined;
			if (index !== -1) {
				this.headerContainer.children[index] = this.builtInHeader;
			}
		}

		this.ui.requestRender();
	}

	private addExtensionTerminalInputListener(
		handler: (data: string) => { consume?: boolean; data?: string } | undefined,
	): () => void {
		const unsubscribe = this.ui.addInputListener(handler);
		this.extensionTerminalInputUnsubscribers.add(unsubscribe);
		return () => {
			unsubscribe();
			this.extensionTerminalInputUnsubscribers.delete(unsubscribe);
		};
	}

	private clearExtensionTerminalInputListeners(): void {
		for (const unsubscribe of this.extensionTerminalInputUnsubscribers) {
			unsubscribe();
		}
		this.extensionTerminalInputUnsubscribers.clear();
	}

	/**
	 * Create the ExtensionUIContext for extensions.
	 */
	private createExtensionUIContext(): ExtensionUIContext {
		return {
			select: (title, options, opts) => this.showExtensionSelector(title, options, opts),
			confirm: (title, message, opts) => this.showExtensionConfirm(title, message, opts),
			input: (title, placeholder, opts) => this.showExtensionInput(title, placeholder, opts),
			notify: (message, type) => this.showExtensionNotify(message, type),
			onTerminalInput: (handler) => this.addExtensionTerminalInputListener(handler),
			setStatus: (key, text) => this.setExtensionStatus(key, text),
			setWorkingMessage: (message) => this.setWorkingMessage(message),
			setWidget: (key, content, options) => this.setExtensionWidget(key, content, options),
			setFooter: (factory) => this.setExtensionFooter(factory),
			setHeader: (factory) => this.setExtensionHeader(factory),
			setTitle: (title) => this.ui.terminal.setTitle(title),
			custom: (factory, options) => this.showExtensionCustom(factory, options),
			pasteToEditor: (text) => this.editor.handleInput(`\x1b[200~${text}\x1b[201~`),
			setEditorText: (text) => this.editor.setText(text),
			getEditorText: () => this.editor.getText(),
			editor: (title, prefill) => this.showExtensionEditor(title, prefill),
			setEditorComponent: (factory) => this.setCustomEditorComponent(factory),
			get theme() {
				return theme;
			},
			getAllThemes: () => getAvailableThemesWithPaths(),
			getTheme: (name) => getThemeByName(name),
			setTheme: (themeOrName) => {
				if (themeOrName instanceof Theme) {
					setThemeInstance(themeOrName);
					this.ui.requestRender();
					return { success: true };
				}
				const result = setTheme(themeOrName, true);
				if (result.success) {
					if (this.settingsManager.getTheme() !== themeOrName) {
						this.settingsManager.setTheme(themeOrName);
					}
					this.ui.requestRender();
				}
				return result;
			},
			getToolsExpanded: () => this.toolOutputExpanded,
			setToolsExpanded: (expanded) => this.setToolsExpanded(expanded),
		};
	}

	/**
	 * Show a selector for extensions.
	 */
	private showExtensionSelector(
		title: string,
		options: string[],
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				this.hideExtensionSelector();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.extensionSelector = new ExtensionSelectorComponent(
				title,
				options,
				(option) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionSelector();
					resolve(option);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionSelector();
					resolve(undefined);
				},
				{ tui: this.ui, timeout: opts?.timeout },
			);

			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionSelector);
			this.ui.setFocus(this.extensionSelector);
			this.ui.requestRender();
		});
	}

	/**
	 * Hide the extension selector.
	 */
	private hideExtensionSelector(): void {
		this.extensionSelector?.dispose();
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionSelector = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Show a confirmation dialog for extensions.
	 */
	private async showExtensionConfirm(
		title: string,
		message: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<boolean> {
		const result = await this.showExtensionSelector(`${title}\n${message}`, ["Yes", "No"], opts);
		return result === "Yes";
	}

	/**
	 * Show a text input for extensions.
	 */
	private showExtensionInput(
		title: string,
		placeholder?: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				this.hideExtensionInput();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.extensionInput = new ExtensionInputComponent(
				title,
				placeholder,
				(value) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionInput();
					resolve(value);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionInput();
					resolve(undefined);
				},
				{ tui: this.ui, timeout: opts?.timeout },
			);

			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionInput);
			this.ui.setFocus(this.extensionInput);
			this.ui.requestRender();
		});
	}

	/**
	 * Hide the extension input.
	 */
	private hideExtensionInput(): void {
		this.extensionInput?.dispose();
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionInput = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Show a multi-line editor for extensions (with Ctrl+G support).
	 */
	private showExtensionEditor(title: string, prefill?: string): Promise<string | undefined> {
		return new Promise((resolve) => {
			this.extensionEditor = new ExtensionEditorComponent(
				this.ui,
				this.keybindings,
				title,
				prefill,
				(value) => {
					this.hideExtensionEditor();
					resolve(value);
				},
				() => {
					this.hideExtensionEditor();
					resolve(undefined);
				},
			);

			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionEditor);
			this.ui.setFocus(this.extensionEditor);
			this.ui.requestRender();
		});
	}

	/**
	 * Hide the extension editor.
	 */
	private hideExtensionEditor(): void {
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionEditor = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	/**
	 * Set a custom editor component from an extension.
	 * Pass undefined to restore the default editor.
	 */
	private setCustomEditorComponent(
		factory: ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent) | undefined,
	): void {
		// Save text from current editor before switching
		const currentText = this.editor.getText();

		this.editorContainer.clear();

		if (factory) {
			// Create the custom editor with tui, theme, and keybindings
			const newEditor = factory(this.ui, getEditorTheme(), this.keybindings);

			// Wire up callbacks from the default editor
			newEditor.onSubmit = this.defaultEditor.onSubmit;
			newEditor.onChange = this.defaultEditor.onChange;

			// Copy text from previous editor
			newEditor.setText(currentText);

			// Copy appearance settings if supported
			if (newEditor.borderColor !== undefined) {
				newEditor.borderColor = this.defaultEditor.borderColor;
			}
			if (newEditor.setPaddingX !== undefined) {
				newEditor.setPaddingX(this.defaultEditor.getPaddingX());
			}

			// Set autocomplete if supported
			if (newEditor.setAutocompleteProvider && this.autocompleteProvider) {
				newEditor.setAutocompleteProvider(this.autocompleteProvider);
			}

			// If extending CustomEditor, copy app-level handlers
			// Use duck typing since instanceof fails across jiti module boundaries
			const customEditor = newEditor as unknown as Record<string, unknown>;
			if ("actionHandlers" in customEditor && customEditor.actionHandlers instanceof Map) {
				customEditor.onEscape = () => this.defaultEditor.onEscape?.();
				customEditor.onCtrlD = () => this.defaultEditor.onCtrlD?.();
				customEditor.onPasteImage = () => this.defaultEditor.onPasteImage?.();
				customEditor.onExtensionShortcut = (data: string) => this.defaultEditor.onExtensionShortcut?.(data);
				// Copy action handlers (clear, suspend, model switching, etc.)
				for (const [action, handler] of this.defaultEditor.actionHandlers) {
					(customEditor.actionHandlers as Map<string, () => void>).set(action, handler);
				}
			}

			this.editor = newEditor;
		} else {
			// Restore default editor with text from custom editor
			this.defaultEditor.setText(currentText);
			this.editor = this.defaultEditor;
		}

		this.editorContainer.addChild(this.editor as Component);
		this.ui.setFocus(this.editor as Component);
		this.ui.requestRender();
	}

	/**
	 * Show a notification for extensions.
	 */
	private showExtensionNotify(message: string, type?: "info" | "warning" | "error"): void {
		if (type === "error") {
			this.showError(message);
		} else if (type === "warning") {
			this.showWarning(message);
		} else {
			this.showStatus(message);
		}
	}

	/** Show a custom component with keyboard focus. Overlay mode renders on top of existing content. */
	private async showExtensionCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: {
			overlay?: boolean;
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
			onHandle?: (handle: OverlayHandle) => void;
		},
	): Promise<T> {
		const savedText = this.editor.getText();
		const isOverlay = options?.overlay ?? false;

		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.editor.setText(savedText);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};

		return new Promise((resolve, reject) => {
			let component: Component & { dispose?(): void };
			let closed = false;

			const close = (result: T) => {
				if (closed) return;
				closed = true;
				if (isOverlay) this.ui.hideOverlay();
				else restoreEditor();
				// Note: both branches above already call requestRender
				resolve(result);
				try {
					component?.dispose?.();
				} catch {
					/* ignore dispose errors */
				}
			};

			Promise.resolve(factory(this.ui, theme, this.keybindings, close))
				.then((c) => {
					if (closed) return;
					component = c;
					if (isOverlay) {
						// Resolve overlay options - can be static or dynamic function
						const resolveOptions = (): OverlayOptions | undefined => {
							if (options?.overlayOptions) {
								const opts =
									typeof options.overlayOptions === "function"
										? options.overlayOptions()
										: options.overlayOptions;
								return opts;
							}
							// Fallback: use component's width property if available
							const w = (component as { width?: number }).width;
							return w ? { width: w } : undefined;
						};
						const handle = this.ui.showOverlay(component, resolveOptions());
						// Expose handle to caller for visibility control
						options?.onHandle?.(handle);
					} else {
						this.editorContainer.clear();
						this.editorContainer.addChild(component);
						this.ui.setFocus(component);
						this.ui.requestRender();
					}
				})
				.catch((err) => {
					if (closed) return;
					if (!isOverlay) restoreEditor();
					reject(err);
				});
		});
	}

	/**
	 * Show an extension error in the UI.
	 */
	private showExtensionError(extensionPath: string, error: string, stack?: string): void {
		const errorMsg = `Extension "${extensionPath}" error: ${error}`;
		const errorText = new Text(theme.fg("error", errorMsg), 1, 0);
		this.chatContainer.addChild(errorText);
		if (stack) {
			// Show stack trace in dim color, indented
			const stackLines = stack
				.split("\n")
				.slice(1) // Skip first line (duplicates error message)
				.map((line) => theme.fg("dim", `  ${line.trim()}`))
				.join("\n");
			if (stackLines) {
				this.chatContainer.addChild(new Text(stackLines, 1, 0));
			}
		}
		this.ui.requestRender();
	}

	// =========================================================================
	// Key Handlers
	// =========================================================================

	private setupKeyHandlers(): void {
		// Set up handlers on defaultEditor - they use this.editor for text access
		// so they work correctly regardless of which editor is active
		this.defaultEditor.onEscape = () => {
			const queuedMessages = this.getAllQueuedMessages();
			const queuedMeta = queuedMessages.meta ?? [];
			const hasInterruptibleWork =
				this.session.isStreaming ||
				this.session.isBashRunning ||
				this.session.isCompacting ||
				this.session.isRetrying ||
				this.iosmAutomationRun !== undefined ||
				this.iosmVerificationSession !== undefined ||
				queuedMessages.steering.length > 0 ||
				queuedMessages.followUp.length > 0 ||
				queuedMeta.length > 0;

			if (hasInterruptibleWork) {
				void this.interruptCurrentWork();
			} else if (this.isBashMode) {
				this.editor.setText("");
				this.isBashMode = false;
				this.updateEditorBorderColor();
			} else if (!this.editor.getText().trim()) {
				// Double-escape with empty editor triggers /tree, /fork, or nothing based on setting
				const action = this.settingsManager.getDoubleEscapeAction();
				if (action !== "none") {
					const now = Date.now();
					if (now - this.lastEscapeTime < 500) {
						if (action === "tree") {
							this.showTreeSelector();
						} else {
							this.showUserMessageSelector();
						}
						this.lastEscapeTime = 0;
					} else {
						this.lastEscapeTime = now;
					}
				}
			}
		};

		// Register app action handlers
		this.defaultEditor.onAction("clear", () => this.handleCtrlC());
		this.defaultEditor.onCtrlD = () => this.handleCtrlD();
		this.defaultEditor.onAction("suspend", () => this.handleCtrlZ());
		this.defaultEditor.onAction("cycleProfile", () => this.cycleProfile("forward"));
		this.defaultEditor.onAction("cycleThinkingLevel", () => this.cycleThinkingLevel());
		this.defaultEditor.onAction("cycleModelForward", () => this.cycleModel("forward"));
		this.defaultEditor.onAction("cycleModelBackward", () => this.cycleModel("backward"));

		// Global debug handler on TUI (works regardless of focus)
		this.ui.onDebug = () => this.handleDebugCommand();
		this.defaultEditor.onAction("selectModel", () => {
			void this.showModelProviderSelector();
		});
		this.defaultEditor.onAction("expandTools", () => this.toggleToolOutputExpansion());
		this.defaultEditor.onAction("toggleThinking", () => this.toggleThinkingBlockVisibility());
		this.defaultEditor.onAction("externalEditor", () => this.openExternalEditor());
		this.defaultEditor.onAction("steer", () => this.handleSteer());
		this.defaultEditor.onAction("followUp", () => this.handleFollowUp());
		this.defaultEditor.onAction("dequeue", () => this.handleDequeue());
		this.defaultEditor.onAction("newSession", () => this.handleClearCommand());
		this.defaultEditor.onAction("tree", () => this.showTreeSelector());
		this.defaultEditor.onAction("fork", () => this.showUserMessageSelector());
		this.defaultEditor.onAction("resume", () => this.showSessionSelector());

		this.defaultEditor.onChange = (text: string) => {
			const wasBashMode = this.isBashMode;
			this.isBashMode = text.trimStart().startsWith("!");
			if (wasBashMode !== this.isBashMode) {
				this.updateEditorBorderColor();
			}
		};

		// Handle clipboard image paste (triggered on Ctrl+V)
		this.defaultEditor.onPasteImage = () => {
			this.handleClipboardImagePaste();
		};
	}

	private async handleClipboardImagePaste(): Promise<void> {
		try {
			const image = await readClipboardImage();
			if (!image) {
				return;
			}

			// Write to temp file
			const tmpDir = os.tmpdir();
			const ext = extensionForImageMimeType(image.mimeType) ?? "png";
			const fileName = `iosm-clipboard-${crypto.randomUUID()}.${ext}`;
			const filePath = path.join(tmpDir, fileName);
			fs.writeFileSync(filePath, Buffer.from(image.bytes));

			// Insert file path directly
			this.editor.insertTextAtCursor?.(filePath);
			this.ui.requestRender();
		} catch {
			// Silently ignore clipboard errors (may not have permission, etc.)
		}
	}

	private setupEditorSubmitHandler(): void {
		this.defaultEditor.onSubmit = async (text: string) => {
			text = text.trim();
			if (!text) return;

			// Handle commands
			if (text === "/init" || text.startsWith("/init ")) {
				this.editor.setText("");
				await this.handleIosmInitSlashCommand(text);
				return;
			}
			if (text === "/iosm" || text.startsWith("/iosm ")) {
				this.editor.setText("");
				await this.handleIosmAutomationSlashCommand(text);
				return;
			}
			if (text === "/orchestrate" || text.startsWith("/orchestrate ")) {
				this.editor.setText("");
				await this.handleOrchestrateSlashCommand(text);
				return;
			}
			if (text === "/agents" || text.startsWith("/agents ")) {
				this.editor.setText("");
				await this.handleAgentsSlashCommand(text);
				return;
			}
			if (text === "/subagent-runs" || text.startsWith("/subagent-runs ")) {
				this.editor.setText("");
				this.handleSubagentRunsSlashCommand(text);
				return;
			}
			if (text === "/subagent-resume" || text.startsWith("/subagent-resume ")) {
				this.editor.setText("");
				await this.handleSubagentResumeSlashCommand(text);
				return;
			}
			if (text === "/team-runs" || text.startsWith("/team-runs ")) {
				this.editor.setText("");
				this.handleTeamRunsSlashCommand(text);
				return;
			}
			if (text === "/team-status" || text.startsWith("/team-status ")) {
				this.editor.setText("");
				await this.handleTeamStatusSlashCommand(text);
				return;
			}
			if (text === "/cycle-list") {
				this.editor.setText("");
				this.handleIosmCycleListSlashCommand();
				return;
			}
			if (text === "/cycle-plan" || text.startsWith("/cycle-plan ")) {
				this.editor.setText("");
				await this.handleIosmCyclePlanSlashCommand(text);
				return;
			}
			if (text === "/cycle-report" || text.startsWith("/cycle-report ")) {
				this.editor.setText("");
				await this.handleIosmCycleReportSlashCommand(text);
				return;
			}
			if (text === "/cycle-status" || text.startsWith("/cycle-status ")) {
				this.editor.setText("");
				await this.handleIosmCycleStatusSlashCommand(text);
				return;
			}
			if (text === "/mcp" || text.startsWith("/mcp ")) {
				this.editor.setText("");
				await this.handleMcpSlashCommand(text);
				return;
			}
			if (text === "/memory" || text.startsWith("/memory ")) {
				this.editor.setText("");
				await this.handleMemoryCommand(text);
				return;
			}
			if (text === "/settings") {
				this.showSettingsSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/permissions" || text.startsWith("/permissions ")) {
				this.editor.setText("");
				await this.handlePermissionsCommand(text);
				return;
			}
			if (text === "/yolo" || text.startsWith("/yolo ")) {
				this.editor.setText("");
				this.handleYoloCommand(text);
				return;
			}
			if (text === "/scoped-models") {
				this.editor.setText("");
				await this.showModelsSelector();
				return;
			}
			if (text === "/model" || text.startsWith("/model ")) {
				const searchTerm = text.startsWith("/model ") ? text.slice(7).trim() : undefined;
				this.editor.setText("");
				await this.handleModelCommand(searchTerm);
				return;
			}
			if (text.startsWith("/export")) {
				await this.handleExportCommand(text);
				this.editor.setText("");
				return;
			}
			if (text === "/share") {
				await this.handleShareCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/copy") {
				this.handleCopyCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/name" || text.startsWith("/name ")) {
				this.handleNameCommand(text);
				this.editor.setText("");
				return;
			}
			if (text === "/session") {
				this.handleSessionCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/doctor" || text.startsWith("/doctor ")) {
				this.editor.setText("");
				await this.handleDoctorCommand(text);
				return;
			}
			if (text === "/checkpoint" || text.startsWith("/checkpoint ")) {
				this.editor.setText("");
				this.handleCheckpointCommand(text);
				return;
			}
			if (text === "/rollback" || text.startsWith("/rollback ")) {
				this.editor.setText("");
				await this.handleRollbackCommand(text);
				return;
			}
			if (text === "/changelog") {
				this.handleChangelogCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/hotkeys") {
				this.handleHotkeysCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/fork") {
				this.showUserMessageSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/tree") {
				this.showTreeSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/login" || text === "/auth" || text.startsWith("/auth ")) {
				this.showOAuthSelector("login");
				this.editor.setText("");
				return;
			}
			if (text === "/logout") {
				this.showOAuthSelector("logout");
				this.editor.setText("");
				return;
			}
			if (text === "/new" || text === "/clear" || text.startsWith("/clear ")) {
				this.editor.setText("");
				await this.handleClearCommand();
				return;
			}
			if (text === "/compact" || text.startsWith("/compact ")) {
				const customInstructions = text.startsWith("/compact ") ? text.slice(9).trim() : undefined;
				this.editor.setText("");
				await this.handleCompactCommand(customInstructions);
				return;
			}
			if (text === "/reload") {
				this.editor.setText("");
				await this.handleReloadCommand();
				return;
			}
			if (text === "/debug") {
				this.handleDebugCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/arminsayshi") {
				this.handleArminSaysHi();
				this.editor.setText("");
				return;
			}
			if (text === "/resume") {
				this.showSessionSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/quit") {
				this.editor.setText("");
				await this.shutdown();
				return;
			}

			// Soft first-run gate: require model selection before normal chat/bash input.
			// Slash commands remain available so the user can run /model, /login, /init, etc.
			if (!this.session.model && !text.startsWith("/")) {
				this.showWarning("Select a model first with /model (or configure auth with /login).");
				await this.showModelProviderSelector();
				this.editor.setText("");
				return;
			}

			// Handle bash command (! for normal, !! for excluded from context)
			if (text.startsWith("!")) {
				const isExcluded = text.startsWith("!!");
				const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
				if (command) {
					if (this.session.isBashRunning) {
						this.showWarning("A bash command is already running. Press Esc to cancel it first.");
						this.editor.setText(text);
						return;
					}
					this.editor.addToHistory?.(text);
					await this.handleBashCommand(command, isExcluded);
					this.isBashMode = false;
					this.updateEditorBorderColor();
					return;
				}
			}

			// Queue input during compaction (extension commands execute immediately)
			if (this.session.isCompacting) {
				if (this.isExtensionCommand(text)) {
					this.editor.addToHistory?.(text);
					this.editor.setText("");
					await this.session.prompt(text);
				} else {
					this.queueCompactionMessage(text, this.session.streamInputMode);
				}
				return;
			}

			// If streaming, use configured stream input mode (meta/followUp/steer)
			// This handles extension commands (execute immediately), prompt template expansion, and queueing
			if (this.session.isStreaming) {
				this.editor.addToHistory?.(text);
				this.editor.setText("");
				await this.session.prompt(text, { streamingBehavior: this.session.streamInputMode });
				this.updatePendingMessagesDisplay();
				this.ui.requestRender();
				return;
			}

			// Normal message submission
			// First, move any pending bash components to chat
			this.flushPendingBashComponents();

			if (this.onInputCallback) {
				this.onInputCallback(text);
			}
			this.editor.addToHistory?.(text);
		};
	}

	private subscribeToAgent(): void {
		this.unsubscribe = this.session.subscribe(async (event) => {
			await this.handleEvent(event);
		});
	}

	private async handleEvent(event: AgentSessionEvent): Promise<void> {
		if (!this.isInitialized) {
			await this.init();
		}

		this.footer.invalidate();

		switch (event.type) {
			case "agent_start":
				// Restore main escape handler if retry handler is still active
				// (retry success event fires later, but we need main handler now)
				if (this.retryEscapeHandler) {
					this.defaultEditor.onEscape = this.retryEscapeHandler;
					this.retryEscapeHandler = undefined;
				}
				if (this.retryLoader) {
					this.retryLoader.stop();
					this.retryLoader = undefined;
				}
				if (this.loadingAnimation) {
					this.loadingAnimation.stop();
				}
				this.statusContainer.clear();
				this.loadingAnimation = new DecryptLoader(
					this.ui,
					(spinner) => theme.fg("accent", spinner),
					(text) => theme.fg("muted", text),
					this.defaultWorkingMessage,
				);
				this.statusContainer.addChild(this.loadingAnimation);
				// Apply any pending working message queued before loader existed
				if (this.pendingWorkingMessage !== undefined) {
					if (this.pendingWorkingMessage) {
						this.loadingAnimation.setMessage(this.pendingWorkingMessage);
					}
					this.pendingWorkingMessage = undefined;
				}
				this.ui.requestRender();
				break;

			case "message_start":
				if (event.message.role === "custom") {
					this.addMessageToChat(event.message);
					this.ui.requestRender();
				} else if (event.message.role === "user") {
					this.addMessageToChat(event.message);
					this.updatePendingMessagesDisplay();
					this.ui.requestRender();
				} else if (event.message.role === "assistant") {
					this.activeAssistantOrchestrationContext = this.pendingAssistantOrchestrationContexts > 0;
					if (this.activeAssistantOrchestrationContext) {
						this.pendingAssistantOrchestrationContexts -= 1;
					}
					this.streamingComponent = new AssistantMessageComponent(
						undefined,
						this.hideThinkingBlock,
						this.getMarkdownThemeWithSettings(),
					);
					this.streamingMessage = event.message;
					this.chatContainer.addChild(this.streamingComponent);
					this.streamingComponent.updateContent(this.sanitizeAssistantDisplayMessage(this.streamingMessage));
					this.ui.requestRender();
				}
				break;

			case "message_update":
				if (this.streamingComponent && event.message.role === "assistant") {
					this.streamingMessage = event.message;
					this.streamingComponent.updateContent(this.sanitizeAssistantDisplayMessage(this.streamingMessage));

					for (const content of this.streamingMessage.content) {
						if (content.type === "toolCall") {
							if (content.name === "task") {
								const staleTaskComponent = this.pendingTools.get(content.id);
								if (staleTaskComponent) {
									this.chatContainer.removeChild(staleTaskComponent);
									this.pendingTools.delete(content.id);
								}
								continue;
							}
							if (!this.pendingTools.has(content.id)) {
								const component = new ToolExecutionComponent(
									content.name,
									content.arguments,
									{
										showImages: this.settingsManager.getShowImages(),
									},
									this.getRegisteredToolDefinition(content.name),
									this.ui,
								);
								component.setExpanded(this.toolOutputExpanded);
								this.chatContainer.addChild(component);
								this.pendingTools.set(content.id, component);
							} else {
								const component = this.pendingTools.get(content.id);
								if (component) {
									component.updateArgs(content.arguments);
								}
							}
						}
					}
					this.ui.requestRender();
				}
				break;

			case "message_end":
				if (event.message.role === "user") break;
				if (this.streamingComponent && event.message.role === "assistant") {
					this.streamingMessage = event.message;
					let errorMessage: string | undefined;
					if (this.streamingMessage.stopReason === "aborted") {
						const retryAttempt = this.session.retryAttempt;
						errorMessage =
							retryAttempt > 0
								? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
								: "Operation aborted";
						this.streamingMessage.errorMessage = errorMessage;
					}
					this.streamingComponent.updateContent(this.sanitizeAssistantDisplayMessage(this.streamingMessage));

					if (this.streamingMessage.stopReason === "aborted" || this.streamingMessage.stopReason === "error") {
						if (!errorMessage) {
							errorMessage = this.streamingMessage.errorMessage || "Error";
						}
						for (const [, component] of this.pendingTools.entries()) {
							component.updateResult({
								content: [{ type: "text", text: errorMessage }],
								isError: true,
							});
						}
						this.pendingTools.clear();
					} else {
						// Args are now complete - trigger diff computation for edit tools
						for (const [, component] of this.pendingTools.entries()) {
							component.setArgsComplete();
						}
					}
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
					this.activeAssistantOrchestrationContext = false;
					this.footer.invalidate();
				}
				this.ui.requestRender();
				break;

			case "tool_execution_start": {
				if (event.toolName === "task" && !this.subagentComponents.has(event.toolCallId)) {
					const staleTaskComponent = this.pendingTools.get(event.toolCallId);
					if (staleTaskComponent) {
						this.chatContainer.removeChild(staleTaskComponent);
						this.pendingTools.delete(event.toolCallId);
					}
					const args = event.args as {
						description?: string;
						profile?: string;
						prompt?: string;
						cwd?: string;
						lock_key?: string;
						agent?: string;
						isolation?: "none" | "worktree";
					};
					const description = args.description ?? "Running subtask";
					const info: SubagentInfo = {
						description,
						profile: args.profile ?? "explore",
						status: "running",
						phase: "starting subagent",
						phaseState: "starting",
						cwd: args.cwd,
						agent: args.agent,
						lockKey: args.lock_key,
						isolation: args.isolation,
						toolCallsStarted: 0,
						toolCallsCompleted: 0,
						assistantMessages: 0,
					};
					const component = new SubagentMessageComponent(info);
					this.chatContainer.addChild(component);
					this.subagentComponents.set(event.toolCallId, {
						component,
						startTime: Date.now(),
						profile: info.profile,
						description: info.description,
						cwd: info.cwd,
						agent: info.agent,
						lockKey: info.lockKey,
						isolation: info.isolation,
						phase: info.phase,
						phaseState: info.phaseState,
						activeTool: info.activeTool,
						toolCallsStarted: info.toolCallsStarted ?? 0,
						toolCallsCompleted: info.toolCallsCompleted ?? 0,
						assistantMessages: info.assistantMessages ?? 0,
						delegatedTasks: info.delegatedTasks,
						delegatedSucceeded: info.delegatedSucceeded,
						delegatedFailed: info.delegatedFailed,
						delegateIndex: info.delegateIndex,
						delegateTotal: info.delegateTotal,
						delegateDescription: info.delegateDescription,
						delegateProfile: info.delegateProfile,
						delegateItems: info.delegateItems,
					});
					this.ui.requestRender();
				} else if (event.toolName !== "task" && !this.pendingTools.has(event.toolCallId)) {
					const component = new ToolExecutionComponent(
						event.toolName,
						event.args,
						{
							showImages: this.settingsManager.getShowImages(),
						},
						this.getRegisteredToolDefinition(event.toolName),
						this.ui,
					);
					component.setExpanded(this.toolOutputExpanded);
					this.chatContainer.addChild(component);
					this.pendingTools.set(event.toolCallId, component);
					this.ui.requestRender();
				}
				break;
			}

			case "tool_execution_update": {
				const subagent = this.subagentComponents.get(event.toolCallId);
				if (subagent) {
					const partialResult = event.partialResult as
						| {
							details?: Record<string, unknown>;
							content?: Array<{ type?: string; text?: string }>;
						}
						| undefined;
					const progressCandidate = partialResult?.details?.progress;
					const progress =
						progressCandidate && typeof progressCandidate === "object"
							? (progressCandidate as Record<string, unknown>)
							: undefined;

					if (progress) {
						const phaseText = typeof progress.message === "string" ? progress.message.trim() : undefined;
						const phaseState = isSubagentPhaseState(progress.phase) ? progress.phase : undefined;
						if (phaseText && phaseText.length > 0) {
							subagent.phase = phaseText;
						} else if (phaseState) {
							subagent.phase = phaseState;
						}
						if (phaseState) {
							subagent.phaseState = phaseState;
						}
						if (typeof progress.cwd === "string") {
							subagent.cwd = progress.cwd;
						}
						if ("activeTool" in progress) {
							subagent.activeTool =
								typeof progress.activeTool === "string" && progress.activeTool.trim().length > 0
									? progress.activeTool
									: undefined;
						}
						if (typeof progress.toolCallsStarted === "number") {
							subagent.toolCallsStarted = progress.toolCallsStarted;
						}
						if (typeof progress.toolCallsCompleted === "number") {
							subagent.toolCallsCompleted = progress.toolCallsCompleted;
						}
						if (typeof progress.assistantMessages === "number") {
							subagent.assistantMessages = progress.assistantMessages;
						}
						if ("delegateIndex" in progress) {
							subagent.delegateIndex =
								typeof progress.delegateIndex === "number" && progress.delegateIndex > 0
									? progress.delegateIndex
									: undefined;
						}
						if ("delegateTotal" in progress) {
							subagent.delegateTotal =
								typeof progress.delegateTotal === "number" && progress.delegateTotal > 0
									? progress.delegateTotal
									: undefined;
						}
						if ("delegateDescription" in progress) {
							subagent.delegateDescription =
								typeof progress.delegateDescription === "string" && progress.delegateDescription.trim().length > 0
									? progress.delegateDescription.trim()
									: undefined;
						}
						if ("delegateProfile" in progress) {
							subagent.delegateProfile =
								typeof progress.delegateProfile === "string" && progress.delegateProfile.trim().length > 0
									? progress.delegateProfile.trim()
									: undefined;
						}
						if ("delegateItems" in progress) {
							subagent.delegateItems = parseSubagentDelegateItems(progress.delegateItems);
						}
					} else {
						const text = partialResult?.content?.find((item) => item.type === "text")?.text;
						if (typeof text === "string" && text.trim().length > 0) {
							subagent.phase = text.trim();
						}
					}

					subagent.component.update({
						description: subagent.description,
						profile: subagent.profile,
						status: "running",
						phase: subagent.phase ?? "running",
						phaseState: subagent.phaseState,
						cwd: subagent.cwd,
						agent: subagent.agent,
						lockKey: subagent.lockKey,
						isolation: subagent.isolation,
						activeTool: subagent.activeTool,
						toolCallsStarted: subagent.toolCallsStarted,
						toolCallsCompleted: subagent.toolCallsCompleted,
						assistantMessages: subagent.assistantMessages,
						delegatedTasks: subagent.delegatedTasks,
						delegatedSucceeded: subagent.delegatedSucceeded,
						delegatedFailed: subagent.delegatedFailed,
						delegateIndex: subagent.delegateIndex,
						delegateTotal: subagent.delegateTotal,
						delegateDescription: subagent.delegateDescription,
						delegateProfile: subagent.delegateProfile,
						delegateItems: subagent.delegateItems,
					});
					this.ui.requestRender();
					break;
				}

				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.partialResult, isError: false }, true);
					this.ui.requestRender();
				}
				break;
			}

			case "tool_execution_end": {
				// Handle subagent (task tool) completion
				const subagent = this.subagentComponents.get(event.toolCallId);
				if (subagent) {
					const durationMs = Date.now() - subagent.startTime;
					const details = event.result?.details as Record<string, unknown> | undefined;
					const outputLength = typeof details?.outputLength === "number" ? details.outputLength : undefined;
					const waitMs = typeof details?.waitMs === "number" ? details.waitMs : undefined;
					const toolCallsStarted =
						typeof details?.toolCallsStarted === "number"
							? details.toolCallsStarted
							: subagent.toolCallsStarted;
					const toolCallsCompleted =
						typeof details?.toolCallsCompleted === "number"
							? details.toolCallsCompleted
							: subagent.toolCallsCompleted;
					const assistantMessages =
						typeof details?.assistantMessages === "number"
							? details.assistantMessages
							: subagent.assistantMessages;
					const delegatedTasks =
						typeof details?.delegatedTasks === "number" ? details.delegatedTasks : subagent.delegatedTasks;
					const delegatedSucceeded =
						typeof details?.delegatedSucceeded === "number"
							? details.delegatedSucceeded
							: subagent.delegatedSucceeded;
					const delegatedFailed =
						typeof details?.delegatedFailed === "number" ? details.delegatedFailed : subagent.delegatedFailed;
					subagent.delegatedTasks = delegatedTasks;
					subagent.delegatedSucceeded = delegatedSucceeded;
					subagent.delegatedFailed = delegatedFailed;
					subagent.component.update({
						description: subagent.description,
						profile: subagent.profile,
						status: event.isError ? "error" : "done",
						outputLength,
						durationMs,
						waitMs,
						phaseState: subagent.phaseState,
						cwd: subagent.cwd,
						agent: subagent.agent,
						lockKey: subagent.lockKey,
						isolation: subagent.isolation,
						toolCallsStarted,
						toolCallsCompleted,
						assistantMessages,
						delegatedTasks,
						delegatedSucceeded,
						delegatedFailed,
						errorMessage: event.isError
							? (event.result?.content?.[0] as { text?: string } | undefined)?.text ?? "error"
							: undefined,
					});
					const staleTaskComponent = this.pendingTools.get(event.toolCallId);
					if (staleTaskComponent) {
						this.chatContainer.removeChild(staleTaskComponent);
						this.pendingTools.delete(event.toolCallId);
					}
					this.subagentComponents.delete(event.toolCallId);
					this.ui.requestRender();
					break;
				}
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.result, isError: event.isError });
					this.pendingTools.delete(event.toolCallId);
					this.ui.requestRender();
				}
				break;
			}

			case "agent_end":
				if (this.loadingAnimation) {
					this.loadingAnimation.stop();
					this.loadingAnimation = undefined;
					this.statusContainer.clear();
				}
				if (this.streamingComponent) {
					this.chatContainer.removeChild(this.streamingComponent);
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
				}
				this.pendingTools.clear();
				this.subagentComponents.clear();

				await this.checkShutdownRequested();

				this.ui.requestRender();
				break;

			case "auto_compaction_start": {
				// Keep editor active; submissions are queued during compaction.
				// Set up escape to abort auto-compaction
				this.autoCompactionEscapeHandler = this.defaultEditor.onEscape;
				this.defaultEditor.onEscape = () => {
					void this.interruptCurrentWork();
				};
				// Show compacting indicator with reason
				this.statusContainer.clear();
				const reasonText = event.reason === "overflow" ? "Context overflow detected, " : "";
				this.autoCompactionLoader = new Loader(
					this.ui,
					(spinner) => theme.fg("accent", spinner),
					(text) => theme.fg("muted", text),
					`${reasonText}Auto-compacting... (${appKey(this.keybindings, "interrupt")} to cancel)`,
				);
				this.statusContainer.addChild(this.autoCompactionLoader);
				this.ui.requestRender();
				break;
			}

			case "auto_compaction_end": {
				// Restore escape handler
				if (this.autoCompactionEscapeHandler) {
					this.defaultEditor.onEscape = this.autoCompactionEscapeHandler;
					this.autoCompactionEscapeHandler = undefined;
				}
				// Stop loader
				if (this.autoCompactionLoader) {
					this.autoCompactionLoader.stop();
					this.autoCompactionLoader = undefined;
					this.statusContainer.clear();
				}
				// Handle result
				if (event.aborted) {
					this.showStatus("Auto-compaction cancelled");
				} else if (event.result) {
					// Rebuild chat to show compacted state
					this.chatContainer.clear();
					this.rebuildChatFromMessages();
					// Add compaction component at bottom so user sees it without scrolling
					this.addMessageToChat({
						role: "compactionSummary",
						tokensBefore: event.result.tokensBefore,
						summary: event.result.summary,
						timestamp: Date.now(),
					});
					this.footer.invalidate();
				} else if (event.errorMessage) {
					// Compaction failed (e.g., quota exceeded, API error)
					this.chatContainer.addChild(new Spacer(1));
					this.chatContainer.addChild(new Text(theme.fg("error", event.errorMessage), 1, 0));
				}
				void this.flushCompactionQueue({ willRetry: event.willRetry });
				this.ui.requestRender();
				break;
			}

			case "auto_retry_start": {
				// Set up escape to abort retry
				this.retryEscapeHandler = this.defaultEditor.onEscape;
				this.defaultEditor.onEscape = () => {
					void this.interruptCurrentWork();
				};
				// Show retry indicator
				this.statusContainer.clear();
				const delaySeconds = Math.round(event.delayMs / 1000);
				this.retryLoader = new Loader(
					this.ui,
					(spinner) => theme.fg("warning", spinner),
					(text) => theme.fg("muted", text),
					`Retrying (${event.attempt}/${event.maxAttempts}) in ${delaySeconds}s... (${appKey(this.keybindings, "interrupt")} to cancel)`,
				);
				this.statusContainer.addChild(this.retryLoader);
				this.ui.requestRender();
				break;
			}

			case "auto_retry_end": {
				// Restore escape handler
				if (this.retryEscapeHandler) {
					this.defaultEditor.onEscape = this.retryEscapeHandler;
					this.retryEscapeHandler = undefined;
				}
				// Stop loader
				if (this.retryLoader) {
					this.retryLoader.stop();
					this.retryLoader = undefined;
					this.statusContainer.clear();
				}
				// Show error only on final failure (success shows normal response)
				if (!event.success) {
					this.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`);
				}
				this.ui.requestRender();
				break;
			}
		}
	}

	/** Extract text content from a user message */
	private getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const textBlocks =
			typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: message.content.filter((c: { type: string }) => c.type === "text");
		const joined = textBlocks.map((c) => (c as { text: string }).text).join("");
		const aliases = Array.isArray(this.pendingInternalUserDisplayAliases) ? this.pendingInternalUserDisplayAliases : [];
		const aliasIndex = aliases.findIndex((item) => item.rawPrompt === joined);
		if (aliasIndex !== -1) {
			const [alias] = aliases.splice(aliasIndex, 1);
			return alias?.displayText ?? joined;
		}
		return joined;
	}

	private handleInternalUiMetaMessage(message: AgentMessage): void {
		if (message.role !== "custom") return;
		if (message.customType !== INTERNAL_UI_META_CUSTOM_TYPE) return;
		if (!isInternalUiMetaDetails(message.details)) return;
		if (message.details.kind !== "orchestration_context") return;

		this.pendingAssistantOrchestrationContexts += 1;
		if (message.details.rawPrompt && message.details.displayText) {
			this.pendingInternalUserDisplayAliases.push({
				rawPrompt: message.details.rawPrompt,
				displayText: message.details.displayText,
			});
		}
	}

	/**
	 * Show a status message in the chat.
	 *
	 * If multiple status messages are emitted back-to-back (without anything else being added to the chat),
	 * we update the previous status line instead of appending new ones to avoid log spam.
	 */
	private showStatus(message: string): void {
		const children = this.chatContainer.children;
		const last = children.length > 0 ? children[children.length - 1] : undefined;
		const secondLast = children.length > 1 ? children[children.length - 2] : undefined;

		if (last && secondLast && last === this.lastStatusText && secondLast === this.lastStatusSpacer) {
			this.lastStatusText.setText(theme.fg("dim", message));
			this.ui.requestRender();
			return;
		}

		const spacer = new Spacer(1);
		const text = new Text(theme.fg("dim", message), 1, 0);
		this.chatContainer.addChild(spacer);
		this.chatContainer.addChild(text);
		this.lastStatusSpacer = spacer;
		this.lastStatusText = text;
		this.ui.requestRender();
	}

	private showProgressLine(message: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("dim", message), 1, 0));
		this.ui.requestRender();
	}

	private setWorkingMessage(message?: string): void {
		if (this.loadingAnimation) {
			if (message) {
				this.loadingAnimation.setMessage(message);
			} else {
				this.loadingAnimation.setMessage(
					`${this.defaultWorkingMessage} (${appKey(this.keybindings, "interrupt")} to interrupt)`,
				);
			}
		} else {
			this.pendingWorkingMessage = message;
		}
		this.ui.requestRender();
	}

	private addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void {
		switch (message.role) {
			case "bashExecution": {
				const component = new BashExecutionComponent(message.command, this.ui, message.excludeFromContext);
				if (message.output) {
					component.appendOutput(message.output);
				}
				component.setComplete(
					message.exitCode,
					message.cancelled,
					message.truncated ? ({ truncated: true } as TruncationResult) : undefined,
					message.fullOutputPath,
				);
				this.chatContainer.addChild(component);
				break;
			}
			case "custom": {
				this.handleInternalUiMetaMessage(message);
				if (message.display) {
					if (message.customType === TASK_PLAN_CUSTOM_TYPE && isTaskPlanSnapshot(message.details)) {
						const component = new TaskPlanMessageComponent(message.details);
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);
					} else {
						const renderer = this.session.extensionRunner?.getMessageRenderer(message.customType);
						const component = new CustomMessageComponent(message, renderer, this.getMarkdownThemeWithSettings());
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);
					}
				}
				break;
			}
			case "compactionSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new CompactionSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "branchSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new BranchSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "user": {
				const textContent = this.getUserMessageText(message);
				if (textContent) {
					const skillBlock = parseSkillBlock(textContent);
					if (skillBlock) {
						// Render skill block (collapsible)
						this.chatContainer.addChild(new Spacer(1));
						const component = new SkillInvocationMessageComponent(
							skillBlock,
							this.getMarkdownThemeWithSettings(),
						);
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);
						// Render user message separately if present
						if (skillBlock.userMessage) {
							const userComponent = new UserMessageComponent(
								skillBlock.userMessage,
								this.getMarkdownThemeWithSettings(),
							);
							this.chatContainer.addChild(userComponent);
						}
					} else {
						const userComponent = new UserMessageComponent(textContent, this.getMarkdownThemeWithSettings());
						this.chatContainer.addChild(userComponent);
					}
					if (options?.populateHistory) {
						this.editor.addToHistory?.(textContent);
					}
				}
				break;
			}
			case "assistant": {
				const hasOrchestrationContext = this.pendingAssistantOrchestrationContexts > 0;
				if (hasOrchestrationContext) {
					this.pendingAssistantOrchestrationContexts -= 1;
				}
				const previousOrchestrationContext = this.activeAssistantOrchestrationContext;
				this.activeAssistantOrchestrationContext = hasOrchestrationContext;
				const displayMessage = this.sanitizeAssistantDisplayMessage(message);
				this.activeAssistantOrchestrationContext = previousOrchestrationContext;
				const assistantComponent = new AssistantMessageComponent(
					displayMessage,
					this.hideThinkingBlock,
					this.getMarkdownThemeWithSettings(),
				);
				this.chatContainer.addChild(assistantComponent);
				break;
			}
			case "toolResult": {
				// Tool results are rendered inline with tool calls, handled separately
				break;
			}
			default: {
				const _exhaustive: never = message;
			}
		}
	}

	/**
	 * Render session context to chat. Used for initial load and rebuild after compaction.
	 * @param sessionContext Session context to render
	 * @param options.updateFooter Update footer state
	 * @param options.populateHistory Add user messages to editor history
	 */
	private renderSessionContext(
		sessionContext: SessionContext,
		options: { updateFooter?: boolean; populateHistory?: boolean } = {},
	): void {
		this.pendingTools.clear();
		this.pendingInternalUserDisplayAliases = [];
		this.pendingAssistantOrchestrationContexts = 0;
		this.activeAssistantOrchestrationContext = false;
		const pendingSubagentHistory = new Map<string, SubagentMessageComponent>();

		if (options.updateFooter) {
			this.footer.invalidate();
			this.updateEditorBorderColor();
		}

		for (const message of sessionContext.messages) {
			// Assistant messages need special handling for tool calls
			if (message.role === "assistant") {
				this.addMessageToChat(message);
				// Render tool call components
				for (const content of message.content) {
					if (content.type === "toolCall") {
						if (content.name === "task") {
							const args = content.arguments as {
								description?: string;
								profile?: string;
								cwd?: string;
								agent?: string;
								lock_key?: string;
								isolation?: "none" | "worktree";
							};
							const subagent = new SubagentMessageComponent({
								description: args.description ?? "Running subtask",
								profile: args.profile ?? "explore",
								status: "running",
								cwd: args.cwd,
								agent: args.agent,
								lockKey: args.lock_key,
								isolation: args.isolation,
							});
							this.chatContainer.addChild(subagent);
							pendingSubagentHistory.set(content.id, subagent);
							continue;
						}
						const component = new ToolExecutionComponent(
							content.name,
							content.arguments,
							{ showImages: this.settingsManager.getShowImages() },
							this.getRegisteredToolDefinition(content.name),
							this.ui,
						);
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);

						if (message.stopReason === "aborted" || message.stopReason === "error") {
							let errorMessage: string;
							if (message.stopReason === "aborted") {
								const retryAttempt = this.session.retryAttempt;
								errorMessage =
									retryAttempt > 0
										? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
										: "Operation aborted";
							} else {
								errorMessage = message.errorMessage || "Error";
							}
							component.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
						} else {
							this.pendingTools.set(content.id, component);
						}
					}
				}
			} else if (message.role === "toolResult") {
				const subagent = pendingSubagentHistory.get(message.toolCallId);
				if (subagent) {
					const details = message.details as Record<string, unknown> | undefined;
					subagent.update({
						description:
							typeof details?.description === "string" ? details.description : "Running subtask",
						profile: typeof details?.profile === "string" ? details.profile : "explore",
						status: message.isError ? "error" : "done",
						outputLength: typeof details?.outputLength === "number" ? details.outputLength : undefined,
						waitMs: typeof details?.waitMs === "number" ? details.waitMs : undefined,
						toolCallsStarted: typeof details?.toolCallsStarted === "number" ? details.toolCallsStarted : undefined,
						toolCallsCompleted:
							typeof details?.toolCallsCompleted === "number" ? details.toolCallsCompleted : undefined,
						assistantMessages:
							typeof details?.assistantMessages === "number" ? details.assistantMessages : undefined,
						delegatedTasks: typeof details?.delegatedTasks === "number" ? details.delegatedTasks : undefined,
						delegatedSucceeded:
							typeof details?.delegatedSucceeded === "number" ? details.delegatedSucceeded : undefined,
						delegatedFailed: typeof details?.delegatedFailed === "number" ? details.delegatedFailed : undefined,
						errorMessage: message.isError
							? (message.content?.[0] as { text?: string } | undefined)?.text ?? "error"
							: undefined,
					});
					pendingSubagentHistory.delete(message.toolCallId);
					continue;
				}
				// Match tool results to pending tool components
				const component = this.pendingTools.get(message.toolCallId);
				if (component) {
					component.updateResult(message);
					this.pendingTools.delete(message.toolCallId);
				}
			} else {
				// All other messages use standard rendering
				this.addMessageToChat(message, options);
			}
		}

		this.pendingTools.clear();
		this.ui.requestRender();
	}

	renderInitialMessages(): void {
		// Get aligned messages and entries from session context
		const context = this.sessionManager.buildSessionContext();
		this.renderSessionContext(context, {
			updateFooter: true,
			populateHistory: true,
		});

		// Show compaction info if session was compacted
		const allEntries = this.sessionManager.getEntries();
		const compactionCount = allEntries.filter((e) => e.type === "compaction").length;
		if (compactionCount > 0) {
			const times = compactionCount === 1 ? "1 time" : `${compactionCount} times`;
			this.showStatus(`Session compacted ${times}`);
		}
	}

	async getUserInput(): Promise<string> {
		return new Promise((resolve) => {
			this.onInputCallback = (text: string) => {
				this.onInputCallback = undefined;
				resolve(text);
			};
		});
	}

	private rebuildChatFromMessages(): void {
		this.chatContainer.clear();
		const context = this.sessionManager.buildSessionContext();
		this.renderSessionContext(context);
	}

	// =========================================================================
	// Key handlers
	// =========================================================================

	private handleCtrlC(): void {
		const now = Date.now();
		if (this.iosmAutomationRun) {
			if (this.iosmAutomationRun.cancelRequested && now - this.lastSigintTime < 500) {
				void this.shutdown();
				return;
			}
			this.lastSigintTime = now;
			void this.interruptCurrentWork();
			return;
		}
		if (now - this.lastSigintTime < 500) {
			void this.shutdown();
		} else {
			this.clearEditor();
			this.lastSigintTime = now;
		}
	}

	private handleCtrlD(): void {
		// Only called when editor is empty (enforced by CustomEditor)
		void this.shutdown();
	}

	/**
	 * Gracefully shutdown the agent.
	 * Emits shutdown event to extensions, then exits.
	 */
	private isShuttingDown = false;

	private async shutdown(): Promise<void> {
		if (this.isShuttingDown) return;
		this.isShuttingDown = true;

		// Emit shutdown event to extensions
		const extensionRunner = this.session.extensionRunner;
		if (extensionRunner?.hasHandlers("session_shutdown")) {
			await extensionRunner.emit({
				type: "session_shutdown",
			});
		}

		// Wait for any pending renders to complete
		// requestRender() uses process.nextTick(), so we wait one tick
		await new Promise((resolve) => process.nextTick(resolve));

		// Drain any in-flight Kitty key release events before stopping.
		// This prevents escape sequences from leaking to the parent shell over slow SSH.
		await this.ui.terminal.drainInput(1000);

		this.stop();
		process.exit(0);
	}

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 */
	private async checkShutdownRequested(): Promise<void> {
		if (!this.shutdownRequested) return;
		await this.shutdown();
	}

	private handleCtrlZ(): void {
		// Ignore SIGINT while suspended so Ctrl+C in the terminal does not
		// kill the backgrounded process. The handler is removed on resume.
		const ignoreSigint = () => { };
		process.on("SIGINT", ignoreSigint);

		// Set up handler to restore TUI when resumed
		process.once("SIGCONT", () => {
			process.removeListener("SIGINT", ignoreSigint);
			this.ui.start();
			this.ui.requestRender(true);
		});

		// Stop the TUI (restore terminal to normal mode)
		this.ui.stop();

		// Send SIGTSTP to process group (pid=0 means all processes in group)
		process.kill(0, "SIGTSTP");
	}

	private async handleSteer(): Promise<void> {
		const text = (this.editor.getExpandedText?.() ?? this.editor.getText()).trim();
		if (!text) return;

		// Queue input during compaction (extension commands execute immediately)
		if (this.session.isCompacting) {
			if (this.isExtensionCommand(text)) {
				this.editor.addToHistory?.(text);
				this.editor.setText("");
				await this.session.prompt(text);
			} else {
				this.queueCompactionMessage(text, "steer");
			}
			return;
		}

		// Dedicated steer shortcut always sends as steer while streaming
		if (this.session.isStreaming) {
			this.editor.addToHistory?.(text);
			this.editor.setText("");
			await this.session.prompt(text, { streamingBehavior: "steer" });
			this.updatePendingMessagesDisplay();
			this.ui.requestRender();
		}
		// If not streaming, steer behaves like regular submit
		else if (this.editor.onSubmit) {
			this.editor.onSubmit(text);
		}
	}

	private async handleFollowUp(): Promise<void> {
		const text = (this.editor.getExpandedText?.() ?? this.editor.getText()).trim();
		if (!text) return;

		// Queue input during compaction (extension commands execute immediately)
		if (this.session.isCompacting) {
			if (this.isExtensionCommand(text)) {
				this.editor.addToHistory?.(text);
				this.editor.setText("");
				await this.session.prompt(text);
			} else {
				this.queueCompactionMessage(text, "followUp");
			}
			return;
		}

		// Alt+Enter queues a follow-up message (waits until agent finishes)
		// This handles extension commands (execute immediately), prompt template expansion, and queueing
		if (this.session.isStreaming) {
			this.editor.addToHistory?.(text);
			this.editor.setText("");
			await this.session.prompt(text, { streamingBehavior: "followUp" });
			this.updatePendingMessagesDisplay();
			this.ui.requestRender();
		}
		// If not streaming, Alt+Enter acts like regular Enter (trigger onSubmit)
		else if (this.editor.onSubmit) {
			this.editor.onSubmit(text);
		}
	}

	private handleDequeue(): void {
		const restored = this.restoreQueuedMessagesToEditor();
		if (restored === 0) {
			this.showStatus("No queued messages to restore");
		} else {
			this.showStatus(`Restored ${restored} queued message${restored > 1 ? "s" : ""} to editor`);
		}
	}

	private updateEditorBorderColor(): void {
		if (this.isBashMode) {
			this.editor.borderColor = theme.getBashModeBorderColor();
		} else {
			const level = this.session.thinkingLevel || "off";
			this.editor.borderColor = theme.getThinkingBorderColor(level);
		}
		this.ui.requestRender();
	}

	private cycleThinkingLevel(): void {
		const newLevel = this.session.cycleThinkingLevel();
		if (newLevel === undefined) {
			this.showStatus("Current model does not support thinking");
		} else {
			this.footer.invalidate();
			this.updateEditorBorderColor();
			this.showStatus(`Thinking level: ${newLevel}`);
		}
	}

	private applyProfile(profileName: AgentProfileName): void {
		const profile = getAgentProfile(profileName);
		const availableTools = new Set(this.session.getAllTools().map((tool) => tool.name));
		const nextActiveTools = [...profile.tools];
		if (availableTools.has("task")) nextActiveTools.push("task");
		if (availableTools.has("todo_write")) nextActiveTools.push("todo_write");
		if (availableTools.has("todo_read")) nextActiveTools.push("todo_read");
		if (availableTools.has("ask_user")) nextActiveTools.push("ask_user");

		this.session.setActiveToolsByName([...new Set(nextActiveTools)]);
		this.session.setThinkingLevel(profile.thinkingLevel);
		this.session.setSystemPromptSuffix(profile.systemPromptAppend || undefined);
		this.session.setIosmAutopilotEnabled(profile.name === "iosm");

		this.activeProfileName = profile.name;
		this.footer.setActiveProfile(profile.name);
		this.footer.setPlanMode(profile.name === "plan");
		this.setupAutocomplete(this.fdPath);
		this.footer.invalidate();
		this.updateEditorBorderColor();
		this.refreshBuiltInHeader();
		this.showStatus(`Profile: ${profile.name}`);
	}

	private cycleProfile(direction: "forward" | "backward"): void {
		if (this.session.isStreaming || this.session.isCompacting || this.iosmAutomationRun || this.iosmVerificationSession) {
			this.showWarning("Wait for current work to finish before switching profile.");
			return;
		}

		const names = getMainProfileNames();
		const currentIndex = Math.max(0, names.indexOf(this.activeProfileName));
		const delta = direction === "forward" ? 1 : -1;
		const nextIndex = (currentIndex + delta + names.length) % names.length;
		this.applyProfile(names[nextIndex]);
	}

	private async cycleModel(direction: "forward" | "backward"): Promise<void> {
		try {
			const result = await this.session.cycleModel(direction);
			if (result === undefined) {
				const msg = this.session.scopedModels.length > 0 ? "Only one model in scope" : "Only one model available";
				this.showStatus(msg);
			} else {
				this.footer.invalidate();
				this.updateEditorBorderColor();
				this.refreshBuiltInHeader();
				const thinkingStr =
					result.model.reasoning && result.thinkingLevel !== "off" ? ` (thinking: ${result.thinkingLevel})` : "";
				this.showStatus(`Switched to ${result.model.name || result.model.id}${thinkingStr}`);
			}
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private toggleToolOutputExpansion(): void {
		this.setToolsExpanded(!this.toolOutputExpanded);
	}

	private setToolsExpanded(expanded: boolean): void {
		this.toolOutputExpanded = expanded;
		for (const child of this.chatContainer.children) {
			if (isExpandable(child)) {
				child.setExpanded(expanded);
			}
		}
		this.ui.requestRender();
	}

	private toggleThinkingBlockVisibility(): void {
		this.hideThinkingBlock = !this.hideThinkingBlock;
		this.settingsManager.setHideThinkingBlock(this.hideThinkingBlock);

		// Rebuild chat from session messages
		this.chatContainer.clear();
		this.rebuildChatFromMessages();

		// If streaming, re-add the streaming component with updated visibility and re-render
		if (this.streamingComponent && this.streamingMessage) {
			this.streamingComponent.setHideThinkingBlock(this.hideThinkingBlock);
			this.streamingComponent.updateContent(this.sanitizeAssistantDisplayMessage(this.streamingMessage));
			this.chatContainer.addChild(this.streamingComponent);
		}

		this.showStatus(`Thinking blocks: ${this.hideThinkingBlock ? "hidden" : "visible"}`);
	}

	private openExternalEditor(): void {
		// Determine editor (respect $VISUAL, then $EDITOR)
		const editorCmd = process.env.VISUAL || process.env.EDITOR;
		if (!editorCmd) {
			this.showWarning("No editor configured. Set $VISUAL or $EDITOR environment variable.");
			return;
		}

		const currentText = this.editor.getExpandedText?.() ?? this.editor.getText();
		const tmpFile = path.join(os.tmpdir(), `${APP_NAME}-editor-${Date.now()}.${APP_NAME}.md`);

		try {
			// Write current content to temp file
			fs.writeFileSync(tmpFile, currentText, "utf-8");

			// Stop TUI to release terminal
			this.ui.stop();

			// Split by space to support editor arguments (e.g., "code --wait")
			const [editor, ...editorArgs] = editorCmd.split(" ");

			// Spawn editor synchronously with inherited stdio for interactive editing
			const result = spawnSync(editor, [...editorArgs, tmpFile], {
				stdio: "inherit",
			});

			// On successful exit (status 0), replace editor content
			if (result.status === 0) {
				const newContent = fs.readFileSync(tmpFile, "utf-8").replace(/\n$/, "");
				this.editor.setText(newContent);
			}
			// On non-zero exit, keep original text (no action needed)
		} finally {
			// Clean up temp file
			try {
				fs.unlinkSync(tmpFile);
			} catch {
				// Ignore cleanup errors
			}

			// Restart TUI
			this.ui.start();
			// Force full re-render since external editor uses alternate screen
			this.ui.requestRender(true);
		}
	}

	// =========================================================================
	// UI helpers
	// =========================================================================

	clearEditor(): void {
		this.editor.setText("");
		this.ui.requestRender();
	}

	showError(errorMessage: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("error", `Error: ${errorMessage}`), 1, 0));
		this.ui.requestRender();
	}

	showWarning(warningMessage: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("warning", `Warning: ${warningMessage}`), 1, 0));
		this.ui.requestRender();
	}

	showNewVersionNotification(newVersion: string): void {
		const action = theme.fg("accent", getUpdateInstruction(PACKAGE_NAME));
		const updateInstruction = theme.fg("muted", `New version ${newVersion} is available. `) + action;
		const changelogLine = CHANGELOG_URL
			? theme.fg("muted", "Changelog: ") + theme.fg("accent", CHANGELOG_URL)
			: theme.fg("muted", "Changelog: CHANGELOG.md");

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.chatContainer.addChild(
			new Text(
				`${theme.bold(theme.fg("warning", "Update Available"))}\n${updateInstruction}\n${changelogLine}`,
				1,
				0,
			),
		);
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.ui.requestRender();
	}

	/**
	 * Get all queued messages (read-only).
	 * Combines session queue and compaction queue.
	 */
	private getAllQueuedMessages(): { steering: string[]; followUp: string[]; meta: string[] } {
		return {
			steering: [
				...this.session.getSteeringMessages(),
				...this.compactionQueuedMessages.filter((msg) => msg.mode === "steer").map((msg) => msg.text),
			],
			followUp: [
				...this.session.getFollowUpMessages(),
				...this.compactionQueuedMessages.filter((msg) => msg.mode === "followUp").map((msg) => msg.text),
			],
			meta: [
				...this.session.getMetaMessages(),
				...this.compactionQueuedMessages.filter((msg) => msg.mode === "meta").map((msg) => msg.text),
			],
		};
	}

	/**
	 * Clear all queued messages and return their contents.
	 * Clears both session queue and compaction queue.
	 */
	private clearAllQueues(): { steering: string[]; followUp: string[]; meta: string[] } {
		const { steering, followUp, meta } = this.session.clearQueue();
		const compactionSteering = this.compactionQueuedMessages
			.filter((msg) => msg.mode === "steer")
			.map((msg) => msg.text);
		const compactionFollowUp = this.compactionQueuedMessages
			.filter((msg) => msg.mode === "followUp")
			.map((msg) => msg.text);
		const compactionMeta = this.compactionQueuedMessages
			.filter((msg) => msg.mode === "meta")
			.map((msg) => msg.text);
		this.compactionQueuedMessages = [];
		return {
			steering: [...steering, ...compactionSteering],
			followUp: [...followUp, ...compactionFollowUp],
			meta: [...meta, ...compactionMeta],
		};
	}

	private updatePendingMessagesDisplay(): void {
		const bashComponents = [...this.pendingBashComponents];
		this.pendingMessagesContainer.clear();
		const {
			steering: steeringMessages,
			followUp: followUpMessages,
			meta: rawMetaMessages,
		} = this.getAllQueuedMessages();
		const metaMessages = rawMetaMessages ?? [];
		const totalQueued = steeringMessages.length + followUpMessages.length + metaMessages.length;
		if (totalQueued > 0 || bashComponents.length > 0) {
			this.pendingMessagesContainer.addChild(new Spacer(1));
			if (totalQueued > 0) {
				const summaryParts = [theme.bold(theme.fg("accent", `Queue ${totalQueued}`))];
				if (metaMessages.length > 0) {
					summaryParts.push(theme.fg("accent", `${metaMessages.length} meta`));
				}
				if (steeringMessages.length > 0) {
					summaryParts.push(theme.fg("accent", `${steeringMessages.length} steer`));
				}
				if (followUpMessages.length > 0) {
					summaryParts.push(theme.fg("warning", `${followUpMessages.length} follow-up`));
				}
				this.pendingMessagesContainer.addChild(
					new TruncatedText(summaryParts.join(theme.fg("dim", " • ")), 1, 0),
				);
			}

			for (const message of steeringMessages) {
				const text =
					theme.fg("accent", "steer") +
					theme.fg("dim", " → ") +
					this.previewPendingMessage(message);
				this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
			}
			for (const message of followUpMessages) {
				const text =
					theme.fg("warning", "follow-up") +
					theme.fg("dim", " → ") +
					this.previewPendingMessage(message);
				this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
			}
			for (const message of metaMessages) {
				const text =
					theme.fg("accent", "meta") +
					theme.fg("dim", " → ") +
					this.previewPendingMessage(message);
				this.pendingMessagesContainer.addChild(new TruncatedText(text, 1, 0));
			}
			const metaAppliedStep = this.session?.metaAppliedStep ?? 0;
			if (metaAppliedStep > 0) {
				this.pendingMessagesContainer.addChild(
					new TruncatedText(theme.fg("dim", `meta applied at step ${metaAppliedStep}`), 1, 0),
				);
			}
			if (totalQueued > 0) {
				const dequeueHint = this.getAppKeyDisplay("dequeue");
				const hintText = theme.fg("dim", `↳ ${dequeueHint} to edit or restore the queued draft`);
				this.pendingMessagesContainer.addChild(new TruncatedText(hintText, 1, 0));
			}
			if (bashComponents.length > 0) {
				this.pendingMessagesContainer.addChild(
					new TruncatedText(theme.fg("muted", `Pending bash ${bashComponents.length}`), 1, 0),
				);
			}
			for (const component of bashComponents) {
				this.pendingMessagesContainer.addChild(component);
			}
		}
	}

	private previewPendingMessage(message: string): string {
		return theme.fg("muted", message.replace(/\s+/g, " ").trim());
	}

	private async interruptCurrentWork(): Promise<boolean> {
		const queuedMessages = this.getAllQueuedMessages();
		const queuedMeta = queuedMessages.meta ?? [];
		const hasPendingQueuedMessages =
			queuedMessages.steering.length > 0 || queuedMessages.followUp.length > 0 || queuedMeta.length > 0;
		const hasAutomationWork = this.iosmAutomationRun !== undefined;
		const verificationSession = this.iosmVerificationSession;
		const hasVerificationWork = verificationSession !== undefined;
		const hasMainStreaming = this.session.isStreaming;
		const hasRetryWork = this.session.isRetrying;
		const hasCompactionWork = this.session.isCompacting;
		const hasBashWork = this.session.isBashRunning;

		if (
			!hasPendingQueuedMessages &&
			!hasAutomationWork &&
			!hasVerificationWork &&
			!hasMainStreaming &&
			!hasRetryWork &&
			!hasCompactionWork &&
			!hasBashWork
		) {
			return false;
		}

		if (!hasMainStreaming && (hasBashWork || hasRetryWork || hasCompactionWork || hasPendingQueuedMessages)) {
			await this.session.notifyStopHooks?.("interrupt");
		}

		if (this.iosmAutomationRun) {
			this.iosmAutomationRun.cancelRequested = true;
		}
		if (hasPendingQueuedMessages) {
			this.restoreQueuedMessagesToEditor();
		} else {
			this.updatePendingMessagesDisplay();
		}
		if (hasBashWork) {
			this.session.abortBash();
		}
		if (hasRetryWork) {
			this.session.abortRetry();
		}
		if (hasCompactionWork) {
			this.session.abortCompaction();
			this.session.abortBranchSummary();
		}

		this.showStatus(
			hasAutomationWork
				? "Stopping IOSM automation..."
				: hasVerificationWork
					? "Stopping IOSM verification..."
					: "Stopping current run...",
		);

		const abortPromises: Promise<unknown>[] = [];
		if (hasMainStreaming) {
			abortPromises.push(this.session.abort());
		}
		if (verificationSession) {
			abortPromises.push(verificationSession.abort());
		}
		if (abortPromises.length > 0) {
			await Promise.allSettled(abortPromises);
		}
		return true;
	}

	private restoreQueuedMessagesToEditor(options?: { abort?: boolean; currentText?: string }): number {
		const { steering, followUp, meta } = this.clearAllQueues();
		const allQueued = [...meta, ...steering, ...followUp];
		if (allQueued.length === 0) {
			this.updatePendingMessagesDisplay();
			if (options?.abort) {
				this.agent.abort();
			}
			return 0;
		}
		const queuedText = allQueued.join("\n\n");
		const currentText = options?.currentText ?? this.editor.getText();
		const combinedText = [queuedText, currentText].filter((t) => t.trim()).join("\n\n");
		this.editor.setText(combinedText);
		this.updatePendingMessagesDisplay();
		if (options?.abort) {
			this.agent.abort();
		}
		return allQueued.length;
	}

	private queueCompactionMessage(text: string, mode: "steer" | "followUp" | "meta"): void {
		this.compactionQueuedMessages.push({ text, mode });
		this.editor.addToHistory?.(text);
		this.editor.setText("");
		this.updatePendingMessagesDisplay();
		this.showStatus("Queued message for after compaction");
	}

	private isExtensionCommand(text: string): boolean {
		if (!text.startsWith("/")) return false;

		const extensionRunner = this.session.extensionRunner;
		if (!extensionRunner) return false;

		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		return !!extensionRunner.getCommand(commandName);
	}

	private async flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void> {
		if (this.compactionQueuedMessages.length === 0) {
			return;
		}

		const queuedMessages = [...this.compactionQueuedMessages];
		this.compactionQueuedMessages = [];
		this.updatePendingMessagesDisplay();

		const restoreQueue = (error: unknown) => {
			this.session.clearQueue();
			this.compactionQueuedMessages = queuedMessages;
			this.updatePendingMessagesDisplay();
			this.showError(
				`Failed to send queued message${queuedMessages.length > 1 ? "s" : ""}: ${error instanceof Error ? error.message : String(error)
				}`,
			);
		};

		try {
			if (options?.willRetry) {
				// When retry is pending, queue messages for the retry turn
				for (const message of queuedMessages) {
					if (this.isExtensionCommand(message.text)) {
						await this.session.prompt(message.text);
					} else if (message.mode === "meta") {
						await this.session.meta(message.text);
					} else if (message.mode === "followUp") {
						await this.session.followUp(message.text);
					} else {
						await this.session.steer(message.text);
					}
				}
				this.updatePendingMessagesDisplay();
				return;
			}

			// Find first non-extension-command message to use as prompt
			const firstPromptIndex = queuedMessages.findIndex((message) => !this.isExtensionCommand(message.text));
			if (firstPromptIndex === -1) {
				// All extension commands - execute them all
				for (const message of queuedMessages) {
					await this.session.prompt(message.text);
				}
				return;
			}

			// Execute any extension commands before the first prompt
			const preCommands = queuedMessages.slice(0, firstPromptIndex);
			const firstPrompt = queuedMessages[firstPromptIndex];
			const rest = queuedMessages.slice(firstPromptIndex + 1);

			for (const message of preCommands) {
				await this.session.prompt(message.text);
			}

			// Send first prompt (starts streaming)
			const promptPromise = this.session.prompt(firstPrompt.text).catch((error) => {
				restoreQueue(error);
			});

			// Queue remaining messages
			for (const message of rest) {
				if (this.isExtensionCommand(message.text)) {
					await this.session.prompt(message.text);
				} else if (message.mode === "meta") {
					await this.session.meta(message.text);
				} else if (message.mode === "followUp") {
					await this.session.followUp(message.text);
				} else {
					await this.session.steer(message.text);
				}
			}
			this.updatePendingMessagesDisplay();
			void promptPromise;
		} catch (error) {
			restoreQueue(error);
		}
	}

	/** Move pending bash components from pending area to chat */
	private flushPendingBashComponents(): void {
		for (const component of this.pendingBashComponents) {
			this.pendingMessagesContainer.removeChild(component);
			this.chatContainer.addChild(component);
		}
		this.pendingBashComponents = [];
	}

	// =========================================================================
	// Selectors
	// =========================================================================

	/**
	 * Shows a selector component in place of the editor.
	 * @param create Factory that receives a `done` callback and returns the component and focus target
	 */
	private showSelector(create: (done: () => void) => { component: Component; focus: Component }): void {
		const done = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
		};
		const { component, focus } = create(done);
		this.editorContainer.clear();
		this.editorContainer.addChild(component);
		this.ui.setFocus(focus);
		this.ui.requestRender();
	}

	private syncMcpToolsWithSession(): void {
		if (!this.mcpRuntime) return;
		this.session.setCustomTools(this.mcpRuntime.getToolDefinitions());
		this.setupAutocomplete(this.fdPath);
		this.refreshBuiltInHeader();
	}

	private async refreshMcpRuntimeAndSession(): Promise<void> {
		if (!this.mcpRuntime) return;
		await this.mcpRuntime.refresh();
		this.syncMcpToolsWithSession();
		const errors = this.mcpRuntime.getErrors();
		if (errors.length > 0) {
			this.showWarning(`MCP config warning: ${errors[0]}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ""}`);
		}
	}

	private buildMcpStatusReport(statuses: ReturnType<McpRuntime["getServers"]>): string {
		if (statuses.length === 0) {
			return "No MCP servers configured.";
		}
		const lines: string[] = [];
		for (const status of statuses) {
			lines.push(
				`${status.name} · ${status.scope}/${status.transport} · ${status.enabled ? "enabled" : "disabled"} · state=${status.state} · tools=${status.toolCount}`,
			);
			if (status.error) {
				lines.push(`  error: ${status.error}`);
			}
			for (const tool of status.tools.slice(0, 8)) {
				const alias = tool.name === tool.exposedName ? "" : ` -> ${tool.exposedName}`;
				lines.push(`  - ${tool.name}${alias}`);
			}
			if (status.tools.length > 8) {
				lines.push(`  ... ${status.tools.length - 8} more`);
			}
		}
		return lines.join("\n");
	}

	private parseMcpKeyValueMapInput(raw: string): { value?: Record<string, string>; error?: string } {
		const trimmed = raw.trim();
		if (!trimmed) {
			return { value: undefined };
		}
		const pairs = trimmed
			.split(",")
			.map((part) => part.trim())
			.filter((part) => part.length > 0);

		const value: Record<string, string> = {};
		for (const pair of pairs) {
			const eqIndex = pair.indexOf("=");
			if (eqIndex <= 0) {
				return { error: `Invalid pair "${pair}". Use KEY=VALUE,KEY2=VALUE2` };
			}
			const key = pair.slice(0, eqIndex).trim();
			const entryValue = pair.slice(eqIndex + 1).trim();
			if (!key) {
				return { error: `Invalid pair "${pair}". Key must not be empty.` };
			}
			value[key] = entryValue;
		}
		return { value: Object.keys(value).length > 0 ? value : undefined };
	}

	private parseMcpCsvListInput(raw: string): string[] | undefined {
		const trimmed = raw.trim();
		if (!trimmed) return undefined;
		const items = trimmed
			.split(",")
			.map((item) => item.trim())
			.filter((item) => item.length > 0);
		return items.length > 0 ? [...new Set(items)] : undefined;
	}

	private async runMcpAddWizard(initialName?: string): Promise<void> {
		if (!this.mcpRuntime) {
			this.showWarning("MCP runtime is unavailable in this session.");
			return;
		}

		await this.refreshMcpRuntimeAndSession();

		let name = initialName?.trim();
		while (!name || !/^[a-zA-Z0-9._-]+$/.test(name)) {
			const enteredName = await this.showExtensionInput("MCP Add: server name", "filesystem");
			if (enteredName === undefined) {
				this.showStatus("MCP add cancelled");
				return;
			}
			name = enteredName.trim();
			if (!name) {
				this.showWarning("Server name cannot be empty.");
				continue;
			}
			if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
				this.showWarning('Use only letters, numbers, ".", "_" or "-".');
				continue;
			}
		}

		const existing = this.mcpRuntime.getServer(name);
		if (existing) {
			const overwrite = await this.showExtensionConfirm(
				"MCP Add",
				`Server "${name}" already exists (${existing.scope}). Overwrite it?`,
			);
			if (!overwrite) {
				this.showStatus("MCP add cancelled");
				return;
			}
		}

		const scopeChoice = await this.showExtensionSelector("MCP Add: scope", ["project (Recommended)", "user"]);
		if (!scopeChoice) {
			this.showStatus("MCP add cancelled");
			return;
		}
		const scope: McpScope = scopeChoice.startsWith("user") ? "user" : "project";

		const transportChoice = await this.showExtensionSelector("MCP Add: transport", [
			"stdio (Recommended)",
			"http",
			"sse",
		]);
		if (!transportChoice) {
			this.showStatus("MCP add cancelled");
			return;
		}
		const transport = transportChoice.startsWith("http")
			? "http"
			: transportChoice.startsWith("sse")
				? "sse"
				: "stdio";

		const config: McpServerConfig = {
			transport,
			enabled: true,
			trust: false,
		};

		if (transport === "stdio") {
			while (!config.command) {
				const commandLine = await this.showExtensionInput(
					"MCP Add: stdio command",
					"npx -y @modelcontextprotocol/server-filesystem .",
				);
				if (commandLine === undefined) {
					this.showStatus("MCP add cancelled");
					return;
				}
				const tokens = this.parseSlashArgs(commandLine.trim());
				if (tokens.length === 0) {
					this.showWarning("Command cannot be empty.");
					continue;
				}
				config.command = tokens[0];
				config.args = tokens.slice(1);
			}

			const cwdInput = await this.showExtensionInput(
				"MCP Add: working directory (optional)",
				"leave blank to use current project",
			);
			if (cwdInput === undefined) {
				this.showStatus("MCP add cancelled");
				return;
			}
			if (cwdInput.trim()) {
				config.cwd = cwdInput.trim();
			}

			while (true) {
				const envInput = await this.showExtensionInput(
					"MCP Add: env vars (optional)",
					"KEY=VALUE,API_TOKEN=${API_TOKEN}",
				);
				if (envInput === undefined) {
					this.showStatus("MCP add cancelled");
					return;
				}
				const parsed = this.parseMcpKeyValueMapInput(envInput);
				if (parsed.error) {
					this.showWarning(parsed.error);
					continue;
				}
				config.env = parsed.value;
				break;
			}
		} else {
			while (!config.url) {
				const urlInput = await this.showExtensionInput(
					`MCP Add: ${transport.toUpperCase()} URL`,
					transport === "http" ? "https://example.com/mcp" : "https://example.com/sse",
				);
				if (urlInput === undefined) {
					this.showStatus("MCP add cancelled");
					return;
				}
				const candidate = urlInput.trim();
				if (!candidate) {
					this.showWarning("URL cannot be empty.");
					continue;
				}
				config.url = candidate;
			}

			while (true) {
				const headersInput = await this.showExtensionInput(
					"MCP Add: headers (optional)",
					"Authorization=Bearer ${TOKEN}",
				);
				if (headersInput === undefined) {
					this.showStatus("MCP add cancelled");
					return;
				}
				const parsed = this.parseMcpKeyValueMapInput(headersInput);
				if (parsed.error) {
					this.showWarning(parsed.error);
					continue;
				}
				config.headers = parsed.value;
				break;
			}
		}

		while (true) {
			const timeoutInput = await this.showExtensionInput("MCP Add: timeout ms (optional)", "30000");
			if (timeoutInput === undefined) {
				this.showStatus("MCP add cancelled");
				return;
			}
			const trimmed = timeoutInput.trim();
			if (!trimmed) {
				break;
			}
			const timeoutMs = Number.parseInt(trimmed, 10);
			if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
				this.showWarning("Timeout must be a positive integer (milliseconds).");
				continue;
			}
			config.timeoutMs = timeoutMs;
			break;
		}

		const includeToolsInput = await this.showExtensionInput(
			"MCP Add: include tools (optional, CSV)",
			"toolA,toolB",
		);
		if (includeToolsInput === undefined) {
			this.showStatus("MCP add cancelled");
			return;
		}
		config.includeTools = this.parseMcpCsvListInput(includeToolsInput);

		const excludeToolsInput = await this.showExtensionInput(
			"MCP Add: exclude tools (optional, CSV)",
			"dangerousTool",
		);
		if (excludeToolsInput === undefined) {
			this.showStatus("MCP add cancelled");
			return;
		}
		config.excludeTools = this.parseMcpCsvListInput(excludeToolsInput);

		const trustChoice = await this.showExtensionSelector("MCP Add: trust this server?", [
			"No (Recommended)",
			"Yes",
		]);
		if (!trustChoice) {
			this.showStatus("MCP add cancelled");
			return;
		}
		config.trust = trustChoice.startsWith("Yes");

		const enableChoice = await this.showExtensionSelector("MCP Add: enable now?", ["Yes (Recommended)", "No"]);
		if (!enableChoice) {
			this.showStatus("MCP add cancelled");
			return;
		}
		config.enabled = enableChoice.startsWith("Yes");

		const path = await this.mcpRuntime.addServer(name, scope, config);
		this.syncMcpToolsWithSession();
		const status = this.mcpRuntime.getServer(name);
		this.showStatus(`Added MCP server ${name} (${scope})`);

		const details: string[] = [`Config: ${path}`];
		if (status?.state === "connected") {
			details.push(`Connected tools: ${status.toolCount}`);
		} else if (status?.state === "error") {
			details.push(`Connection warning: ${status.error ?? "unknown error"}`);
		}
		this.showCommandTextBlock("MCP Add", details.join("\n"));
	}

	private async handleMcpSlashCommand(text: string): Promise<void> {
		if (!this.mcpRuntime) {
			this.showWarning("MCP runtime is unavailable in this session.");
			return;
		}

		const args = this.parseSlashArgs(text).slice(1);
		if (args.length === 0) {
			await this.refreshMcpRuntimeAndSession();
			this.showMcpSelector();
			return;
		}

		const subcommand = args[0]?.toLowerCase();
		const rest = args.slice(1);

		if (!subcommand || subcommand === "help" || subcommand === "-h" || subcommand === "--help") {
			this.showCommandTextBlock("MCP Help", getMcpCommandHelp("/mcp", { includeWizard: true }));
			return;
		}

		if (subcommand === "list" || subcommand === "status") {
			await this.refreshMcpRuntimeAndSession();
			this.showCommandTextBlock("MCP Servers", this.buildMcpStatusReport(this.mcpRuntime.getServers()));
			return;
		}

		if (subcommand === "add") {
			if (
				rest.length === 0 ||
				(rest.length === 1 && !rest[0]!.startsWith("-")) ||
				(rest.length > 0 && rest.includes("--wizard"))
			) {
				const prefilledName = rest.find((token) => !token.startsWith("-"));
				await this.runMcpAddWizard(prefilledName);
				return;
			}

			const parsed = parseMcpAddCommand(rest);
			if (!parsed.ok) {
				if ("help" in parsed) {
					this.showCommandTextBlock("MCP Help", getMcpCommandHelp("/mcp", { includeWizard: true }));
					return;
				}
				this.showWarning(parsed.error);
				return;
			}

			const path = await this.mcpRuntime.addServer(parsed.value.name, parsed.value.scope, parsed.value.config);
			this.syncMcpToolsWithSession();
			const status = this.mcpRuntime.getServer(parsed.value.name);
			this.showStatus(`Added MCP server ${parsed.value.name} (${parsed.value.scope})`);
			const extraLines = [`Config: ${path}`];
			if (status?.state === "connected") {
				extraLines.push(`Connected tools: ${status.toolCount}`);
			} else if (status?.state === "error") {
				extraLines.push(`Connection warning: ${status.error ?? "unknown error"}`);
			}
			this.showCommandTextBlock("MCP Add", extraLines.join("\n"));
			return;
		}

		if (subcommand === "remove") {
			const parsed = parseMcpTargetCommand(rest, "all");
			if (!parsed.ok) {
				if ("help" in parsed) {
					this.showCommandTextBlock("MCP Help", getMcpCommandHelp("/mcp", { includeWizard: true }));
					return;
				}
				this.showWarning(parsed.error);
				return;
			}
			const removed = await this.mcpRuntime.removeServer(parsed.value.name, parsed.value.scope);
			if (removed.length === 0) {
				this.showWarning(`MCP server "${parsed.value.name}" not found.`);
				return;
			}
			this.syncMcpToolsWithSession();
			this.showStatus(`Removed MCP server ${parsed.value.name} from ${removed.join(", ")}`);
			return;
		}

		if (subcommand === "enable" || subcommand === "disable") {
			const parsed = parseMcpTargetCommand(rest, "all");
			if (!parsed.ok) {
				if ("help" in parsed) {
					this.showCommandTextBlock("MCP Help", getMcpCommandHelp("/mcp", { includeWizard: true }));
					return;
				}
				this.showWarning(parsed.error);
				return;
			}

			const enabled = subcommand === "enable";
			let updatedScope: McpScope | undefined;
			if (parsed.value.scope === "all") {
				updatedScope =
					(await this.mcpRuntime.setServerEnabled(parsed.value.name, enabled, "project")) ??
					(await this.mcpRuntime.setServerEnabled(parsed.value.name, enabled, "user"));
			} else {
				updatedScope = await this.mcpRuntime.setServerEnabled(parsed.value.name, enabled, parsed.value.scope);
			}
			if (!updatedScope) {
				this.showWarning(`MCP server "${parsed.value.name}" not found.`);
				return;
			}
			this.syncMcpToolsWithSession();
			this.showStatus(`${enabled ? "Enabled" : "Disabled"} MCP server ${parsed.value.name} (${updatedScope})`);
			return;
		}

		if (subcommand === "reconnect" || subcommand === "refresh") {
			await this.refreshMcpRuntimeAndSession();
			this.showStatus("MCP servers refreshed");
			return;
		}

		if (subcommand === "tools") {
			await this.refreshMcpRuntimeAndSession();
			const serverName = rest[0];
			const statuses = this.mcpRuntime.getServers();
			const filtered = serverName ? statuses.filter((status) => status.name === serverName) : statuses;
			if (filtered.length === 0) {
				this.showWarning(serverName ? `MCP server "${serverName}" not found.` : "No MCP servers configured.");
				return;
			}
			this.showCommandTextBlock("MCP Tools", this.buildMcpStatusReport(filtered));
			return;
		}

		if (subcommand === "test") {
			const parsed = parseMcpTargetCommand(rest, "all");
			if (!parsed.ok) {
				if ("help" in parsed) {
					this.showCommandTextBlock("MCP Help", getMcpCommandHelp("/mcp", { includeWizard: true }));
					return;
				}
				this.showWarning(parsed.error);
				return;
			}
			await this.refreshMcpRuntimeAndSession();
			const status = this.mcpRuntime.getServer(parsed.value.name);
			if (!status) {
				this.showWarning(`MCP server "${parsed.value.name}" not found.`);
				return;
			}
			if (status.state !== "connected") {
				this.showError(`MCP server "${parsed.value.name}" failed: ${status.error ?? "unknown error"}`);
				return;
			}
			this.showStatus(`MCP server "${parsed.value.name}" connected (${status.toolCount} tools)`);
			return;
		}

		this.showWarning(`Unknown /mcp subcommand "${subcommand}". Use /mcp help.`);
	}

	private showMcpSelector(): void {
		if (!this.mcpRuntime) {
			this.showWarning("MCP runtime is unavailable in this session.");
			return;
		}

		this.showSelector((done) => {
			const selector = new McpSelectorComponent(this.ui, this.mcpRuntime!.getServers(), {
				onClose: () => {
					done();
					this.ui.requestRender();
				},
				onToggleEnabled: async (server) => {
					try {
						const targetEnabled = !server.enabled;
						const updated = await this.mcpRuntime!.setServerEnabled(server.name, targetEnabled, server.scope);
						if (!updated) {
							this.showWarning(`MCP server "${server.name}" not found.`);
							return;
						}
						this.syncMcpToolsWithSession();
						selector.setServers(this.mcpRuntime!.getServers());
						this.showStatus(`${targetEnabled ? "Enabled" : "Disabled"} ${server.name} (${updated})`);
					} catch (error) {
						this.showError(error instanceof Error ? error.message : String(error));
					}
				},
				onReconnect: async () => {
					try {
						await this.refreshMcpRuntimeAndSession();
						selector.setServers(this.mcpRuntime!.getServers());
						this.showStatus("MCP servers refreshed");
					} catch (error) {
						this.showError(error instanceof Error ? error.message : String(error));
					}
				},
				onRemove: async (server) => {
					try {
						const removed = await this.mcpRuntime!.removeServer(server.name, server.scope);
						if (removed.length === 0) {
							this.showWarning(`MCP server "${server.name}" not found.`);
							return;
						}
						this.syncMcpToolsWithSession();
						selector.setServers(this.mcpRuntime!.getServers());
						this.showStatus(`Removed ${server.name} (${removed.join(", ")})`);
					} catch (error) {
						this.showError(error instanceof Error ? error.message : String(error));
					}
				},
				onRefresh: async () => {
					try {
						await this.refreshMcpRuntimeAndSession();
						selector.setServers(this.mcpRuntime!.getServers());
						this.showStatus("MCP servers refreshed");
					} catch (error) {
						this.showError(error instanceof Error ? error.message : String(error));
					}
				},
				onInsertAddCommand: () => {
					done();
					this.editor.setText("/mcp add ");
					this.ui.requestRender();
				},
			});
			return { component: selector, focus: selector };
		});
	}

	private showSettingsSelector(): void {
		this.showSelector((done) => {
			const selector = new SettingsSelectorComponent(
				{
					autoCompact: this.session.autoCompactionEnabled,
					showImages: this.settingsManager.getShowImages(),
					autoResizeImages: this.settingsManager.getImageAutoResize(),
					blockImages: this.settingsManager.getBlockImages(),
					enableSkillCommands: this.settingsManager.getEnableSkillCommands(),
					steeringMode: this.session.steeringMode,
					followUpMode: this.session.followUpMode,
					streamInputMode: this.session.streamInputMode,
					transport: this.settingsManager.getTransport(),
					thinkingLevel: this.session.thinkingLevel,
					availableThinkingLevels: this.session.getAvailableThinkingLevels(),
					currentTheme: this.settingsManager.getTheme() || "dark",
					availableThemes: getAvailableThemes(),
					hideThinkingBlock: this.hideThinkingBlock,
					collapseChangelog: this.settingsManager.getCollapseChangelog(),
					doubleEscapeAction: this.settingsManager.getDoubleEscapeAction(),
					treeFilterMode: this.settingsManager.getTreeFilterMode(),
					showHardwareCursor: this.settingsManager.getShowHardwareCursor(),
					editorPaddingX: this.settingsManager.getEditorPaddingX(),
					autocompleteMaxVisible: this.settingsManager.getAutocompleteMaxVisible(),
					quietStartup: this.settingsManager.getQuietStartup(),
					clearOnShrink: this.settingsManager.getClearOnShrink(),
				},
				{
					onAutoCompactChange: (enabled) => {
						this.session.setAutoCompactionEnabled(enabled);
						this.footer.setAutoCompactEnabled(enabled);
					},
					onShowImagesChange: (enabled) => {
						this.settingsManager.setShowImages(enabled);
						for (const child of this.chatContainer.children) {
							if (child instanceof ToolExecutionComponent) {
								child.setShowImages(enabled);
							}
						}
					},
					onAutoResizeImagesChange: (enabled) => {
						this.settingsManager.setImageAutoResize(enabled);
					},
					onBlockImagesChange: (blocked) => {
						this.settingsManager.setBlockImages(blocked);
					},
					onEnableSkillCommandsChange: (enabled) => {
						this.settingsManager.setEnableSkillCommands(enabled);
						this.setupAutocomplete(this.fdPath);
					},
					onSteeringModeChange: (mode) => {
						this.session.setSteeringMode(mode);
					},
					onFollowUpModeChange: (mode) => {
						this.session.setFollowUpMode(mode);
					},
					onStreamInputModeChange: (mode) => {
						this.session.setStreamInputMode(mode);
					},
					onTransportChange: (transport) => {
						this.settingsManager.setTransport(transport);
						this.session.agent.setTransport(transport);
					},
					onThinkingLevelChange: (level) => {
						this.session.setThinkingLevel(level);
						this.footer.invalidate();
						this.updateEditorBorderColor();
					},
					onThemeChange: (themeName) => {
						const result = setTheme(themeName, true);
						this.settingsManager.setTheme(themeName);
						this.ui.invalidate();
						if (!result.success) {
							this.showError(`Failed to load theme "${themeName}": ${result.error}\nFell back to dark theme.`);
						}
					},
					onThemePreview: (themeName) => {
						const result = setTheme(themeName, true);
						if (result.success) {
							this.ui.invalidate();
							this.ui.requestRender();
						}
					},
					onHideThinkingBlockChange: (hidden) => {
						this.hideThinkingBlock = hidden;
						this.settingsManager.setHideThinkingBlock(hidden);
						for (const child of this.chatContainer.children) {
							if (child instanceof AssistantMessageComponent) {
								child.setHideThinkingBlock(hidden);
							}
						}
						this.chatContainer.clear();
						this.rebuildChatFromMessages();
					},
					onCollapseChangelogChange: (collapsed) => {
						this.settingsManager.setCollapseChangelog(collapsed);
					},
					onQuietStartupChange: (enabled) => {
						this.settingsManager.setQuietStartup(enabled);
					},
					onDoubleEscapeActionChange: (action) => {
						this.settingsManager.setDoubleEscapeAction(action);
					},
					onTreeFilterModeChange: (mode) => {
						this.settingsManager.setTreeFilterMode(mode);
					},
					onShowHardwareCursorChange: (enabled) => {
						this.settingsManager.setShowHardwareCursor(enabled);
						this.ui.setShowHardwareCursor(enabled);
					},
					onEditorPaddingXChange: (padding) => {
						this.settingsManager.setEditorPaddingX(padding);
						this.defaultEditor.setPaddingX(padding);
						if (this.editor !== this.defaultEditor && this.editor.setPaddingX !== undefined) {
							this.editor.setPaddingX(padding);
						}
					},
					onAutocompleteMaxVisibleChange: (maxVisible) => {
						this.settingsManager.setAutocompleteMaxVisible(maxVisible);
						this.defaultEditor.setAutocompleteMaxVisible(maxVisible);
						if (this.editor !== this.defaultEditor && this.editor.setAutocompleteMaxVisible !== undefined) {
							this.editor.setAutocompleteMaxVisible(maxVisible);
						}
					},
					onClearOnShrinkChange: (enabled) => {
						this.settingsManager.setClearOnShrink(enabled);
						this.ui.setClearOnShrink(enabled);
					},
					onCancel: () => {
						done();
						this.ui.requestRender();
					},
				},
			);
			return { component: selector, focus: selector.getSettingsList() };
		});
	}

	private async handleModelCommand(searchTerm?: string): Promise<void> {
		if (!searchTerm) {
			await this.showModelProviderSelector();
			return;
		}

		const model = await this.findExactModelMatch(searchTerm);
		if (model) {
			try {
				await this.session.setModel(model);
				this.footer.invalidate();
				this.updateEditorBorderColor();
				this.refreshBuiltInHeader();
				this.showStatus(`Model: ${model.id}`);
				this.checkDaxnutsEasterEgg(model);
			} catch (error) {
				this.showError(error instanceof Error ? error.message : String(error));
			}
			return;
		}

		this.showModelSelector(searchTerm);
	}

	private async showModelProviderSelector(preferredProvider?: string): Promise<void> {
		this.session.modelRegistry.refresh();
		let models: Model<any>[] = [];
		try {
			models = await this.session.modelRegistry.getAvailable();
		} catch {
			models = [];
		}
		if (models.length === 0) {
			this.showStatus("No models available");
			return;
		}

		const providerCounts = new Map<string, number>();
		for (const model of models) {
			providerCounts.set(model.provider, (providerCounts.get(model.provider) ?? 0) + 1);
		}
		const providers = Array.from(providerCounts.entries()).sort(([a], [b]) => a.localeCompare(b));
		if (providers.length === 0) {
			this.showStatus("No providers available");
			return;
		}

		if (preferredProvider) {
			const preferred = providers.find(([provider]) => provider.toLowerCase() === preferredProvider.toLowerCase());
			if (preferred) {
				this.showModelSelector(undefined, preferred[0]);
				return;
			}
		}

		if (providers.length === 1) {
			this.showModelSelector(undefined, providers[0]?.[0]);
			return;
		}

		const optionMap = new Map<string, string>();
		const options = ["All providers"];
		for (const [provider, count] of providers) {
			const optionLabel = `${provider} (${count})`;
			optionMap.set(optionLabel, provider);
			options.push(optionLabel);
		}

		const selected = await this.showExtensionSelector("/model: choose provider", options);
		if (!selected) return;
		if (selected === "All providers") {
			this.showModelSelector();
			return;
		}

		const provider = optionMap.get(selected);
		if (!provider) {
			this.showWarning("Provider selection is no longer available.");
			return;
		}
		this.showModelSelector(undefined, provider);
	}

	private async findExactModelMatch(searchTerm: string): Promise<Model<any> | undefined> {
		const term = searchTerm.trim();
		if (!term) return undefined;

		let targetProvider: string | undefined;
		let targetModelId = "";

		if (term.includes("/")) {
			const parts = term.split("/", 2);
			targetProvider = parts[0]?.trim().toLowerCase();
			targetModelId = parts[1]?.trim().toLowerCase() ?? "";
		} else {
			targetModelId = term.toLowerCase();
		}

		if (!targetModelId) return undefined;

		const models = await this.getModelCandidates();
		const exactMatches = models.filter((item) => {
			const idMatch = item.id.toLowerCase() === targetModelId;
			const providerMatch = !targetProvider || item.provider.toLowerCase() === targetProvider;
			return idMatch && providerMatch;
		});

		return exactMatches.length === 1 ? exactMatches[0] : undefined;
	}

	private async getModelCandidates(): Promise<Model<any>[]> {
		if (this.session.scopedModels.length > 0) {
			return this.session.scopedModels.map((scoped) => scoped.model);
		}

		this.session.modelRegistry.refresh();
		try {
			return await this.session.modelRegistry.getAvailable();
		} catch {
			return [];
		}
	}

	/** Update the footer's available provider count from current model candidates */
	private async updateAvailableProviderCount(): Promise<void> {
		const models = await this.getModelCandidates();
		const uniqueProviders = new Set(models.map((m) => m.provider));
		this.footerDataProvider.setAvailableProviderCount(uniqueProviders.size);
		this.refreshBuiltInHeader();
	}

	private showModelSelector(initialSearchInput?: string, providerFilter?: string): void {
		this.showSelector((done) => {
			const selector = new ModelSelectorComponent(
				this.ui,
				this.session.model,
				this.settingsManager,
				this.session.modelRegistry,
				this.session.scopedModels,
				async (model) => {
					try {
						await this.session.setModel(model);
						this.footer.invalidate();
						this.updateEditorBorderColor();
						this.refreshBuiltInHeader();
						done();
						this.showStatus(`Model: ${model.id}`);
						this.checkDaxnutsEasterEgg(model);
					} catch (error) {
						done();
						this.showError(error instanceof Error ? error.message : String(error));
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				initialSearchInput,
				providerFilter,
			);
			return { component: selector, focus: selector };
		});
	}

	private async showModelsSelector(): Promise<void> {
		// Get all available models
		this.session.modelRegistry.refresh();
		const allModels = this.session.modelRegistry.getAvailable();

		if (allModels.length === 0) {
			this.showStatus("No models available");
			return;
		}

		// Check if session has scoped models (from previous session-only changes or CLI --models)
		const sessionScopedModels = this.session.scopedModels;
		const hasSessionScope = sessionScopedModels.length > 0;

		// Build enabled model IDs from session state or settings
		const enabledModelIds = new Set<string>();
		let hasFilter = false;

		if (hasSessionScope) {
			// Use current session's scoped models
			for (const sm of sessionScopedModels) {
				enabledModelIds.add(`${sm.model.provider}/${sm.model.id}`);
			}
			hasFilter = true;
		} else {
			// Fall back to settings
			const patterns = this.settingsManager.getEnabledModels();
			if (patterns !== undefined && patterns.length > 0) {
				hasFilter = true;
				const scopedModels = await resolveModelScope(patterns, this.session.modelRegistry);
				for (const sm of scopedModels) {
					enabledModelIds.add(`${sm.model.provider}/${sm.model.id}`);
				}
			}
		}

		// Track current enabled state (session-only until persisted)
		const currentEnabledIds = new Set(enabledModelIds);
		let currentHasFilter = hasFilter;

		// Helper to update session's scoped models (session-only, no persist)
		const updateSessionModels = async (enabledIds: Set<string>) => {
			if (enabledIds.size > 0 && enabledIds.size < allModels.length) {
				const newScopedModels = await resolveModelScope(Array.from(enabledIds), this.session.modelRegistry);
				this.session.setScopedModels(
					newScopedModels.map((sm) => ({
						model: sm.model,
						thinkingLevel: sm.thinkingLevel,
					})),
				);
			} else {
				// All enabled or none enabled = no filter
				this.session.setScopedModels([]);
			}
			await this.updateAvailableProviderCount();
			this.ui.requestRender();
		};

		this.showSelector((done) => {
			const selector = new ScopedModelsSelectorComponent(
				{
					allModels,
					enabledModelIds: currentEnabledIds,
					hasEnabledModelsFilter: currentHasFilter,
				},
				{
					onModelToggle: async (modelId, enabled) => {
						if (enabled) {
							currentEnabledIds.add(modelId);
						} else {
							currentEnabledIds.delete(modelId);
						}
						currentHasFilter = true;
						await updateSessionModels(currentEnabledIds);
					},
					onEnableAll: async (allModelIds) => {
						currentEnabledIds.clear();
						for (const id of allModelIds) {
							currentEnabledIds.add(id);
						}
						currentHasFilter = false;
						await updateSessionModels(currentEnabledIds);
					},
					onClearAll: async () => {
						currentEnabledIds.clear();
						currentHasFilter = true;
						await updateSessionModels(currentEnabledIds);
					},
					onToggleProvider: async (_provider, modelIds, enabled) => {
						for (const id of modelIds) {
							if (enabled) {
								currentEnabledIds.add(id);
							} else {
								currentEnabledIds.delete(id);
							}
						}
						currentHasFilter = true;
						await updateSessionModels(currentEnabledIds);
					},
					onPersist: (enabledIds) => {
						// Persist to settings
						const newPatterns =
							enabledIds.length === allModels.length
								? undefined // All enabled = clear filter
								: enabledIds;
						this.settingsManager.setEnabledModels(newPatterns);
						this.showStatus("Model selection saved to settings");
					},
					onCancel: () => {
						done();
						this.ui.requestRender();
					},
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private showUserMessageSelector(): void {
		const userMessages = this.session.getUserMessagesForForking();

		if (userMessages.length === 0) {
			this.showStatus("No messages to fork from");
			return;
		}

		this.showSelector((done) => {
			const selector = new UserMessageSelectorComponent(
				userMessages.map((m) => ({ id: m.entryId, text: m.text })),
				async (entryId) => {
					const result = await this.session.fork(entryId);
					if (result.cancelled) {
						// Extension cancelled the fork
						done();
						this.ui.requestRender();
						return;
					}

					this.chatContainer.clear();
					this.renderInitialMessages();
					this.editor.setText(result.selectedText);
					done();
					this.showStatus("Branched to new session");
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector.getMessageList() };
		});
	}

	private showTreeSelector(initialSelectedId?: string): void {
		const tree = this.sessionManager.getTree();
		const realLeafId = this.sessionManager.getLeafId();
		const initialFilterMode = this.settingsManager.getTreeFilterMode();

		if (tree.length === 0) {
			this.showStatus("No entries in session");
			return;
		}

		this.showSelector((done) => {
			const selector = new TreeSelectorComponent(
				tree,
				realLeafId,
				this.ui.terminal.rows,
				async (entryId) => {
					// Selecting the current leaf is a no-op (already there)
					if (entryId === realLeafId) {
						done();
						this.showStatus("Already at this point");
						return;
					}

					// Ask about summarization
					done(); // Close selector first

					// Loop until user makes a complete choice or cancels to tree
					let wantsSummary = false;
					let customInstructions: string | undefined;

					// Check if we should skip the prompt (user preference to always default to no summary)
					if (!this.settingsManager.getBranchSummarySkipPrompt()) {
						while (true) {
							const summaryChoice = await this.showExtensionSelector("Summarize branch?", [
								"No summary",
								"Summarize",
								"Summarize with custom prompt",
							]);

							if (summaryChoice === undefined) {
								// User pressed escape - re-show tree selector with same selection
								this.showTreeSelector(entryId);
								return;
							}

							wantsSummary = summaryChoice !== "No summary";

							if (summaryChoice === "Summarize with custom prompt") {
								customInstructions = await this.showExtensionEditor("Custom summarization instructions");
								if (customInstructions === undefined) {
									// User cancelled - loop back to summary selector
									continue;
								}
							}

							// User made a complete choice
							break;
						}
					}

					// Set up escape handler and loader if summarizing
					let summaryLoader: Loader | undefined;
					const originalOnEscape = this.defaultEditor.onEscape;

					if (wantsSummary) {
						this.defaultEditor.onEscape = () => {
							void this.interruptCurrentWork();
						};
						this.chatContainer.addChild(new Spacer(1));
						summaryLoader = new Loader(
							this.ui,
							(spinner) => theme.fg("accent", spinner),
							(text) => theme.fg("muted", text),
							`Summarizing branch... (${appKey(this.keybindings, "interrupt")} to cancel)`,
						);
						this.statusContainer.addChild(summaryLoader);
						this.ui.requestRender();
					}

					try {
						const result = await this.session.navigateTree(entryId, {
							summarize: wantsSummary,
							customInstructions,
						});

						if (result.aborted) {
							// Summarization aborted - re-show tree selector with same selection
							this.showStatus("Branch summarization cancelled");
							this.showTreeSelector(entryId);
							return;
						}
						if (result.cancelled) {
							this.showStatus("Navigation cancelled");
							return;
						}

						// Update UI
						this.chatContainer.clear();
						this.renderInitialMessages();
						if (result.editorText && !this.editor.getText().trim()) {
							this.editor.setText(result.editorText);
						}
						this.showStatus("Navigated to selected point");
					} catch (error) {
						this.showError(error instanceof Error ? error.message : String(error));
					} finally {
						if (summaryLoader) {
							summaryLoader.stop();
							this.statusContainer.clear();
						}
						this.defaultEditor.onEscape = originalOnEscape;
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				(entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
					this.ui.requestRender();
				},
				initialSelectedId,
				initialFilterMode,
			);
			return { component: selector, focus: selector };
		});
	}

	private showSessionSelector(): void {
		this.showSelector((done) => {
			const selector = new SessionSelectorComponent(
				(onProgress) =>
					SessionManager.list(this.sessionManager.getCwd(), this.sessionManager.getSessionDir(), onProgress),
				SessionManager.listAll,
				async (sessionPath) => {
					done();
					await this.handleResumeSession(sessionPath);
				},
				() => {
					done();
					this.ui.requestRender();
				},
				() => {
					void this.shutdown();
				},
				() => this.ui.requestRender(),
				{
					renameSession: async (sessionFilePath: string, nextName: string | undefined) => {
						const next = (nextName ?? "").trim();
						if (!next) return;
						const mgr = SessionManager.open(sessionFilePath);
						mgr.appendSessionInfo(next);
					},
					showRenameHint: true,
					keybindings: this.keybindings,
				},

				this.sessionManager.getSessionFile(),
			);
			return { component: selector, focus: selector };
		});
	}

	private async handleResumeSession(sessionPath: string): Promise<void> {
		// Stop loading animation
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.statusContainer.clear();

		// Clear UI state
		this.pendingMessagesContainer.clear();
		this.compactionQueuedMessages = [];
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
		this.pendingTools.clear();

		// Switch session via AgentSession (emits extension session events)
		await this.session.switchSession(sessionPath);

		// Clear and re-render the chat
		this.chatContainer.clear();
		this.renderInitialMessages();
		this.refreshBuiltInHeader();
		this.showStatus("Resumed session");
	}

	private async showOAuthSelector(mode: "login" | "logout"): Promise<void> {
		if (mode === "logout") {
			const providers = this.session.modelRegistry.authStorage.list();
			const loggedInProviders = providers.filter((provider) => {
				const credential = this.session.modelRegistry.authStorage.get(provider);
				return credential?.type === "oauth" || credential?.type === "api_key";
			});
			if (loggedInProviders.length === 0) {
				this.showStatus("No saved provider credentials. Use /login first.");
				return;
			}
		}

		this.showSelector((done) => {
			const selector = new OAuthSelectorComponent(
				mode,
				this.session.modelRegistry.authStorage,
				async (providerId: string) => {
					done();

					if (mode === "login") {
						if (providerId === OPENROUTER_PROVIDER_ID) {
							await this.handleOpenRouterApiKeyLogin();
						} else {
							await this.showLoginDialog(providerId);
						}
					} else {
						// Logout flow
						const providerName = this.getProviderDisplayName(providerId);

						try {
							this.session.modelRegistry.authStorage.logout(providerId);
							this.session.modelRegistry.refresh();
							await this.updateAvailableProviderCount();
							this.showStatus(`Logged out of ${providerName}`);
						} catch (error: unknown) {
							this.showError(`Logout failed: ${error instanceof Error ? error.message : String(error)}`);
						}
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private getProviderDisplayName(providerId: string): string {
		if (providerId === OPENROUTER_PROVIDER_ID) {
			return "OpenRouter";
		}
		const providerInfo = this.session.modelRegistry.authStorage.getOAuthProviders().find((p) => p.id === providerId);
		return providerInfo?.name || providerId;
	}

	private async handleOpenRouterApiKeyLogin(): Promise<void> {
		const providerName = this.getProviderDisplayName(OPENROUTER_PROVIDER_ID);
		const existingCredential = this.session.modelRegistry.authStorage.get(OPENROUTER_PROVIDER_ID);
		if (existingCredential) {
			const overwrite = await this.showExtensionConfirm(
				`${providerName}: replace existing credentials?`,
				`Stored at ${getAuthPath()}`,
			);
			if (!overwrite) {
				this.showStatus(`${providerName} login cancelled.`);
				return;
			}
		}

		const keyInput = await this.showExtensionInput(
			`${providerName} API key\nCreate key: https://openrouter.ai/keys`,
			"sk-or-v1-...",
		);
		if (keyInput === undefined) {
			this.showStatus(`${providerName} login cancelled.`);
			return;
		}
		const apiKey = keyInput.trim();
		if (!apiKey) {
			this.showWarning(`${providerName} API key cannot be empty.`);
			return;
		}

		this.session.modelRegistry.authStorage.set(OPENROUTER_PROVIDER_ID, { type: "api_key", key: apiKey });
		this.session.modelRegistry.refresh();
		await this.updateAvailableProviderCount();
		this.showStatus(`${providerName} API key saved to ${getAuthPath()}`);
		await this.showModelProviderSelector(OPENROUTER_PROVIDER_ID);
	}

	private async showLoginDialog(providerId: string): Promise<void> {
		const providerInfo = this.session.modelRegistry.authStorage.getOAuthProviders().find((p) => p.id === providerId);
		const providerName = this.getProviderDisplayName(providerId);

		// Providers that use callback servers (can paste redirect URL)
		const usesCallbackServer = providerInfo?.usesCallbackServer ?? false;

		// Create login dialog component
		const dialog = new LoginDialogComponent(this.ui, providerId, (_success, _message) => {
			// Completion handled below
		});

		// Show dialog in editor container
		this.editorContainer.clear();
		this.editorContainer.addChild(dialog);
		this.ui.setFocus(dialog);
		this.ui.requestRender();

		// Promise for manual code input (racing with callback server)
		let manualCodeResolve: ((code: string) => void) | undefined;
		let manualCodeReject: ((err: Error) => void) | undefined;
		const manualCodePromise = new Promise<string>((resolve, reject) => {
			manualCodeResolve = resolve;
			manualCodeReject = reject;
		});

		// Restore editor helper
		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};

		try {
			await this.session.modelRegistry.authStorage.login(providerId as OAuthProviderId, {
				onAuth: (info: { url: string; instructions?: string }) => {
					dialog.showAuth(info.url, info.instructions);

					if (usesCallbackServer) {
						// Show input for manual paste, racing with callback
						dialog
							.showManualInput("Paste redirect URL below, or complete login in browser:")
							.then((value) => {
								if (value && manualCodeResolve) {
									manualCodeResolve(value);
									manualCodeResolve = undefined;
								}
							})
							.catch(() => {
								if (manualCodeReject) {
									manualCodeReject(new Error("Login cancelled"));
									manualCodeReject = undefined;
								}
							});
					} else if (providerId === "github-copilot") {
						// GitHub Copilot polls after onAuth
						dialog.showWaiting("Waiting for browser authentication...");
					}
					// For Anthropic: onPrompt is called immediately after
				},

				onPrompt: async (prompt: { message: string; placeholder?: string }) => {
					return dialog.showPrompt(prompt.message, prompt.placeholder);
				},

				onProgress: (message: string) => {
					dialog.showProgress(message);
				},

				onManualCodeInput: () => manualCodePromise,

				signal: dialog.signal,
			});

			// Success
			restoreEditor();
			this.session.modelRegistry.refresh();
			await this.updateAvailableProviderCount();
			this.showStatus(`Logged in to ${providerName}. Credentials saved to ${getAuthPath()}`);
			await this.showModelProviderSelector(providerId);
		} catch (error: unknown) {
			restoreEditor();
			const errorMsg = error instanceof Error ? error.message : String(error);
			if (errorMsg !== "Login cancelled") {
				this.showError(`Failed to login to ${providerName}: ${errorMsg}`);
			}
		}
	}

	// =========================================================================
	// Command handlers
	// =========================================================================

	private parseSlashArgs(input: string): string[] {
		const args: string[] = [];
		let current = "";
		let quote: '"' | "'" | undefined;
		let escape = false;

		for (const ch of input.trim()) {
			if (escape) {
				current += ch;
				escape = false;
				continue;
			}
			if (ch === "\\") {
				escape = true;
				continue;
			}
			if (quote) {
				if (ch === quote) {
					quote = undefined;
				} else {
					current += ch;
				}
				continue;
			}
			if (ch === '"' || ch === "'") {
				quote = ch;
				continue;
			}
			if (/\s/.test(ch)) {
				if (current) {
					args.push(current);
					current = "";
				}
				continue;
			}
			current += ch;
		}

		if (escape) {
			current += "\\";
		}
		if (current) {
			args.push(current);
		}

		return args;
	}

	private parseMemoryScopeOptions(args: string[]): { scope: MemoryScope; rest: string[]; error?: string } {
		let scope: MemoryScope = "project";
		const rest: string[] = [];

		for (let index = 0; index < args.length; index++) {
			const token = args[index] ?? "";
			const normalized = token.toLowerCase();

			if (normalized === "--project") {
				scope = "project";
				continue;
			}
			if (normalized === "--user") {
				scope = "user";
				continue;
			}
			if (normalized === "--scope") {
				const value = (args[index + 1] ?? "").toLowerCase();
				if (!value) {
					return { scope, rest, error: "Usage: /memory ... --scope <project|user>" };
				}
				if (value !== "project" && value !== "user") {
					return { scope, rest, error: `Invalid memory scope "${value}". Use project or user.` };
				}
				scope = value;
				index += 1;
				continue;
			}

			rest.push(token);
		}

		return { scope, rest };
	}

	private resolveMemoryPath(scope: MemoryScope): string {
		return getMemoryFilePath(scope, this.sessionManager.getCwd(), getAgentDir());
	}

	private formatMemoryEntriesReport(
		scope: MemoryScope,
		filePath: string,
		entries: Array<{ text: string; timestamp?: string }>,
		fileExists: boolean,
		hasManagedBlock: boolean,
	): string {
		const lines = [`Scope: ${scope}`, `File: ${filePath}`, ""];
		if (entries.length === 0) {
			if (!fileExists) {
				lines.push("Memory file does not exist yet.");
			} else if (!hasManagedBlock) {
				lines.push("Managed memory block not found in file.");
			} else {
				lines.push("No memory entries yet.");
			}
		} else {
			for (let index = 0; index < entries.length; index++) {
				const entry = entries[index]!;
				const prefix = entry.timestamp ? `[${entry.timestamp}] ` : "";
				lines.push(`${index + 1}. ${prefix}${entry.text}`);
			}
		}
		lines.push("");
		lines.push("Usage:");
		lines.push("  /memory                # interactive manager");
		lines.push("  /memory <text>");
		lines.push("  /memory add <text> [--scope project|user]");
		lines.push("  /memory edit <index> <text> [--scope project|user]");
		lines.push("  /memory list [--scope project|user]");
		lines.push("  /memory rm <index> [--scope project|user]");
		lines.push("  /memory path [--scope project|user]");
		return lines.join("\n");
	}

	private formatMemoryEntryOption(index: number, entry: { text: string; timestamp?: string }): string {
		const timestamp = entry.timestamp ? `[${entry.timestamp}] ` : "";
		const preview = entry.text.length > 90 ? `${entry.text.slice(0, 87)}...` : entry.text;
		return `${index}. ${timestamp}${preview}`;
	}

	private async selectMemoryEntry(
		scope: MemoryScope,
		action: string,
		entries: Array<{ text: string; timestamp?: string }>,
	): Promise<{ index: number; entry: { text: string; timestamp?: string } } | undefined> {
		if (entries.length === 0) {
			this.showStatus(`No memory entries in ${scope} scope.`);
			return undefined;
		}
		const options = entries.map((entry, index) => this.formatMemoryEntryOption(index + 1, entry));
		const picked = await this.showExtensionSelector(`/memory: ${action} (${scope})`, options);
		if (!picked) {
			return undefined;
		}
		const selectedIndex = options.indexOf(picked);
		if (selectedIndex < 0) {
			return undefined;
		}
		const entry = entries[selectedIndex];
		if (!entry) return undefined;
		return { index: selectedIndex + 1, entry };
	}

	private async reloadAfterMemoryMutation(successMessage: string, reloadFailurePrefix: string): Promise<void> {
		try {
			await this.session.reload();
			this.showStatus(successMessage);
		} catch (reloadError) {
			const message = reloadError instanceof Error ? reloadError.message : String(reloadError);
			this.showWarning(`${reloadFailurePrefix}: ${message}`);
		}
		this.refreshBuiltInHeader();
	}

	private async addMemoryViaCommand(scope: MemoryScope, memoryPath: string, rawText: string): Promise<void> {
		const saved = addMemoryEntry(memoryPath, rawText);
		const preview = saved.entry.text.length > 80 ? `${saved.entry.text.slice(0, 77)}...` : saved.entry.text;
		await this.reloadAfterMemoryMutation(
			`Memory saved (${scope}) #${saved.count}: ${preview}`,
			"Memory saved but context reload failed",
		);
	}

	private async updateMemoryViaCommand(
		scope: MemoryScope,
		memoryPath: string,
		index: number,
		rawText: string,
	): Promise<void> {
		const updated = updateMemoryEntry(memoryPath, index, rawText);
		const preview = updated.entry.text.length > 80 ? `${updated.entry.text.slice(0, 77)}...` : updated.entry.text;
		await this.reloadAfterMemoryMutation(
			`Updated memory #${index} (${scope}): ${preview}`,
			"Memory updated but context reload failed",
		);
	}

	private async removeMemoryViaCommand(scope: MemoryScope, memoryPath: string, index: number): Promise<void> {
		const removed = removeMemoryEntry(memoryPath, index);
		await this.reloadAfterMemoryMutation(
			`Removed memory #${index} (${scope}). Remaining: ${removed.count}`,
			"Memory removed but context reload failed",
		);
	}

	private async runMemoryInteractiveMenu(initialScope: MemoryScope): Promise<void> {
		let scope: MemoryScope = initialScope;

		while (true) {
			const memoryPath = this.resolveMemoryPath(scope);
			let summary;
			try {
				summary = readMemoryEntries(memoryPath);
			} catch (error) {
				this.showError(error instanceof Error ? error.message : String(error));
				return;
			}
			const fileExists = fs.existsSync(memoryPath);
			const entries = summary.entries;

			const optionAdd = "Add entry";
			const optionEdit = entries.length > 0 ? "Edit entry" : "Edit entry (no entries)";
			const optionRemove = entries.length > 0 ? "Remove entry" : "Remove entry (no entries)";
			const optionShow = "Show entries";
			const optionPath = "Show file path";
			const optionSwitchScope = `Switch scope (${scope === "project" ? "to user" : "to project"})`;
			const optionClose = "Close";
			const options = [optionAdd, optionEdit, optionRemove, optionShow, optionPath, optionSwitchScope, optionClose];

			const selected = await this.showExtensionSelector(
				`/memory manager (${scope})\n${memoryPath}\nentries: ${entries.length}${fileExists ? "" : " (file missing)"}`,
				options,
			);
			if (!selected || selected === optionClose) {
				return;
			}

			if (selected === optionAdd) {
				const rawText = await this.showExtensionInput(`/memory add (${scope})`, "project starts via PM2");
				if (rawText === undefined) continue;
				if (!rawText.trim()) {
					this.showWarning("Memory text cannot be empty.");
					continue;
				}
				try {
					await this.addMemoryViaCommand(scope, memoryPath, rawText);
				} catch (error) {
					this.showError(error instanceof Error ? error.message : String(error));
				}
				continue;
			}

			if (selected === optionEdit) {
				const chosen = await this.selectMemoryEntry(scope, "edit", entries);
				if (!chosen) continue;
				const edited = await this.showExtensionEditor(
					`Edit memory #${chosen.index} (${scope})`,
					chosen.entry.text,
				);
				if (edited === undefined) continue;
				if (!edited.trim()) {
					this.showWarning("Memory text cannot be empty.");
					continue;
				}
				try {
					await this.updateMemoryViaCommand(scope, memoryPath, chosen.index, edited);
				} catch (error) {
					this.showWarning(error instanceof Error ? error.message : String(error));
				}
				continue;
			}

			if (selected === optionRemove) {
				const chosen = await this.selectMemoryEntry(scope, "remove", entries);
				if (!chosen) continue;
				const confirmed = await this.showExtensionConfirm(
					"Remove memory entry?",
					`${this.formatMemoryEntryOption(chosen.index, chosen.entry)}\n${memoryPath}`,
				);
				if (!confirmed) {
					this.showStatus("Memory remove cancelled.");
					continue;
				}
				try {
					await this.removeMemoryViaCommand(scope, memoryPath, chosen.index);
				} catch (error) {
					this.showWarning(error instanceof Error ? error.message : String(error));
				}
				continue;
			}

			if (selected === optionShow) {
				this.showCommandTextBlock(
					"Memory",
					this.formatMemoryEntriesReport(scope, memoryPath, entries, fileExists, summary.hasManagedBlock),
				);
				continue;
			}

			if (selected === optionPath) {
				this.showCommandTextBlock("Memory Path", `Scope: ${scope}\nFile: ${memoryPath}`);
				continue;
			}

			if (selected === optionSwitchScope) {
				scope = scope === "project" ? "user" : "project";
				this.showStatus(`Memory manager switched to ${scope} scope.`);
				continue;
			}
		}
	}

	private async handleMemoryCommand(text: string): Promise<void> {
		const args = this.parseSlashArgs(text).slice(1);
		const parsedScope = this.parseMemoryScopeOptions(args);
		if (parsedScope.error) {
			this.showWarning(parsedScope.error);
			return;
		}

		const { scope, rest } = parsedScope;
		const subcommand = rest[0]?.toLowerCase();

		if (!subcommand || subcommand === "ui") {
			await this.runMemoryInteractiveMenu(scope);
			return;
		}

		const memoryPath = this.resolveMemoryPath(scope);

		if (subcommand === "list" || subcommand === "ls") {
			try {
				const summary = readMemoryEntries(memoryPath);
				const fileExists = fs.existsSync(memoryPath);
				this.showCommandTextBlock(
					"Memory",
					this.formatMemoryEntriesReport(scope, memoryPath, summary.entries, fileExists, summary.hasManagedBlock),
				);
			} catch (error) {
				this.showError(error instanceof Error ? error.message : String(error));
			}
			return;
		}

		if (subcommand === "help" || subcommand === "-h" || subcommand === "--help") {
			this.showCommandTextBlock(
				"Memory Help",
				[
					"Usage:",
					"  /memory [--scope project|user]",
					"  /memory ui [--scope project|user]",
					"  /memory <text> [--scope project|user]",
					"  /memory add <text> [--scope project|user]",
					"  /memory edit <index> <text> [--scope project|user]",
					"  /memory list [--scope project|user]",
					"  /memory rm <index> [--scope project|user]",
					"  /memory path [--scope project|user]",
					"",
					"Examples:",
					"  /memory",
					"  /memory project starts via PM2",
					"  /memory add deploy via npm run deploy --scope project",
					"  /memory edit 1 deploy via pnpm run deploy",
					"  /memory rm 2",
					"  /memory list --scope user",
				].join("\n"),
			);
			return;
		}

		if (subcommand === "path") {
			const lines = [`Scope: ${scope}`, `File: ${memoryPath}`];
			this.showCommandTextBlock("Memory Path", lines.join("\n"));
			return;
		}

		if (subcommand === "edit" || subcommand === "update") {
			const rawIndex = (rest[1] ?? "").trim();
			if (!rawIndex) {
				this.showWarning("Usage: /memory edit <index> <text> [--scope project|user]");
				return;
			}
			const index = Number.parseInt(rawIndex, 10);
			if (!Number.isFinite(index) || `${index}` !== rawIndex || index < 1) {
				this.showWarning(`Invalid memory index "${rawIndex}". Use a positive integer.`);
				return;
			}

			let rawText = rest.slice(2).join(" ").trim();
			if (!rawText) {
				try {
					const summary = readMemoryEntries(memoryPath);
					const target = summary.entries[index - 1];
					if (!target) {
						this.showWarning(`Memory entry #${index} not found.`);
						return;
					}
					const edited = await this.showExtensionEditor(`Edit memory #${index} (${scope})`, target.text);
					if (edited === undefined) {
						this.showStatus("Memory edit cancelled.");
						return;
					}
					rawText = edited;
				} catch (error) {
					this.showWarning(error instanceof Error ? error.message : String(error));
					return;
				}
			}

			try {
				await this.updateMemoryViaCommand(scope, memoryPath, index, rawText);
			} catch (error) {
				this.showWarning(error instanceof Error ? error.message : String(error));
			}
			return;
		}

		if (subcommand === "rm" || subcommand === "remove" || subcommand === "delete") {
			const rawIndex = (rest[1] ?? "").trim();
			if (!rawIndex) {
				this.showWarning("Usage: /memory rm <index> [--scope project|user]");
				return;
			}
			const index = Number.parseInt(rawIndex, 10);
			if (!Number.isFinite(index) || `${index}` !== rawIndex || index < 1) {
				this.showWarning(`Invalid memory index "${rawIndex}". Use a positive integer.`);
				return;
			}
			try {
				await this.removeMemoryViaCommand(scope, memoryPath, index);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.showWarning(message);
			}
			return;
		}

		const rawText = subcommand === "add" ? rest.slice(1).join(" ").trim() : rest.join(" ").trim();
		if (!rawText) {
			this.showWarning("Usage: /memory <text> [--scope project|user]");
			return;
		}

		try {
			await this.addMemoryViaCommand(scope, memoryPath, rawText);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private parseCheckpointNameFromLabel(label: string | undefined): string | undefined {
		if (!label) return undefined;
		if (!label.startsWith(CHECKPOINT_LABEL_PREFIX)) return undefined;
		const name = label.slice(CHECKPOINT_LABEL_PREFIX.length).trim();
		return name.length > 0 ? name : undefined;
	}

	private buildCheckpointLabel(name: string): string {
		return `${CHECKPOINT_LABEL_PREFIX}${name}`;
	}

	private normalizeCheckpointName(raw: string): string | undefined {
		const normalized = raw.replace(/\s+/g, " ").trim();
		if (!normalized) return undefined;
		if (normalized.length > 80) return undefined;
		return normalized;
	}

	private getSessionCheckpoints(): SessionCheckpoint[] {
		const active = new Map<string, SessionCheckpoint>();
		for (const entry of this.sessionManager.getEntries()) {
			if (entry.type !== "label") continue;
			const name = this.parseCheckpointNameFromLabel(entry.label);
			if (!name) {
				active.delete(entry.targetId);
				continue;
			}
			active.set(entry.targetId, {
				name,
				targetId: entry.targetId,
				labelEntryId: entry.id,
				timestamp: entry.timestamp,
			});
		}
		return [...active.values()].sort(
			(a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
		);
	}

	private buildDefaultCheckpointName(checkpoints: SessionCheckpoint[]): string {
		const used = new Set(checkpoints.map((checkpoint) => checkpoint.name.toLowerCase()));
		let index = 1;
		while (used.has(`cp-${index}`)) {
			index += 1;
		}
		return `cp-${index}`;
	}

	private formatCheckpointList(checkpoints: SessionCheckpoint[]): string {
		if (checkpoints.length === 0) {
			return "No checkpoints yet.\nCreate one with: /checkpoint [name]";
		}
		const newestFirst = [...checkpoints].reverse();
		const lines = newestFirst.map((checkpoint, index) => {
			const target = this.sessionManager.getEntry(checkpoint.targetId);
			const type = target?.type ?? "missing";
			return `${index + 1}. ${checkpoint.name} -> ${checkpoint.targetId} (${type}) @ ${checkpoint.timestamp}`;
		});
		lines.push("");
		lines.push("Usage: /rollback [name|index]");
		return lines.join("\n");
	}

	private formatCheckpointOption(index: number, checkpoint: SessionCheckpoint): string {
		const target = this.sessionManager.getEntry(checkpoint.targetId);
		const type = target?.type ?? "missing";
		return `${index}. ${checkpoint.name} -> ${checkpoint.targetId} (${type}) @ ${checkpoint.timestamp}`;
	}

	private handleCheckpointCommand(text: string): void {
		const args = this.parseSlashArgs(text).slice(1);
		const subcommand = args[0]?.toLowerCase();
		const checkpoints = this.getSessionCheckpoints();

		if (subcommand === "list" || subcommand === "ls") {
			this.showCommandTextBlock("Checkpoints", this.formatCheckpointList(checkpoints));
			return;
		}

		if (subcommand === "help" || subcommand === "-h" || subcommand === "--help") {
			this.showCommandTextBlock(
				"Checkpoint Help",
				["Usage:", "  /checkpoint [name]", "  /checkpoint list", "", "Examples:", "  /checkpoint", "  /checkpoint before-refactor"].join("\n"),
			);
			return;
		}

		const leafId = this.sessionManager.getLeafId();
		if (!leafId) {
			this.showWarning("Cannot create checkpoint yet (session has no entries).");
			return;
		}

		const requestedName = args.join(" ");
		const name = requestedName ? this.normalizeCheckpointName(requestedName) : this.buildDefaultCheckpointName(checkpoints);
		if (!name) {
			this.showWarning("Invalid checkpoint name. Use 1-80 visible characters.");
			return;
		}

		this.sessionManager.appendLabelChange(leafId, this.buildCheckpointLabel(name));
		this.showStatus(`Checkpoint saved: ${name} (${leafId})`);
	}

	private async handleRollbackCommand(text: string): Promise<void> {
		const args = this.parseSlashArgs(text).slice(1);
		const subcommand = args[0]?.toLowerCase();
		const checkpoints = this.getSessionCheckpoints();

		if (subcommand === "list" || subcommand === "ls") {
			this.showCommandTextBlock("Checkpoints", this.formatCheckpointList(checkpoints));
			return;
		}

		if (subcommand === "help" || subcommand === "-h" || subcommand === "--help") {
			this.showCommandTextBlock(
				"Rollback Help",
				[
					"Usage:",
					"  /rollback",
					"  /rollback <name>",
					"  /rollback <index>",
					"",
					"Examples:",
					"  /rollback",
					"  /rollback before-refactor",
					"  /rollback 2",
				].join("\n"),
			);
			return;
		}

		if (checkpoints.length === 0) {
			this.showWarning("No checkpoints available. Create one with /checkpoint.");
			return;
		}

		const newestFirst = [...checkpoints].reverse();
		const selector = args.join(" ").trim();
		let target: SessionCheckpoint | undefined = newestFirst[0];

		if (selector) {
			const numeric = Number.parseInt(selector, 10);
			if (Number.isFinite(numeric) && `${numeric}` === selector) {
				target = newestFirst[numeric - 1];
				if (!target) {
					this.showWarning(`Checkpoint index ${numeric} is out of range.`);
					return;
				}
			} else {
				target = newestFirst.find((checkpoint) => checkpoint.name === selector);
				if (!target) {
					this.showWarning(`Checkpoint "${selector}" not found.`);
					return;
				}
			}
		} else {
			const canShowInteractiveSelector = !!this.ui && !!this.editorContainer;
			if (canShowInteractiveSelector) {
				const options = newestFirst.map((checkpoint, index) => this.formatCheckpointOption(index + 1, checkpoint));
				const picked = await this.showExtensionSelector("/rollback: choose checkpoint", options);
				if (!picked) {
					this.showStatus("Rollback cancelled");
					return;
				}
				const selectedIndex = options.indexOf(picked);
				if (selectedIndex >= 0) {
					target = newestFirst[selectedIndex];
				}
			}
		}
		if (!target) {
			this.showWarning("No rollback target selected.");
			return;
		}

		try {
			const result = await this.session.navigateTree(target.targetId, { summarize: false });
			if (result.cancelled || result.aborted) {
				this.showStatus("Rollback cancelled");
				return;
			}

			this.chatContainer.clear();
			this.renderInitialMessages();
			if (result.editorText && !this.editor.getText().trim()) {
				this.editor.setText(result.editorText);
			}
			this.showStatus(`Rolled back to checkpoint: ${target.name}`);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async runDoctorInteractiveFixes(checks: DoctorCheckItem[]): Promise<void> {
		const canShowInteractiveSelector = !!this.ui && !!this.editorContainer;
		if (!canShowInteractiveSelector) {
			return;
		}

		const hasModelIssues = checks.some(
			(check) =>
				(check.label === "Active model" || check.label === "Active model auth" || check.label === "Available models") &&
				check.level === "fail",
		);
		const hasMcpIssues = checks.some((check) => check.label === "MCP servers" && check.level !== "ok");
		const hasResourceIssues = checks.some((check) => check.label === "Resources" && check.level !== "ok");

		while (true) {
			const options: string[] = [];
			if (hasModelIssues) {
				options.push("Open model selector");
				options.push("Login provider");
			}
			if (this.mcpRuntime) {
				if (hasMcpIssues) {
					options.push("Open MCP manager");
				}
				options.push("Refresh MCP runtime");
			}
			if (this.permissionMode === "yolo") {
				options.push("Set permissions mode to ask");
			}
			if (hasResourceIssues) {
				options.push("Reload resources");
			}
			options.push("Show auth/models paths");
			options.push("Close");

			const selected = await this.showExtensionSelector("/doctor fixes", options);
			if (!selected || selected === "Close") {
				return;
			}

			if (selected === "Open model selector") {
				await this.showModelProviderSelector();
				return;
			}
			if (selected === "Login provider") {
				await this.showOAuthSelector("login");
				return;
			}
			if (selected === "Open MCP manager") {
				await this.refreshMcpRuntimeAndSession();
				this.showMcpSelector();
				return;
			}
			if (selected === "Refresh MCP runtime") {
				await this.refreshMcpRuntimeAndSession();
				this.showStatus("MCP servers refreshed");
				continue;
			}
			if (selected === "Set permissions mode to ask") {
				this.permissionMode = "ask";
				this.settingsManager.setPermissionMode("ask");
				this.showStatus("Permissions: ask");
				continue;
			}
			if (selected === "Reload resources") {
				await this.handleReloadCommand();
				return;
			}
			if (selected === "Show auth/models paths") {
				this.showCommandTextBlock(
					"Runtime Paths",
					[`auth.json: ${getAuthPath()}`, `models.json: ${getModelsPath()}`].join("\n"),
				);
				continue;
			}
		}
	}

	private async handleDoctorCommand(text: string): Promise<void> {
		const args = this.parseSlashArgs(text).slice(1);
		const outputJson = args.includes("--json");
		const hooks = this.getHookPolicySummary();
		const model = this.session.model;
		const modelRegistry = this.session.modelRegistry;
		const allModels = modelRegistry.getAll();
		const availableModels = modelRegistry.getAvailable();
		const modelLoadError = modelRegistry.getError();
		const authProviders = modelRegistry.authStorage.list();
		const hasModelAuth = model ? modelRegistry.authStorage.hasAuth(model.provider) : false;
		const extensionErrors = this.session.resourceLoader.getExtensions().errors.length;
		const skillDiagnostics = this.session.resourceLoader.getSkills().diagnostics.length;
		const promptDiagnostics = this.session.resourceLoader.getPrompts().diagnostics.length;
		const themeDiagnostics = this.session.resourceLoader.getThemes().diagnostics.length;

		const mcpStatuses = this.mcpRuntime?.getServers() ?? [];
		const mcpConfigErrors = this.mcpRuntime?.getErrors() ?? [];
		const mcpConnected = mcpStatuses.filter((status) => status.state === "connected").length;
		const mcpErrored = mcpStatuses.filter((status) => status.state === "error").length;
		const mcpDisabled = mcpStatuses.filter((status) => !status.enabled).length;

		const checks: DoctorCheckItem[] = [];
		const addCheck = (
			level: DoctorCheckLevel,
			label: string,
			detail: string,
			fix?: string,
		) => checks.push({ level, label, detail, fix });

		if (!model) {
			addCheck("fail", "Active model", "No active model selected", "Run /model and pick a model.");
		} else if (!hasModelAuth) {
			addCheck(
				"fail",
				"Active model auth",
				`Model ${model.provider}/${model.id} has no auth configured`,
				`Run /login ${model.provider} or set API key env vars.`,
			);
		} else {
			addCheck("ok", "Active model", `${model.provider}/${model.id}`);
		}

		if (availableModels.length === 0) {
			addCheck("fail", "Available models", "No models currently have valid auth", "Run /login or configure API keys.");
		} else {
			addCheck("ok", "Available models", `${availableModels.length}/${allModels.length} ready`);
		}

		if (modelLoadError) {
			addCheck("warn", "models.json", modelLoadError.split("\n")[0] ?? modelLoadError, `Inspect ${getModelsPath()}.`);
		} else {
			addCheck("ok", "models.json", "Loaded without schema/runtime errors");
		}

		if (!fs.existsSync(getAuthPath())) {
			addCheck("warn", "auth.json", `Missing ${getAuthPath()}`, "Run /login to create credentials.");
		} else {
			addCheck("ok", "auth.json", `${authProviders.length} provider credential(s) stored`);
		}

		if (!this.mcpRuntime) {
			addCheck("warn", "MCP runtime", "Unavailable in this session");
		} else if (mcpStatuses.length === 0) {
			addCheck("warn", "MCP servers", "No MCP servers configured", "Use /mcp add or iosm mcp add ...");
		} else if (mcpErrored > 0 || mcpConfigErrors.length > 0) {
			addCheck(
				"warn",
				"MCP servers",
				`${mcpConnected} connected, ${mcpErrored} error, ${mcpDisabled} disabled`,
				"Open /mcp to reconnect or inspect server errors.",
			);
		} else {
			addCheck("ok", "MCP servers", `${mcpConnected} connected, ${mcpDisabled} disabled`);
		}

		if (extensionErrors > 0 || skillDiagnostics > 0 || promptDiagnostics > 0 || themeDiagnostics > 0) {
			addCheck(
				"warn",
				"Resources",
				`extensions:${extensionErrors} skills:${skillDiagnostics} prompts:${promptDiagnostics} themes:${themeDiagnostics}`,
				"Run /reload and inspect warnings shown in the chat.",
			);
		} else {
			addCheck("ok", "Resources", "No extension/skill/prompt/theme diagnostics");
		}

		addCheck(
			this.permissionMode === "yolo" ? "warn" : "ok",
			"Permissions",
			`mode=${this.permissionMode}, allowRules=${this.permissionAllowRules.length}, denyRules=${this.permissionDenyRules.length}`,
			this.permissionMode === "yolo" ? "Switch to /permissions ask for safer execution." : undefined,
		);

		addCheck(
			process.env[ENV_OFFLINE] ? "warn" : "ok",
			"Environment",
			`offline=${process.env[ENV_OFFLINE] ? "on" : "off"}, sessionTrace=${isSessionTraceEnabled() ? "on" : "off"}`,
			process.env[ENV_OFFLINE] ? "Unset IOSM_OFFLINE/PI_OFFLINE when network access is required." : undefined,
		);

		addCheck(
			"ok",
			"Hooks",
			hooks
				? `U${hooks.userPromptSubmit}/P${hooks.preToolUse}/T${hooks.postToolUse}/S${hooks.stop}`
				: "No hooks loaded",
		);

		const recommendations = [...new Set(checks.map((check) => check.fix).filter((fix): fix is string => !!fix))];

		if (outputJson) {
			this.showCommandJsonBlock("Doctor Report", {
				timestamp: new Date().toISOString(),
				cwd: this.sessionManager.getCwd(),
				sessionFile: this.sessionManager.getSessionFile() ?? null,
				activeProfile: this.activeProfileName,
				checks,
				recommendations,
			});
			return;
		}

		const lines: string[] = [];
		lines.push(`Timestamp: ${new Date().toISOString()}`);
		lines.push(`CWD: ${this.sessionManager.getCwd()}`);
		lines.push(`Session: ${this.sessionManager.getSessionFile() ?? "in-memory"}`);
		lines.push(`Profile: ${this.activeProfileName}`);
		lines.push("");
		for (const check of checks) {
			const prefix = check.level === "ok" ? "[OK]" : check.level === "warn" ? "[WARN]" : "[FAIL]";
			lines.push(`${prefix} ${check.label}: ${check.detail}`);
		}
		if (recommendations.length > 0) {
			lines.push("");
			lines.push("Recommended actions:");
			for (const recommendation of recommendations) {
				lines.push(`- ${recommendation}`);
			}
		}
		lines.push("");
		lines.push("Tip: /doctor --json");
		this.showCommandTextBlock("Doctor Report", lines.join("\n"));

		const wantsInteractiveFixes = !args.includes("--no-fix");
		if (wantsInteractiveFixes) {
			await this.runDoctorInteractiveFixes(checks);
		}
	}

	private showCommandTextBlock(title: string, body: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder());
		this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", title)), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(body, 1, 0));
		this.chatContainer.addChild(new DynamicBorder());
		this.ui.requestRender();
	}

	private showCommandJsonBlock(title: string, value: unknown): void {
		const json = JSON.stringify(value, null, 2);
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder());
		this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", title)), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Markdown(`\`\`\`json\n${json}\n\`\`\``, 1, 1, this.getMarkdownThemeWithSettings()));
		this.chatContainer.addChild(new DynamicBorder());
		this.ui.requestRender();
	}

	private async runIosmInitAgentVerification(
		result: IosmInitResult,
		targetDir: string,
		onEvent?: (event: AgentSessionEvent) => void,
	): Promise<IosmInitVerificationSummary> {
		if (!result.cycle) {
			return {
				completed: false,
				skippedReason: "No cycle scaffold was available for verification.",
			};
		}

		const cycleId = result.cycle.cycleId;
		process.env[ENV_SESSION_TRACE] = "1";
		process.env.PI_SESSION_TRACE = "1";

		const agentDir = getAgentDir();
		const settingsManager = SettingsManager.create(targetDir, agentDir);
		const settingsErrors = settingsManager.drainErrors();
		for (const { scope, error } of settingsErrors) {
			this.showWarning(`Init verify warning (${scope} settings): ${error.message}`);
		}

		const authStorage = AuthStorage.create();
		const modelRegistry = new ModelRegistry(authStorage, getModelsPath());
		const resourceLoader = new DefaultResourceLoader({
			cwd: targetDir,
			agentDir,
			settingsManager,
			noExtensions: true,
		});
		await resourceLoader.reload();

		const { session, modelFallbackMessage } = await createAgentSession({
			cwd: targetDir,
			sessionManager: SessionManager.inMemory(),
			settingsManager,
			authStorage,
			modelRegistry,
			resourceLoader,
		});
		let toolExecutions = 0;
		const activityLog: string[] = [];
		const pushActivity = (line: string, persist = false): void => {
			activityLog.push(line);
			if (activityLog.length > 30) {
				activityLog.shift();
			}
			if (persist) {
				this.showProgressLine(`IOSM init verify: ${line}`);
			}
		};
		const setVerifyLiveStatus = (message: string): void => {
			this.setWorkingMessage(`${message} (${appKey(this.keybindings, "interrupt")} to interrupt)`);
		};
		const unsubscribe = session.subscribe((event) => {
			onEvent?.(event);
			if (event.type === "turn_start") {
				pushActivity("agent turn started");
				setVerifyLiveStatus("Verifying workspace...");
				return;
			}
			if (event.type !== "tool_execution_start") {
				return;
			}
			toolExecutions += 1;
			if (event.toolName === "bash") {
				const commandRaw =
					event.args && typeof event.args === "object" && "command" in event.args
						? String((event.args as { command?: unknown }).command ?? "")
						: "";
				const preview = commandRaw.replace(/\s+/g, " ").trim().slice(0, 68);
				const line = `bash #${toolExecutions}${preview ? ` ${preview}${commandRaw.length > 68 ? "..." : ""}` : ""}`;
				pushActivity(line);
				setVerifyLiveStatus(`Verifying workspace · ${line}`);
				return;
			}
			const line = `${event.toolName} #${toolExecutions}`;
			pushActivity(line);
			setVerifyLiveStatus(`Verifying workspace · ${line}`);
		});
		this.iosmVerificationSession = session;

		try {
			if (!session.model) {
				return {
					completed: false,
					skippedReason:
						modelFallbackMessage ??
						"No model available for agent verification. Configure /login or an API key, then re-run /init.",
					activityLog,
				};
			}

			const timeoutMs = 180_000;
			const startedAt = Date.now();
			const heartbeatMs = 10_000;
			let nextPersistentHeartbeatSec = 30;
			let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
			let heartbeatHandle: ReturnType<typeof setInterval> | undefined;
			try {
				pushActivity("waiting for model response...", true);
				setVerifyLiveStatus("Waiting for model response...");
				heartbeatHandle = setInterval(() => {
					const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
					if (toolExecutions === 0 && elapsedSec >= nextPersistentHeartbeatSec) {
						pushActivity(`still waiting for model response (${elapsedSec}s)`, true);
						nextPersistentHeartbeatSec += 30;
					}
					setVerifyLiveStatus(
						toolExecutions === 0
							? `Waiting for model response... ${elapsedSec}s`
							: `Verifying workspace... ${elapsedSec}s · tool calls=${toolExecutions}`,
					);
				}, heartbeatMs);
				await Promise.race([
					session.prompt(buildIosmAgentVerificationPrompt(result), {
						expandPromptTemplates: false,
						skipIosmAutopilot: true,
						source: "interactive",
					}),
					new Promise<never>((_resolve, reject) => {
						timeoutHandle = setTimeout(() => {
							reject(new Error(`Verifier timeout after ${Math.round(timeoutMs / 1000)}s.`));
						}, timeoutMs);
					}),
				]);
			} finally {
				if (timeoutHandle) {
					clearTimeout(timeoutHandle);
				}
				if (heartbeatHandle) {
					clearInterval(heartbeatHandle);
				}
			}

			const messages = session.state.messages;
			let lastAssistant: AssistantMessage | undefined;
			for (let index = messages.length - 1; index >= 0; index--) {
				const message = messages[index];
				if (message.role === "assistant") {
					lastAssistant = message as AssistantMessage;
					break;
				}
			}

			if (
				lastAssistant &&
				(lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted")
			) {
				pushActivity(`agent finished with ${lastAssistant.stopReason}`);
				if (lastAssistant.stopReason === "aborted") {
					return {
						completed: false,
						cancelled: true,
						skippedReason: "Cancelled by user.",
						tracePath:
							session.sessionTracePath ??
							(isSessionTraceEnabled() ? getSessionTracePath(session.sessionManager.getSessionId()) : undefined),
						activityLog,
					};
				}
				return {
					completed: false,
					error: lastAssistant.errorMessage ?? `Verifier finished with ${lastAssistant.stopReason}.`,
					tracePath:
						session.sessionTracePath ??
						(isSessionTraceEnabled() ? getSessionTracePath(session.sessionManager.getSessionId()) : undefined),
					activityLog,
				};
			}

			let authoredGuide: string | undefined;
			try {
				pushActivity("authoring IOSM.md from repository evidence...");
				setVerifyLiveStatus("Authoring IOSM.md...");
				await session.prompt(buildIosmGuideAuthoringPrompt(result), {
					expandPromptTemplates: false,
					skipIosmAutopilot: true,
					source: "interactive",
				});
				const guideAssistant = (() => {
					const messages = session.state.messages;
					for (let index = messages.length - 1; index >= 0; index--) {
						const message = messages[index];
						if (message.role === "assistant") {
							return message as AssistantMessage;
						}
					}
					return undefined;
				})();
				const guideText = extractAssistantText(guideAssistant);
				const normalizedGuide = normalizeIosmGuideMarkdown(guideText);
				if (normalizedGuide.trim().length > 0) {
					authoredGuide = normalizedGuide;
					pushActivity("IOSM.md authored by agent");
				}
			} catch {
				pushActivity("agent IOSM.md authoring failed; using structured fallback");
			}

			let current: IosmMetricSnapshot | undefined;
			let guidePath: string | undefined;
			try {
				const report = readIosmCycleReport(result.rootDir, cycleId);
				current = createMetricSnapshot(report);
				if (authoredGuide) {
					guidePath = getIosmGuidePath(targetDir);
					fs.writeFileSync(guidePath, authoredGuide, "utf8");
				} else {
					guidePath = writeIosmGuideDocument(
						{
							rootDir: targetDir,
							cycleId,
							assessmentSource: "verified",
							metrics: report.metrics,
							iosmIndex: report.iosm_index,
							decisionConfidence: report.decision_confidence,
							goals: report.goals,
							filesAnalyzed: result.analysis.files_analyzed,
							sourceFileCount: result.analysis.source_file_count,
							testFileCount: result.analysis.test_file_count,
							docFileCount: result.analysis.doc_file_count,
						},
						true,
					).path;
				}
			} catch {
				current = undefined;
				guidePath = undefined;
			}

			let historyPath: string | undefined;
			try {
				const history = recordIosmCycleHistory(result.rootDir, cycleId);
				historyPath = history.historyPath;
			} catch {
				historyPath = undefined;
			}

			pushActivity(`completed (${toolExecutions} tool calls)`, true);
			return {
				completed: true,
				current,
				historyPath,
				guidePath,
				toolCalls: toolExecutions,
				tracePath:
					session.sessionTracePath ??
					(isSessionTraceEnabled() ? getSessionTracePath(session.sessionManager.getSessionId()) : undefined),
				activityLog,
			};
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			if (isAbortLikeMessage(message)) {
				pushActivity("cancelled by user", true);
				return {
					completed: false,
					cancelled: true,
					skippedReason: "Cancelled by user.",
					activityLog,
				};
			}
			pushActivity(`failed (${message})`);
			this.showWarning(`IOSM init verify: failed (${message})`);
			return {
				completed: false,
				error: message,
				activityLog,
			};
		} finally {
			try {
				if (session.isStreaming) {
					await session.abort();
				}
			} catch {
				// Best-effort shutdown to avoid a stuck verification loader.
			}
			if (this.iosmVerificationSession === session) {
				this.iosmVerificationSession = undefined;
			}
			unsubscribe();
			session.dispose();
			if (this.loadingAnimation) {
				this.loadingAnimation.stop();
				this.loadingAnimation = undefined;
			}
			this.statusContainer.clear();
			this.pendingWorkingMessage = undefined;
			this.ui.requestRender();
		}
	}

	private getLastAssistantMessage(): AssistantMessage | undefined {
		return this.session.messages
			.slice()
			.reverse()
			.find((message): message is AssistantMessage => {
				if (message.role !== "assistant") {
					return false;
				}
				return !(message.stopReason === "aborted" && message.content.length === 0);
			});
	}

	private sanitizeAssistantDisplayMessage(message: AssistantMessage): AssistantMessage {
		const hideAllTextForOrchestration = this.activeAssistantOrchestrationContext;
		let changed = false;
		const nextContent = message.content.map((content) => {
			if (content.type !== "text") return content;
			if (hideAllTextForOrchestration) {
				if (content.text !== "") {
					changed = true;
				}
				return { ...content, text: "" };
			}
			return content;
		});

		return changed ? { ...message, content: nextContent } : message;
	}

	private resolveMentionedAgent(text: string): string | undefined {
		const cwd = this.sessionManager.getCwd();
		const loaded = loadCustomSubagents({ cwd, agentDir: getAgentDir() });
		if (loaded.agents.length === 0) return undefined;
		const matches = text.matchAll(/(?:^|\s)@([^\s]+)/g);
		for (const match of matches) {
			const candidate = (match[1] ?? "").trim();
			const resolved = resolveCustomSubagentReference(candidate, loaded.agents);
			if (resolved) {
				return resolved;
			}
		}
		return undefined;
	}

	private isCapabilityQuery(text: string): boolean {
		const normalized = text.toLowerCase().trim();
		if (!normalized) return true;
		return (
			normalized === "?" ||
			normalized === "help" ||
			normalized === "--help" ||
			normalized === "/help" ||
			normalized === "/capabilities" ||
			normalized === "capabilities"
		);
	}

	private async promptWithTaskFallback(userInput: string): Promise<void> {
		const mentionedAgent = this.resolveMentionedAgent(userInput);
		if (mentionedAgent) {
			const cleaned = userInput.replace(/(?:^|\s)@[^\s]+/g, " ").trim();
			if (this.isCapabilityQuery(cleaned)) {
				const cwd = this.sessionManager.getCwd();
				const loaded = loadCustomSubagents({ cwd, agentDir: getAgentDir() });
				const agent = loaded.agents.find((item) => item.name === mentionedAgent);
				if (agent) {
					const capabilityPrompt = [
						"<agent_capability_query>",
						`agent_name: ${agent.name}`,
						`description: ${agent.description}`,
						`profile: ${agent.profile ?? "full"}`,
						`model: ${agent.model ?? "default"}`,
						`background: ${agent.background ? "true" : "false"}`,
						`tools: ${agent.tools?.join(", ") ?? "default profile tools"}`,
						`disallowed_tools: ${agent.disallowedTools?.join(", ") ?? "none"}`,
						"",
						"agent_instructions:",
						agent.instructions,
						"",
						`user_question: ${cleaned || "what can you do?"}`,
						"Answer normally and concisely in plain language. Do not run task tool for this query.",
						"</agent_capability_query>",
					].join("\n");
					await this.session.prompt(capabilityPrompt, {
						expandPromptTemplates: false,
						source: "interactive",
					});
					return;
				}
			}
			const mentionPrompt = [
				"<orchestrate mode=\"sequential\" agents=\"1\">",
				`- agent 1: profile=${this.activeProfileName} cwd=${this.sessionManager.getCwd()} agent=${mentionedAgent}`,
				`task: ${cleaned.length > 0 ? cleaned : userInput}`,
				"constraints:",
				"- user selected a concrete custom agent via @mention",
				`- MUST call task tool with agent="${mentionedAgent}"`,
				"</orchestrate>",
			].join("\n");
			await this.session.prompt(mentionPrompt, {
				expandPromptTemplates: false,
				source: "interactive",
			});
			return;
		}
		await this.session.prompt(userInput);
	}

	private createIosmVerificationEventBridge(options?: { loaderMessage?: string }): (event: AgentSessionEvent) => void {
		const loaderMessage =
			options?.loaderMessage ?? `Verifying workspace... (${appKey(this.keybindings, "interrupt")} to interrupt)`;
		let verifyStreamingComponent: AssistantMessageComponent | undefined;
		let verifyStreamingMessage: AssistantMessage | undefined;
		const verifyPendingTools = new Map<string, ToolExecutionComponent>();

		return (event: AgentSessionEvent): void => {
			switch (event.type) {
				case "agent_start":
					if (this.loadingAnimation) {
						this.loadingAnimation.stop();
					}
					this.statusContainer.clear();
					this.loadingAnimation = new DecryptLoader(
						this.ui,
						(s) => theme.fg("accent", s),
						(t) => theme.fg("muted", t),
						loaderMessage,
					);
					this.statusContainer.addChild(this.loadingAnimation);
					break;

				case "message_start":
					if (event.message.role === "assistant") {
						verifyStreamingComponent = new AssistantMessageComponent(
							undefined,
							false,
							this.getMarkdownThemeWithSettings(),
						);
						verifyStreamingMessage = event.message as AssistantMessage;
						this.chatContainer.addChild(verifyStreamingComponent);
						verifyStreamingComponent.updateContent(verifyStreamingMessage);
					}
					break;

				case "message_update":
					if (verifyStreamingComponent && event.message.role === "assistant") {
						verifyStreamingMessage = event.message as AssistantMessage;
						verifyStreamingComponent.updateContent(verifyStreamingMessage);
						for (const content of verifyStreamingMessage.content) {
							if (content.type === "toolCall" && !verifyPendingTools.has(content.id)) {
								const component = new ToolExecutionComponent(
									content.name,
									content.arguments,
									{ showImages: this.settingsManager.getShowImages() },
									this.getRegisteredToolDefinition(content.name),
									this.ui,
								);
								component.setExpanded(this.toolOutputExpanded);
								this.chatContainer.addChild(component);
								verifyPendingTools.set(content.id, component);
							}
						}
					}
					break;

				case "message_end":
					if (verifyStreamingComponent && event.message.role === "assistant") {
						verifyStreamingMessage = event.message as AssistantMessage;
						verifyStreamingComponent.updateContent(verifyStreamingMessage);
						verifyStreamingComponent = undefined;
						verifyStreamingMessage = undefined;
					}
					break;

				case "tool_execution_start":
					if (!verifyPendingTools.has(event.toolCallId)) {
						const component = new ToolExecutionComponent(
							event.toolName,
							event.args,
							{ showImages: this.settingsManager.getShowImages() },
							this.getRegisteredToolDefinition(event.toolName),
							this.ui,
						);
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);
						verifyPendingTools.set(event.toolCallId, component);
					}
					break;

				case "tool_execution_update": {
					const component = verifyPendingTools.get(event.toolCallId);
					if (component) {
						component.updateResult({ ...event.partialResult, isError: false }, true);
					}
					break;
				}

				case "tool_execution_end": {
					const component = verifyPendingTools.get(event.toolCallId);
					if (component) {
						component.updateResult({ ...event.result, isError: event.isError });
						verifyPendingTools.delete(event.toolCallId);
					}
					break;
				}

				case "agent_end":
					if (this.loadingAnimation) {
						this.loadingAnimation.stop();
						this.loadingAnimation = undefined;
						this.statusContainer.clear();
					}
					verifyPendingTools.clear();
					break;
			}

			this.ui.requestRender();
		};
	}

	private resolveIosmSnapshot(
		result: IosmInitResult,
		verification: IosmInitVerificationSummary | undefined,
	): IosmMetricSnapshot {
		let snapshot: IosmMetricSnapshot | undefined = verification?.current;
		if (!snapshot && result.cycle) {
			try {
				snapshot = createMetricSnapshot(readIosmCycleReport(result.rootDir, result.cycle.cycleId));
			} catch {
				snapshot = undefined;
			}
		}

		return (
			snapshot ?? {
				metrics: result.analysis.metrics,
				iosm_index: null,
				decision_confidence: null,
			}
		);
	}

	private async runIosmRefreshPass(options: {
		cwd: string;
		force: boolean;
		agentVerify: boolean;
	}): Promise<IosmAutomationRefreshResult> {
		const initResult = await initIosmWorkspace({ cwd: options.cwd, force: options.force });
		let verification: IosmInitVerificationSummary | undefined;
		if (options.agentVerify) {
			verification = await this.runIosmInitAgentVerification(
				initResult,
				options.cwd,
				this.createIosmVerificationEventBridge(),
			);
		}

		let cycleDecision: IosmDecision | undefined;
		if (initResult.cycle) {
			try {
				cycleDecision = inspectIosmCycle(initResult.rootDir, initResult.cycle.cycleId).decision;
			} catch {
				cycleDecision = undefined;
			}
		}

		return {
			initResult,
			verification,
			snapshot: this.resolveIosmSnapshot(initResult, verification),
			guidePath: verification?.guidePath ?? getIosmGuidePath(initResult.rootDir),
			cycleDecision,
		};
	}

	private parseIosmAutomationSlashCommand(
		text: string,
	): { targetIndex?: number; maxIterations?: number; forceInit: boolean } | undefined {
		const args = this.parseSlashArgs(text).slice(1);
		let targetIndex: number | undefined;
		let maxIterations: number | undefined;
		let forceInit = false;

		for (let index = 0; index < args.length; index++) {
			const arg = args[index];
			if (arg === "--force-init" || arg === "--force") {
				forceInit = true;
				continue;
			}
			if (arg === "--max-iterations") {
				const nextValue = args[index + 1];
				const parsed = nextValue ? Number.parseInt(nextValue, 10) : Number.NaN;
				if (!Number.isInteger(parsed) || parsed < 1) {
					this.showWarning('Usage: /iosm [target-index] [--max-iterations N] [--force-init]');
					return undefined;
				}
				maxIterations = parsed;
				index += 1;
				continue;
			}
			if (arg.startsWith("-")) {
				this.showWarning(`Unknown option for /iosm: ${arg}`);
				this.showWarning('Usage: /iosm [target-index] [--max-iterations N] [--force-init]');
				return undefined;
			}

			if (targetIndex !== undefined) {
				this.showWarning(`Unexpected argument for /iosm: ${arg}`);
				this.showWarning('Usage: /iosm [target-index] [--max-iterations N] [--force-init]');
				return undefined;
			}

			const parsed = Number.parseFloat(arg);
			if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
				this.showWarning(`Invalid target index for /iosm: ${arg}`);
				this.showWarning("Target index must be a number in the range 0.0 to 1.0.");
				return undefined;
			}
			targetIndex = parsed;
		}

		return { targetIndex, maxIterations, forceInit };
	}

	private parseOrchestrateSlashCommand(text: string): ParsedOrchestrateCommand | undefined {
		const args = this.parseSlashArgs(text).slice(1);
		let mode: OrchestrationMode | undefined;
		let agents: number | undefined;
		let maxParallel: number | undefined;
		let profile: AgentProfileName | undefined;
		let profiles: AgentProfileName[] | undefined;
		let cwds: string[] | undefined;
		let locks: string[] | undefined;
		let isolation: "none" | "worktree" | undefined;
		let dependencies: Array<{ agent: number; dependsOn: number[] }> | undefined;
		const taskParts: string[] = [];

		for (let index = 0; index < args.length; index++) {
			const arg = args[index];
			if (arg === "--parallel") {
				mode = "parallel";
				continue;
			}
			if (arg === "--sequential") {
				mode = "sequential";
				continue;
			}
			if (arg === "--agents") {
				const value = args[index + 1];
				const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
				if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
					this.showWarning("Invalid --agents value (expected 1..20).");
					return undefined;
				}
				agents = parsed;
				index += 1;
				continue;
			}
			if (arg === "--max-parallel") {
				const value = args[index + 1];
				const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
				if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
					this.showWarning("Invalid --max-parallel value (expected 1..20).");
					return undefined;
				}
				maxParallel = parsed;
				index += 1;
				continue;
			}
			if (arg === "--profile") {
				const value = args[index + 1];
				if (!value || !isValidProfileName(value)) {
					this.showWarning(`Invalid --profile value: ${value ?? "(missing)"}`);
					return undefined;
				}
				profile = value;
				index += 1;
				continue;
			}
			if (arg === "--profiles") {
				const value = args[index + 1];
				if (!value) {
					this.showWarning("Missing value for --profiles.");
					return undefined;
				}
				const parsedProfiles = value
					.split(",")
					.map((item) => item.trim())
					.filter(Boolean);
				if (parsedProfiles.length === 0 || parsedProfiles.some((item) => !isValidProfileName(item))) {
					this.showWarning(`Invalid --profiles value: ${value}`);
					return undefined;
				}
				profiles = parsedProfiles as AgentProfileName[];
				index += 1;
				continue;
			}
			if (arg === "--cwd") {
				const value = args[index + 1];
				if (!value) {
					this.showWarning("Missing value for --cwd.");
					return undefined;
				}
				cwds = value
					.split(",")
					.map((item) => item.trim())
					.filter(Boolean);
				index += 1;
				continue;
			}
			if (arg === "--locks") {
				const value = args[index + 1];
				if (!value) {
					this.showWarning("Missing value for --locks.");
					return undefined;
				}
				locks = value
					.split(",")
					.map((item) => item.trim())
					.filter(Boolean);
				index += 1;
				continue;
			}
			if (arg === "--worktree") {
				isolation = "worktree";
				continue;
			}
			if (arg === "--depends") {
				const value = args[index + 1];
				if (!value) {
					this.showWarning("Missing value for --depends.");
					return undefined;
				}
				const parsedDeps: Array<{ agent: number; dependsOn: number[] }> = [];
				const edges = value
					.split(",")
					.map((item) => item.trim())
					.filter(Boolean);
				for (const edge of edges) {
					const [left, right] = edge.split(">");
					const agent = Number.parseInt((left ?? "").trim(), 10);
					const dependency = Number.parseInt((right ?? "").trim(), 10);
					if (!Number.isInteger(agent) || !Number.isInteger(dependency) || agent < 1 || dependency < 1) {
						this.showWarning(`Invalid dependency edge: ${edge}. Expected format like 2>1,3>2`);
						return undefined;
					}
					const existing = parsedDeps.find((entry) => entry.agent === agent);
					if (existing) {
						existing.dependsOn.push(dependency);
					} else {
						parsedDeps.push({ agent, dependsOn: [dependency] });
					}
				}
				dependencies = parsedDeps.map((entry) => ({
					agent: entry.agent,
					dependsOn: [...new Set(entry.dependsOn)].sort((a, b) => a - b),
				}));
				index += 1;
				continue;
			}
			if (arg.startsWith("-")) {
				this.showWarning(`Unknown option for /orchestrate: ${arg}`);
				this.showWarning(
					"Usage: /orchestrate (--parallel|--sequential) --agents N [--max-parallel N] [--profile <name>|--profiles p1,p2] [--cwd p1,p2] [--locks l1,l2] [--worktree] [--depends 2>1,3>2] <task>",
				);
				return undefined;
			}
			taskParts.push(arg);
		}

		const task = taskParts.join(" ").trim();
		if (!mode || !agents || !task) {
			this.showWarning(
				"Usage: /orchestrate (--parallel|--sequential) --agents N [--max-parallel N] [--profile <name>|--profiles p1,p2] [--cwd p1,p2] [--locks l1,l2] [--worktree] [--depends 2>1,3>2] <task>",
			);
			return undefined;
		}
		if (profile && profiles) {
			this.showWarning("Use either --profile or --profiles, not both.");
			return undefined;
		}
		if (mode === "sequential" && maxParallel !== undefined) {
			this.showWarning("--max-parallel is only valid with --parallel mode.");
			return undefined;
		}
		if (maxParallel !== undefined && maxParallel > agents) {
			maxParallel = agents;
		}
		if (profiles && profiles.length < agents) {
			this.showWarning("--profiles count must be >= --agents or omitted.");
			return undefined;
		}
		if (cwds && cwds.length < agents) {
			this.showWarning("--cwd list count must be >= --agents or omitted.");
			return undefined;
		}
		if (locks && locks.length < agents) {
			this.showWarning("--locks list count must be >= --agents or omitted.");
			return undefined;
		}
		if (dependencies) {
			for (const dep of dependencies) {
				if (dep.agent > agents || dep.dependsOn.some((target) => target > agents || target === dep.agent)) {
					this.showWarning("Dependency graph references invalid agent indexes.");
					return undefined;
				}
			}
			if (hasDependencyCycle(agents, dependencies)) {
				this.showWarning("Dependency graph contains a cycle. Use a DAG for --depends.");
				return undefined;
			}
		}

		return {
			mode,
			agents,
			maxParallel,
			profile,
			profiles,
			cwds,
			locks,
			isolation,
			dependencies,
			task,
		};
	}

	private async handleOrchestrateSlashCommand(text: string): Promise<void> {
		if (this.session.isStreaming) {
			this.showWarning("Cannot run /orchestrate while the agent is processing a request.");
			return;
		}
		if (this.session.isCompacting) {
			this.showWarning("Cannot run /orchestrate while compaction is running.");
			return;
		}

		const parsed = this.parseOrchestrateSlashCommand(text);
		if (!parsed) {
			return;
		}

		const currentCwd = this.sessionManager.getCwd();
		const assignments: string[] = [];
		const assignmentRecords: Array<{ profile: string; cwd: string; lockKey?: string; dependsOn: number[] }> = [];
		for (let index = 0; index < parsed.agents; index++) {
			const assignmentProfile =
				parsed.profiles?.[index] ?? parsed.profile ?? (this.activeProfileName || "full");
			const assignmentCwd = parsed.cwds?.[index] ?? ".";
			const assignmentLock = parsed.locks?.[index];
			const dependsOn = parsed.dependencies?.find((entry) => entry.agent === index + 1)?.dependsOn ?? [];
			const resolvedCwd = path.resolve(currentCwd, assignmentCwd);
			assignmentRecords.push({
				profile: assignmentProfile,
				cwd: resolvedCwd,
				lockKey: assignmentLock,
				dependsOn,
			});
			assignments.push(
				`- agent ${index + 1}: profile=${assignmentProfile} cwd=${resolvedCwd}${assignmentLock ? ` lock_key=${assignmentLock}` : ""
				}${parsed.isolation === "worktree" ? " isolation=worktree" : ""}${dependsOn.length > 0 ? ` depends_on=${dependsOn.join("|")}` : ""
				}`,
			);
		}
		const teamRun = createTeamRun({
			cwd: currentCwd,
			mode: parsed.mode,
			agents: parsed.agents,
			maxParallel: parsed.maxParallel,
			task: parsed.task,
			assignments: assignmentRecords,
		});
		const runAssignments = teamRun.tasks.map(
			(task, index) => `${assignments[index]} run_id=${teamRun.runId} task_id=${task.id}`,
		);
		const taskCallHints = teamRun.tasks.map((task, index) => {
			const assignment = assignmentRecords[index];
			return `- task_call_${index + 1}: description="agent ${index + 1} execution" profile="${assignment.profile}" cwd="${assignment.cwd}" run_id="${teamRun.runId}" task_id="${task.id}"${assignment.lockKey ? ` lock_key="${assignment.lockKey}"` : ""
				}${parsed.isolation === "worktree" ? ' isolation="worktree"' : ""}`;
		});

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new Text(
				theme.bold(theme.fg("accent", "◆ ")) + theme.bold("/orchestrate") + theme.fg("muted", ` ${currentCwd}`),
				1,
				0,
			),
		);
		this.ui.requestRender();

		const payload = [
			`<orchestrate run_id="${teamRun.runId}" mode="${parsed.mode}" agents="${parsed.agents}"${parsed.maxParallel ? ` max_parallel="${parsed.maxParallel}"` : ""
			}>`,
			...runAssignments,
			"required_task_calls:",
			...taskCallHints,
			`task: ${parsed.task}`,
			"constraints:",
			"- use task tool for every agent assignment",
			"- for parallel mode, emit all independent task calls in one assistant response",
			"- in parallel mode, use parallel tool-call style (<use_parallel_tool_calls>)",
			"- keep required orchestration task calls in foreground; do not set background=true unless user explicitly requested detached async runs",
			"- do not poll .iosm/subagents/background via bash/read during orchestration; wait for task results and then synthesize",
			"- include run_id and task_id from each assignment in the task tool arguments",
			"- keep each agent in its assigned cwd",
			"- avoid edit collisions; if two write-capable agents target same area, serialize those writes",
			"- aggregate outputs into one concise final synthesis",
			"</orchestrate>",
		].join("\n");

		await this.session.prompt(payload, {
			expandPromptTemplates: false,
			source: "interactive",
		});
	}

	private async handleAgentsSlashCommand(text: string): Promise<void> {
		const args = this.parseSlashArgs(text).slice(1);
		const asJson = args.includes("--json");
		const cwd = this.sessionManager.getCwd();
		const loaded = loadCustomSubagents({ cwd, agentDir: getAgentDir() });
		const profiles = getProfileNames().map((name) => getAgentProfile(name));

		if (asJson) {
			this.showCommandJsonBlock("Agents", {
				profiles: profiles.map((profile) => ({
					name: profile.name,
					description: profile.description,
					tools: profile.tools,
					thinkingLevel: profile.thinkingLevel,
				})),
				customAgents: loaded.agents.map((agent) => ({
					name: agent.name,
					description: agent.description,
					profile: agent.profile,
					tools: agent.tools,
					disallowedTools: agent.disallowedTools,
					background: agent.background,
					cwd: agent.cwd,
					sourcePath: agent.sourcePath,
					sourceScope: agent.sourceScope,
				})),
				allCustomAgents: loaded.allAgents.map((agent) => ({
					name: agent.name,
					description: agent.description,
					profile: agent.profile,
					tools: agent.tools,
					disallowedTools: agent.disallowedTools,
					background: agent.background,
					cwd: agent.cwd,
					sourcePath: agent.sourcePath,
					sourceScope: agent.sourceScope,
					effective: agent.effective,
					overriddenByPath: agent.overriddenByPath,
				})),
				overrides: loaded.overrides,
				diagnostics: loaded.diagnostics,
			});
			return;
		}

		const options = [
			"Browse existing agents",
			"Use agent via @mention",
			"Create new agent with AI",
			"Edit existing agent file",
			"Delete agent file",
			"Show source precedence",
			"Show agents as text",
		];
		const selected = await this.showExtensionSelector("/agents", options);
		if (!selected) return;

		if (selected === "Show agents as text") {
			this.showCommandTextBlock("Agents", this.buildAgentsTextReport(profiles, loaded));
			return;
		}

		if (selected === "Create new agent with AI") {
			await this.createAgentWithAi();
			return;
		}

		if (selected === "Show source precedence") {
			this.showCommandTextBlock("Agent Source Precedence", this.buildAgentPrecedenceReport(loaded));
			return;
		}

		if (selected === "Use agent via @mention") {
			const chosen = await this.selectAgentRecord(
				loaded,
				"/agents: use @mention",
				loaded.agents,
				(agent) => this.formatAgentChoice(agent),
			);
			if (!chosen) return;
			this.insertAgentMention(chosen.name);
			return;
		}

		if (selected === "Edit existing agent file") {
			const editableAgents = loaded.allAgents.filter((agent) => agent.sourceScope !== "builtin");
			if (editableAgents.length === 0) {
				this.showStatus("No editable custom agent files found. Built-in system agents are read-only.");
				return;
			}
			const chosen = await this.selectAgentRecord(
				loaded,
				"/agents: edit file",
				editableAgents,
				(agent) => this.formatAgentChoice(agent, { includeScope: true, includeStatus: true }),
			);
			if (!chosen) return;
			await this.editAgentFile(chosen);
			return;
		}

		if (selected === "Delete agent file") {
			const deletableAgents = loaded.allAgents.filter((agent) => agent.sourceScope !== "builtin");
			if (deletableAgents.length === 0) {
				this.showStatus("No deletable custom agent files found. Built-in system agents are read-only.");
				return;
			}
			const chosen = await this.selectAgentRecord(
				loaded,
				"/agents: delete file",
				deletableAgents,
				(agent) => this.formatAgentChoice(agent, { includeScope: true, includeStatus: true }),
			);
			if (!chosen) return;
			await this.deleteAgentFile(chosen);
			return;
		}

		const chosen = await this.selectAgentRecord(
			loaded,
			"/agents: details",
			loaded.agents,
			(agent) => this.formatAgentChoice(agent, { includeScope: true }),
		);
		if (!chosen) return;
		this.showCommandTextBlock("Agent Details", this.buildAgentDetailReport(chosen, loaded));
	}

	private formatAgentChoice(
		agent: CustomSubagentEntry,
		options?: { includeScope?: boolean; includeStatus?: boolean },
	): string {
		const suffixParts: string[] = [];
		if (options?.includeScope) {
			suffixParts.push(agent.sourceScope);
		}
		if (options?.includeStatus) {
			suffixParts.push(agent.effective ? "active" : "shadowed");
		}
		const suffix = suffixParts.length > 0 ? ` [${suffixParts.join(", ")}]` : "";
		return `${agent.name} — ${agent.description}${suffix}`;
	}

	private async selectAgentRecord(
		loaded: ReturnType<typeof loadCustomSubagents>,
		title: string,
		candidates: CustomSubagentEntry[],
		labelBuilder: (agent: CustomSubagentEntry) => string,
	): Promise<CustomSubagentEntry | undefined> {
		if (candidates.length === 0) {
			this.showStatus("No custom agents found in .iosm/agents or global agents directory.");
			return undefined;
		}
		const options = candidates.map((agent, index) => `${index + 1}. ${labelBuilder(agent)}`);
		const picked = await this.showExtensionSelector(title, options);
		if (!picked) return undefined;
		const index = options.indexOf(picked);
		return index >= 0 ? candidates[index] : undefined;
	}

	private insertAgentMention(name: string): void {
		const current = this.editor.getText().trim();
		this.editor.setText(current ? `${current} @${name} ` : `@${name} `);
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
		this.showStatus(`Inserted @${name} into editor.`);
	}

	private buildAgentsTextReport(
		profiles: Array<ReturnType<typeof getAgentProfile>>,
		loaded: ReturnType<typeof loadCustomSubagents>,
	): string {
		const lines: string[] = [];
		lines.push("Built-in Profiles:");
		for (const profile of profiles) {
			lines.push(
				`- ${profile.name}: ${profile.description} · thinking=${profile.thinkingLevel} · tools=${profile.tools.join(", ")}`,
			);
		}
		lines.push("");
		lines.push(`Active Agents (${loaded.agents.length}):`);
		if (loaded.agents.length === 0) {
			lines.push("- none");
		} else {
			for (const agent of loaded.agents) {
				lines.push(
					`- ${agent.name}: ${agent.description} · profile=${agent.profile ?? "-"} · background=${agent.background ? "true" : "false"} · source=${agent.sourceScope}`,
				);
				lines.push(
					`  tools=${agent.tools?.join(", ") ?? "-"} · disallowed=${agent.disallowedTools?.join(", ") ?? "-"} · cwd=${agent.cwd ?? "-"} · path=${agent.sourcePath}`,
				);
			}
		}

		if (loaded.overrides.length > 0) {
			lines.push("");
			lines.push("Overrides:");
			for (const override of loaded.overrides) {
				lines.push(
					`- ${override.name}: ${override.winnerScope} (${override.winnerPath}) overrides ${override.overriddenScope} (${override.overriddenPath})`,
				);
			}
		}

		if (loaded.diagnostics.length > 0) {
			lines.push("");
			lines.push("Diagnostics:");
			for (const item of loaded.diagnostics) {
				lines.push(`- ${item.path}: ${item.message}`);
			}
		}
		return lines.join("\n");
	}

	private buildAgentPrecedenceReport(loaded: ReturnType<typeof loadCustomSubagents>): string {
		const lines: string[] = [];
		lines.push(`Active definitions: ${loaded.agents.length}`);
		lines.push(`All discovered definitions: ${loaded.allAgents.length}`);
		lines.push("");
		lines.push("Resolution order:");
		lines.push("- project (.iosm/agents) overrides global (~/.iosm/agent/agents)");
		lines.push("- global overrides built-in system agents shipped with CLI");
		lines.push("- within the same scope, later file path wins deterministically");
		lines.push("");
		if (loaded.overrides.length === 0) {
			lines.push("Overrides:");
			lines.push("- none");
		} else {
			lines.push("Overrides:");
			for (const override of loaded.overrides) {
				lines.push(
					`- ${override.name}: ${override.winnerScope} winner=${override.winnerPath} shadowed=${override.overriddenPath}`,
				);
			}
		}
		lines.push("");
		lines.push("All definitions:");
		for (const agent of loaded.allAgents) {
			lines.push(
				`- ${agent.name} [${agent.sourceScope}] ${agent.effective ? "active" : `shadowed by ${agent.overriddenByPath ?? "unknown"}`}`,
			);
			lines.push(`  ${agent.sourcePath}`);
		}
		return lines.join("\n");
	}

	private buildAgentDetailReport(
		agent: CustomSubagentEntry,
		loaded: ReturnType<typeof loadCustomSubagents>,
	): string {
		const overridden = loaded.allAgents.filter(
			(item) => item.name === agent.name && item.sourcePath !== agent.sourcePath,
		);
		const detailLines = [
			`${agent.name}: ${agent.description}`,
			`profile=${agent.profile ?? "-"}`,
			`background=${agent.background ? "true" : "false"}`,
			`source_scope=${agent.sourceScope}`,
			`status=${agent.effective ? "active" : "shadowed"}`,
			`tools=${agent.tools?.join(", ") ?? "-"}`,
			`disallowed=${agent.disallowedTools?.join(", ") ?? "-"}`,
			`cwd=${agent.cwd ?? "-"}`,
			`path=${agent.sourcePath}`,
		];
		if (agent.overriddenByPath) {
			detailLines.push(`overridden_by=${agent.overriddenByPath}`);
		}
		if (overridden.length > 0) {
			detailLines.push("", "Alternative definitions:");
			for (const entry of overridden) {
				detailLines.push(
					`- ${entry.sourceScope}: ${entry.sourcePath}${entry.effective ? " (active)" : " (shadowed)"}`,
				);
			}
		}
		detailLines.push("", "Usage: @agent_name <task>");
		return detailLines.join("\n");
	}

	private async editAgentFile(agent: CustomSubagentEntry): Promise<void> {
		if (!fs.existsSync(agent.sourcePath)) {
			this.showWarning(`Agent file not found: ${agent.sourcePath}`);
			return;
		}
		const current = fs.readFileSync(agent.sourcePath, "utf8");
		const edited = await this.showExtensionEditor(
			`Edit agent file: ${agent.name} (${agent.sourceScope})`,
			current,
		);
		if (edited === undefined) {
			return;
		}
		const normalized = edited.replace(/\r\n/g, "\n").trim();
		if (!normalized) {
			this.showWarning("Agent file cannot be empty.");
			return;
		}
		fs.writeFileSync(agent.sourcePath, `${normalized}\n`, "utf8");
		this.showStatus(`Updated agent: ${agent.sourcePath}`);
	}

	private async deleteAgentFile(agent: CustomSubagentEntry): Promise<void> {
		if (!fs.existsSync(agent.sourcePath)) {
			this.showWarning(`Agent file not found: ${agent.sourcePath}`);
			return;
		}
		const confirmed = await this.showExtensionConfirm(
			"Delete agent file?",
			`${agent.name} (${agent.sourceScope})\n${agent.sourcePath}`,
		);
		if (!confirmed) {
			this.showStatus("Agent deletion cancelled.");
			return;
		}
		fs.rmSync(agent.sourcePath, { force: true });
		this.showStatus(`Deleted agent file: ${agent.sourcePath}`);
	}

	private extractAssistantText(message: AssistantMessage): string {
		const parts: string[] = [];
		for (const content of message.content) {
			if (content.type === "text" && content.text.trim()) {
				parts.push(content.text.trim());
			}
		}
		return parts.join("\n\n").trim();
	}

	private extractFirstJsonObject(text: string): string | undefined {
		const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
		if (fenced?.[1]) {
			return fenced[1].trim();
		}
		const start = text.indexOf("{");
		const end = text.lastIndexOf("}");
		if (start >= 0 && end > start) {
			return text.slice(start, end + 1);
		}
		return undefined;
	}

	private sanitizeAgentFileName(name: string): string {
		return name
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, "-")
			.replace(/^-+/, "")
			.replace(/-+$/, "")
			.slice(0, 80);
	}

	private async createAgentWithAi(): Promise<void> {
		if (this.session.isStreaming || this.session.isCompacting || this.iosmAutomationRun || this.iosmVerificationSession) {
			this.showWarning("Cannot create agent while another run is active.");
			return;
		}
		const userSpec = await this.showExtensionInput(
			"Describe what the new agent should do",
			"e.g. agent that reviews migrations and proposes rollback-safe SQL",
		);
		if (!userSpec || !userSpec.trim()) {
			return;
		}

		const generationPrompt = [
			"You are generating a custom IOSM subagent specification.",
			"Return ONLY a single JSON object and no additional text.",
			'Allowed JSON keys: name, description, profile, tools, disallowed_tools, system_prompt, cwd, background, instructions.',
			'profile must be one of: full, plan, iosm, explore, iosm_analyst, iosm_verifier, cycle_planner.',
			"name must be short snake/kebab case, suitable for @mention.",
			"tools/disallowed_tools must be arrays of tool names when present.",
			"instructions must be a concise markdown body for the agent file.",
			"Follow prompt best practices:",
			"- Define explicit Role and Goal.",
			"- Define Scope boundaries (in-scope and out-of-scope).",
			"- Define required Workflow/Checklist steps.",
			"- Define strict Output format/sections.",
			"- Define uncertainty policy: ask for missing critical data instead of guessing.",
			"- Keep instructions concrete and testable; avoid vague phrasing.",
			"Prefer composition over broad power: default to read-oriented profiles unless write access is required.",
			"Built-in system agents already exist and can be extended by user agents:",
			"- codebase_auditor",
			"- system_error_analyst",
			"- iosm_change_executor",
			"- iosm_postchange_verifier",
			"- qa_test_engineer",
			"- test_failure_triager",
			"- meta_orchestrator",
			"",
			`User request: ${userSpec.trim()}`,
		].join("\n");

		await this.session.prompt(generationPrompt, {
			expandPromptTemplates: false,
			skipIosmAutopilot: true,
			skipOrchestrationDirective: true,
			source: "interactive",
		});

		const assistant = this.getLastAssistantMessage();
		if (!assistant || assistant.stopReason === "aborted" || assistant.stopReason === "error") {
			this.showWarning("Agent generation did not complete.");
			return;
		}
		const rawText = this.extractAssistantText(assistant);
		const jsonCandidate = this.extractFirstJsonObject(rawText);
		if (!jsonCandidate) {
			this.showWarning("Could not parse generated agent JSON.");
			return;
		}

		type GeneratedAgentSpec = {
			name?: unknown;
			description?: unknown;
			profile?: unknown;
			tools?: unknown;
			disallowed_tools?: unknown;
			system_prompt?: unknown;
			cwd?: unknown;
			background?: unknown;
			instructions?: unknown;
		};

		let parsed: GeneratedAgentSpec;
		try {
			parsed = JSON.parse(jsonCandidate) as GeneratedAgentSpec;
		} catch {
			this.showWarning("Generated JSON is invalid.");
			return;
		}

		const nameRaw = typeof parsed.name === "string" ? parsed.name.trim() : "";
		const fileName = this.sanitizeAgentFileName(nameRaw || "agent");
		if (!fileName) {
			this.showWarning("Generated agent name is empty.");
			return;
		}
		const description = typeof parsed.description === "string" ? parsed.description.trim() : `Custom agent ${fileName}`;
		const profile =
			typeof parsed.profile === "string" && isValidProfileName(parsed.profile) ? parsed.profile : "explore";
		const tools = Array.isArray(parsed.tools)
			? parsed.tools.map((item) => String(item).trim()).filter(Boolean)
			: undefined;
		const disallowedTools = Array.isArray(parsed.disallowed_tools)
			? parsed.disallowed_tools.map((item) => String(item).trim()).filter(Boolean)
			: undefined;
		const systemPrompt = typeof parsed.system_prompt === "string" ? parsed.system_prompt.trim() : undefined;
		const cwdField = typeof parsed.cwd === "string" ? parsed.cwd.trim() : undefined;
		const background = parsed.background === true;
		const instructions =
			typeof parsed.instructions === "string" && parsed.instructions.trim().length > 0
				? parsed.instructions.trim()
				: `Follow user instructions for ${description}.`;

		const frontmatter: string[] = [
			"---",
			`name: ${JSON.stringify(fileName)}`,
			`description: ${JSON.stringify(description)}`,
			`profile: ${profile}`,
		];
		if (tools && tools.length > 0) {
			frontmatter.push(`tools: [${tools.map((item) => JSON.stringify(item)).join(", ")}]`);
		}
		if (disallowedTools && disallowedTools.length > 0) {
			frontmatter.push(`disallowed_tools: [${disallowedTools.map((item) => JSON.stringify(item)).join(", ")}]`);
		}
		if (systemPrompt) {
			frontmatter.push(`system_prompt: ${JSON.stringify(systemPrompt)}`);
		}
		if (cwdField) {
			frontmatter.push(`cwd: ${JSON.stringify(cwdField)}`);
		}
		if (background) {
			frontmatter.push("background: true");
		}
		frontmatter.push("---", "", instructions, "");

		const agentsDir = path.join(this.sessionManager.getCwd(), ".iosm", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		const targetPath = path.join(agentsDir, `${fileName}.md`);
		if (fs.existsSync(targetPath)) {
			const overwrite = await this.showExtensionConfirm(
				"Overwrite existing agent?",
				`${targetPath} already exists.`,
			);
			if (!overwrite) {
				this.showStatus("Agent creation cancelled.");
				return;
			}
		}
		fs.writeFileSync(targetPath, frontmatter.join("\n"), "utf8");
		// Refresh autocomplete so the newly-created agent is immediately available in @ suggestions.
		this.setupAutocomplete(this.fdPath);
		this.showStatus(`Created agent: ${targetPath}`);

		const insertMention = await this.showExtensionConfirm(
			"Insert mention?",
			`Insert @${fileName} into the editor now?`,
		);
		if (insertMention) {
			const current = this.editor.getText().trim();
			this.editor.setText(current ? `${current} @${fileName} ` : `@${fileName} `);
			this.ui.requestRender();
		}
	}

	private handleSubagentRunsSlashCommand(text: string): void {
		const args = this.parseSlashArgs(text).slice(1);
		const limitRaw = args[0];
		const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 20;
		if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
			this.showWarning("Usage: /subagent-runs [limit: 1..200]");
			return;
		}

		const cwd = this.sessionManager.getCwd();
		const runs = listSubagentRuns(cwd, limit);
		if (runs.length === 0) {
			this.showStatus("No subagent runs found.");
			return;
		}

		const lines = runs.map((run, index) => {
			const created = run.createdAt ? ` · ${run.createdAt}` : "";
			const profile = run.profile ? ` · ${run.profile}` : "";
			const agent = run.agent ? ` · agent=${run.agent}` : "";
			const cwdPart = run.cwd ? ` · cwd=${run.cwd}` : "";
			const desc = run.description ? `\n  ${run.description}` : "";
			return `${index + 1}. ${run.runId}${profile}${agent}${cwdPart}${created}${desc}`;
		});
		this.showCommandTextBlock("Subagent Runs", lines.join("\n"));
	}

	private async handleSubagentResumeSlashCommand(text: string): Promise<void> {
		const args = this.parseSlashArgs(text).slice(1);
		const cwd = this.sessionManager.getCwd();
		let runId = args[0];
		let extraInstructions = args.slice(1).join(" ").trim();

		if (!runId) {
			const runs = listSubagentRuns(cwd, 20);
			if (runs.length === 0) {
				this.showStatus("No subagent runs found.");
				return;
			}
			const options = runs.map((run, index) => {
				const created = run.createdAt ? ` · ${run.createdAt}` : "";
				const profile = run.profile ? ` · ${run.profile}` : "";
				const agent = run.agent ? ` · agent=${run.agent}` : "";
				const desc = run.description ? ` · ${run.description}` : "";
				return `${index + 1}. ${run.runId}${profile}${agent}${created}${desc}`;
			});
			const picked = await this.showExtensionSelector("/subagent-resume: select run", options);
			if (!picked) {
				this.showStatus("Subagent resume cancelled.");
				return;
			}
			const selectedIndex = options.indexOf(picked);
			const selectedRun = selectedIndex >= 0 ? runs[selectedIndex] : undefined;
			if (!selectedRun) {
				this.showWarning("Selected subagent run is no longer available.");
				return;
			}
			runId = selectedRun.runId;

			const enteredInstructions = await this.showExtensionInput(
				"/subagent-resume: extra instructions (optional)",
				"leave blank to continue as-is",
			);
			if (enteredInstructions === undefined) {
				this.showStatus("Subagent resume cancelled.");
				return;
			}
			extraInstructions = enteredInstructions.trim();
		}

		const run = getSubagentRun(cwd, runId);
		if (!run) {
			this.showWarning(`Subagent run not found: ${runId}`);
			return;
		}
		const outputTail = (run.output ?? "").slice(-6000);
		const resumePrompt = [
			"<resume_subagent_run>",
			`run_id: ${run.runId}`,
			`profile: ${run.profile ?? "full"}`,
			`agent: ${run.agent ?? ""}`,
			`cwd: ${run.cwd ?? cwd}`,
			`lock_key: ${run.lockKey ?? ""}`,
			"Use the task tool to continue this workstream from the previous output context.",
			"",
			"Previous output (tail):",
			outputTail || "(empty)",
			"",
			extraInstructions ? `Additional instructions:\n${extraInstructions}\n` : "",
			"</resume_subagent_run>",
		]
			.filter(Boolean)
			.join("\n");

		await this.session.prompt(resumePrompt, {
			expandPromptTemplates: false,
			source: "interactive",
		});
	}

	private handleTeamRunsSlashCommand(text: string): void {
		const args = this.parseSlashArgs(text).slice(1);
		const limitRaw = args[0];
		const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 20;
		if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
			this.showWarning("Usage: /team-runs [limit: 1..200]");
			return;
		}
		const cwd = this.sessionManager.getCwd();
		const runs = listTeamRuns(cwd, limit);
		if (runs.length === 0) {
			this.showStatus("No team runs found.");
			return;
		}

		const lines = runs.map((run, index) => {
			const done = run.tasks.filter((task) => task.status === "done").length;
			const errored = run.tasks.filter((task) => task.status === "error").length;
			return `${index + 1}. ${run.runId} · ${run.mode} · ${done}/${run.tasks.length} done · ${errored} error · ${run.createdAt}`;
		});
		this.showCommandTextBlock("Team Runs", lines.join("\n"));
	}

	private async handleTeamStatusSlashCommand(text: string): Promise<void> {
		const args = this.parseSlashArgs(text).slice(1);
		const cwd = this.sessionManager.getCwd();
		let runId = args[0];

		if (!runId) {
			const runs = listTeamRuns(cwd, 20);
			if (runs.length === 0) {
				this.showStatus("No team runs found.");
				return;
			}
			const canShowInteractiveSelector = !!this.ui && !!this.editorContainer;
			if (canShowInteractiveSelector) {
				const options = runs.map((run, index) => {
					const done = run.tasks.filter((task) => task.status === "done").length;
					const errored = run.tasks.filter((task) => task.status === "error").length;
					return `${index + 1}. ${run.runId} · ${run.mode} · ${done}/${run.tasks.length} done · ${errored} error · ${run.createdAt}`;
				});
				const selection = await this.showExtensionSelector("/team-status: select run", options);
				if (!selection) {
					this.showStatus("Team status cancelled.");
					return;
				}
				const selectedIndex = options.indexOf(selection);
				const selectedRun = selectedIndex >= 0 ? runs[selectedIndex] : undefined;
				if (!selectedRun) {
					this.showWarning("Selected team run is no longer available.");
					return;
				}
				runId = selectedRun.runId;
			} else {
				runId = runs[0]?.runId;
			}
		}
		if (!runId) {
			this.showWarning("No team run selected.");
			return;
		}
		const run = getTeamRun(cwd, runId);
		if (!run) {
			this.showWarning(`Team run not found: ${runId}`);
			return;
		}
		const lines = [
			`Run: ${run.runId}`,
			`Created: ${run.createdAt}`,
			`Mode: ${run.mode}`,
			`Agents: ${run.agents}`,
			`Max parallel: ${run.maxParallel ?? "n/a"}`,
			`Task: ${run.task}`,
			"",
			"Assignments:",
			...run.tasks.map((task) => {
				const deps = task.dependsOn.length > 0 ? task.dependsOn.join("|") : "-";
				return `- ${task.id}: status=${task.status} profile=${task.profile} cwd=${task.cwd}${task.lockKey ? ` lock=${task.lockKey}` : ""
					} depends_on=${deps}`;
			}),
		];
		this.showCommandTextBlock("Team Status", lines.join("\n"));
	}

	private showIosmAutomationSummaryCard(input: {
		status: IosmAutomationLoopStatus;
		targetIndex: number;
		maxIterations: number;
		iterationsCompleted: number;
		initialSnapshot: IosmMetricSnapshot;
		finalSnapshot: IosmMetricSnapshot;
		cycleId?: string;
		cycleDecision?: IosmDecision;
		error?: string;
		guidePath?: string;
	}): void {
		const resultLabel =
			input.status === "stabilized"
				? "stabilized"
				: input.status === "threshold_reached"
					? "requested threshold reached"
					: input.status === "cancelled"
						? "cancelled by user"
						: input.status === "max_iterations"
							? "iteration budget exhausted"
							: "failed";
		const deltaLines = summarizeMetricDelta(input.initialSnapshot, input.finalSnapshot);
		const remainingPriorities = buildIosmPriorityChecklist(input.finalSnapshot.metrics, 3)
			.map(
				(item, index) =>
					`${index + 1}. ${item.metric}=${item.value === null ? "n/a" : item.value.toFixed(3)} — ${item.action}`,
			)
			.join("\n");

		const lines = [
			`Result: ${resultLabel}`,
			`Target index: ${input.targetIndex.toFixed(3)}`,
			`Iterations completed: ${input.iterationsCompleted}/${input.maxIterations}`,
			`Cycle: ${input.cycleId ?? "unknown"}`,
			`Decision: ${input.cycleDecision ?? "unknown"}`,
			"",
			`Before: ${formatMetricSnapshot(input.initialSnapshot)}`,
			`After:  ${formatMetricSnapshot(input.finalSnapshot)}`,
			"",
			"Metric delta:",
			...(deltaLines.length > 0 ? deltaLines.map((line) => `- ${line}`) : ["- no metric movement detected"]),
			"",
			"Remaining priorities:",
			remainingPriorities,
		];

		if (input.guidePath) {
			lines.push("", `Guide: ${input.guidePath}`);
		}

		if (input.error) {
			lines.push("", `Error: ${input.error}`);
		}

		this.showCommandTextBlock("IOSM Automation", lines.join("\n"));
	}

	private async handleIosmAutomationSlashCommand(text: string): Promise<void> {
		if (this.activeProfileName !== "iosm") {
			this.showWarning("`/iosm` is available only in IOSM profile. Switch profile to `iosm` (Shift+Tab).");
			return;
		}
		if (this.session.isStreaming) {
			this.showWarning("Cannot run /iosm while the agent is processing a request.");
			return;
		}
		if (this.session.isCompacting) {
			this.showWarning("Cannot run /iosm while compaction is running.");
			return;
		}
		if (this.iosmAutomationRun) {
			this.showWarning("IOSM automation is already running.");
			return;
		}
		if (this.iosmVerificationSession) {
			this.showWarning("Cannot run /iosm while IOSM verification is running.");
			return;
		}

		const parsed = this.parseIosmAutomationSlashCommand(text);
		if (!parsed) {
			return;
		}

		const cwd = this.sessionManager.getCwd();
		const explicitTarget = parsed.targetIndex !== undefined;
		try {
			const { config: existingConfig } = loadIosmConfig(cwd);
			if (!existingConfig.iosm.automation.allow_agents) {
				this.showWarning("IOSM automation is disabled by iosm.automation.allow_agents=false.");
				return;
			}
		} catch {
			// Uninitialized workspaces are allowed; /iosm will bootstrap them first.
		}
		let targetIndex = parsed.targetIndex;
		let maxIterations = parsed.maxIterations;
		let initialSnapshot: IosmMetricSnapshot | undefined;
		let finalSnapshot: IosmMetricSnapshot | undefined;
		let cycleId: string | undefined;
		let cycleDecision: IosmDecision | undefined;
		let guidePath: string | undefined;
		let currentGoals: string[] = [];
		let criticalityProfile: ReturnType<typeof loadIosmConfig>["config"]["iosm"]["metadata"]["criticality_profile"] | undefined;
		let approvalRequirements: string[] = [];
		let errorMessage: string | undefined;
		let status: IosmAutomationLoopStatus = "failed";

		this.iosmAutomationRun = {
			cancelRequested: false,
			targetIndex,
			maxIterations,
			iterationsCompleted: 0,
		};
		const automationRun = this.iosmAutomationRun;

		try {
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Text(theme.bold(theme.fg("accent", "◆ ")) + theme.bold("/iosm") + theme.fg("muted", ` ${cwd}`), 1, 0),
			);
			this.ui.requestRender();

			const initialRefresh = await this.runIosmRefreshPass({
				cwd,
				force: parsed.forceInit,
				agentVerify: true,
			});
			const { config } = loadIosmConfig(cwd);
			const settings = resolveIosmAutomationSettings(config, {
				targetIndex: parsed.targetIndex,
				maxIterations: parsed.maxIterations,
			});
			if (!config.iosm.automation.allow_agents) {
				errorMessage = "IOSM automation is disabled by iosm.automation.allow_agents=false.";
				status = "failed";
				return;
			}
			targetIndex = settings.targetIndex;
			maxIterations = settings.maxIterations;
			automationRun.targetIndex = targetIndex;
			automationRun.maxIterations = maxIterations;
			criticalityProfile = config.iosm.metadata.criticality_profile;
			approvalRequirements = config.iosm.automation.human_approval_required_for;

			initialSnapshot = initialRefresh.snapshot;
			finalSnapshot = initialRefresh.snapshot;
			cycleId = initialRefresh.initResult.cycle?.cycleId;
			cycleDecision = initialRefresh.cycleDecision;
			guidePath = initialRefresh.guidePath;
			currentGoals = initialRefresh.initResult.analysis.goals;

			this.showProgressLine(
				`  Target IOSM index: ${targetIndex.toFixed(3)} · iteration budget: ${maxIterations}`,
			);
			this.showProgressLine(`  Current snapshot: ${formatMetricSnapshot(initialSnapshot)}`);

			if (!initialRefresh.verification?.completed) {
				if (initialRefresh.verification?.cancelled || automationRun.cancelRequested) {
					status = "cancelled";
					return;
				}
				errorMessage =
					initialRefresh.verification?.error ??
					initialRefresh.verification?.skippedReason ??
					"IOSM verification did not complete.";
				status = "failed";
				return;
			}

			const initialProgress = evaluateIosmAutomationProgress({
				snapshot: finalSnapshot,
				targetIndex,
				cycleDecision,
				explicitTarget,
			});
			if (initialProgress.failed) {
				errorMessage = "IOSM verifier marked the current cycle as FAIL.";
				status = "failed";
				return;
			}

			if ((!explicitTarget && initialProgress.stabilized) || initialProgress.targetSatisfied) {
				status = initialProgress.stabilized ? "stabilized" : "threshold_reached";
				return;
			}

			for (let iteration = 1; iteration <= maxIterations; iteration++) {
				if (automationRun.cancelRequested) {
					status = "cancelled";
					break;
				}

				if (explicitTarget && cycleDecision === "STOP" && !hasReachedIosmTarget(finalSnapshot, targetIndex)) {
					const previousCycleId = cycleId;
					this.showProgressLine("  Current cycle stabilized below the requested threshold; opening a fresh cycle.");
					const rollover = await this.runIosmRefreshPass({
						cwd,
						force: false,
						agentVerify: true,
					});
					finalSnapshot = rollover.snapshot;
					cycleId = rollover.initResult.cycle?.cycleId ?? cycleId;
					cycleDecision = rollover.cycleDecision;
					guidePath = rollover.guidePath;
					currentGoals = rollover.initResult.analysis.goals;

					if (!rollover.verification?.completed) {
						if (rollover.verification?.cancelled || automationRun.cancelRequested) {
							status = "cancelled";
							break;
						}
						errorMessage =
							rollover.verification?.error ??
							rollover.verification?.skippedReason ??
							"IOSM verification did not complete.";
						status = "failed";
						break;
					}

					const rolloverProgress = evaluateIosmAutomationProgress({
						snapshot: finalSnapshot,
						targetIndex,
						cycleDecision,
						explicitTarget,
					});
					if (rolloverProgress.failed) {
						errorMessage = "IOSM verifier marked the new cycle as FAIL.";
						status = "failed";
						break;
					}
					if (rolloverProgress.targetSatisfied) {
						status = rolloverProgress.stabilized ? "stabilized" : "threshold_reached";
						break;
					}
					if (previousCycleId === cycleId && rolloverProgress.stabilized) {
						errorMessage = "IOSM automation could not advance to a fresh cycle after stabilization.";
						status = "failed";
						break;
					}
				}

				const priorities = buildIosmPriorityChecklist(finalSnapshot.metrics, 3);
				this.showProgressLine(
					`  Iteration ${iteration}/${maxIterations}: improving from ${finalSnapshot.iosm_index === null ? "n/a" : finalSnapshot.iosm_index.toFixed(3)} toward ${targetIndex.toFixed(3)}`,
				);
				const iterationPromptTimeoutMs = 300_000;
				let iterationTimeout: ReturnType<typeof setTimeout> | undefined;
				try {
					await Promise.race([
						this.session.prompt(
							buildIosmAutomationPrompt({
								rootDir: cwd,
								cycleId,
								targetIndex,
								iteration,
								maxIterations,
								snapshot: finalSnapshot,
								goals: currentGoals,
								priorities,
								currentDecision: cycleDecision,
								criticalityProfile,
								approvalRequirements,
							}),
							{
								expandPromptTemplates: false,
								skipIosmAutopilot: true,
								source: "interactive",
							},
						),
						new Promise<never>((_resolve, reject) => {
							iterationTimeout = setTimeout(() => {
								reject(
									new Error(
										`/iosm iteration ${iteration} timed out after ${Math.round(iterationPromptTimeoutMs / 1000)}s.`,
									),
								);
							}, iterationPromptTimeoutMs);
						}),
					]);
				} catch (error: unknown) {
					const message = error instanceof Error ? error.message : String(error);
					if (message.includes("timed out")) {
						try {
							if (this.session.isStreaming) {
								await this.session.abort();
							}
						} catch {
							// best effort
						}
					}
					throw error;
				} finally {
					if (iterationTimeout) {
						clearTimeout(iterationTimeout);
					}
				}

				const lastAssistant = this.getLastAssistantMessage();
				if (lastAssistant?.stopReason === "aborted") {
					automationRun.cancelRequested = true;
					status = "cancelled";
					break;
				}
				if (lastAssistant?.stopReason === "error") {
					errorMessage = lastAssistant.errorMessage ?? "IOSM improvement turn failed.";
					status = "failed";
					break;
				}
				if (automationRun.cancelRequested) {
					status = "cancelled";
					break;
				}

				const refreshed = await this.runIosmRefreshPass({
					cwd,
					force: false,
					agentVerify: true,
				});
				finalSnapshot = refreshed.snapshot;
				cycleId = refreshed.initResult.cycle?.cycleId ?? cycleId;
				cycleDecision = refreshed.cycleDecision;
				guidePath = refreshed.guidePath;
				currentGoals = refreshed.initResult.analysis.goals;

				if (!refreshed.verification?.completed) {
					if (refreshed.verification?.cancelled || automationRun.cancelRequested) {
						status = "cancelled";
						break;
					}
					errorMessage =
						refreshed.verification?.error ??
						refreshed.verification?.skippedReason ??
						"IOSM verification did not complete.";
					status = "failed";
					break;
				}

				automationRun.iterationsCompleted = iteration;
				this.showProgressLine(`  Verified snapshot: ${formatMetricSnapshot(finalSnapshot)}`);

				const progress = evaluateIosmAutomationProgress({
					snapshot: finalSnapshot,
					targetIndex,
					cycleDecision,
					explicitTarget,
				});
				if (progress.failed) {
					errorMessage = "IOSM verifier marked the cycle as FAIL.";
					status = "failed";
					break;
				}
				if ((!explicitTarget && progress.stabilized) || progress.targetSatisfied) {
					status = progress.stabilized ? "stabilized" : "threshold_reached";
					break;
				}

				if (iteration === maxIterations) {
					status = "max_iterations";
				}
			}
		} catch (error: unknown) {
			errorMessage = error instanceof Error ? error.message : String(error);
			status = automationRun.cancelRequested ? "cancelled" : "failed";
		} finally {
			const iterationsCompleted = automationRun.iterationsCompleted;
			const resolvedTargetIndex = targetIndex;
			const resolvedMaxIterations = maxIterations;
			this.iosmAutomationRun = undefined;

			if (
				initialSnapshot &&
				finalSnapshot &&
				resolvedTargetIndex !== undefined &&
				resolvedMaxIterations !== undefined
			) {
				this.showIosmAutomationSummaryCard({
					status,
					targetIndex: resolvedTargetIndex,
					maxIterations: resolvedMaxIterations,
					iterationsCompleted,
					initialSnapshot,
					finalSnapshot,
					cycleId,
					cycleDecision,
					error: errorMessage,
					guidePath,
				});
			} else if (errorMessage) {
				this.showError(`IOSM automation failed: ${errorMessage}`);
			}
		}
	}

	private buildStandardInitPlaybook(cwd: string, generatedBody?: string): string {
		if (generatedBody && generatedBody.trim().length > 0) {
			const trimmed = generatedBody.trim();
			return trimmed.startsWith("# AGENTS.md") ? trimmed : `# AGENTS.md\n\n${trimmed}`;
		}

		const packageJsonPath = path.join(cwd, "package.json");
		let packageName: string | undefined;
		let scriptsSection = "";
		try {
			if (fs.existsSync(packageJsonPath)) {
				const raw = fs.readFileSync(packageJsonPath, "utf8");
				const parsed = JSON.parse(raw) as { name?: string; scripts?: Record<string, string> };
				if (typeof parsed.name === "string" && parsed.name.trim().length > 0) {
					packageName = parsed.name.trim();
				}
				if (parsed.scripts && typeof parsed.scripts === "object") {
					const entries = Object.entries(parsed.scripts).slice(0, 8);
					if (entries.length > 0) {
						scriptsSection = entries.map(([name, cmd]) => `  - \`npm run ${name}\`: \`${cmd}\``).join("\n");
					}
				}
			}
		} catch {
			// Keep template generation resilient even if package.json is malformed.
		}

		const keyFiles = ["README.md", "package.json", "tsconfig.json", ".env.example", "docker-compose.yml"]
			.filter((name) => fs.existsSync(path.join(cwd, name)))
			.map((name) => `- \`${name}\``)
			.join("\n");

		return [
			"# AGENTS.md",
			"",
			"This workspace is initialized in standard (non-IOSM) mode.",
			packageName ? `\n## Project\n- Name: \`${packageName}\`` : "",
			"",
			"## Role",
			"- Act as a pragmatic engineering agent.",
			"- Inspect relevant files first, then implement changes with minimal blast radius.",
			"- Verify changes with targeted checks/tests.",
			"",
			"## Project Startup",
			scriptsSection.length > 0
				? "- Use these project scripts first:\n" + scriptsSection
				: "- Define and document run/test/build commands here after initial setup.",
			"",
			"## Key Files",
			keyFiles.length > 0 ? keyFiles : "- Add key entrypoints and config files for quick onboarding.",
			"",
			"## Working Rules",
			"- Keep responses concise and concrete.",
			"- Prefer explicit file references and commands.",
			"- Use subagents when user explicitly requests delegation or parallelization.",
			"",
			"## Custom Agents",
			"- Put custom agent specs under `.iosm/agents/*.md`.",
			"- Use `@agent_name` in chat to target a custom agent explicitly.",
			"",
			"## Notes",
			"- Switch to profile `iosm` to enable IOSM methodology, `/iosm`, and IOSM artifact lifecycle.",
			"",
		].join("\n");
	}

	private async generateStandardAgentsGuideWithAgent(
		cwd: string,
		onEvent?: (event: AgentSessionEvent) => void,
	): Promise<{
		content: string;
		toolCallsStarted: number;
		toolCallsCompleted: number;
		assistantMessages: number;
		attempts: number;
	}> {
		const model = this.session.model;
		if (!model) {
			throw new Error("No model selected. Use /model first.");
		}

		const agentDir = getAgentDir();
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const authStorage = AuthStorage.create(getAuthPath());
		const modelRegistry = new ModelRegistry(authStorage, getModelsPath());
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd,
			sessionManager: SessionManager.inMemory(),
			settingsManager,
			authStorage,
			modelRegistry,
			resourceLoader,
			model,
			profile: "plan",
			enableTaskTool: false,
		});

		const existingAgentsPath = path.join(cwd, "AGENTS.md");
		const existingAgentsRaw = fs.existsSync(existingAgentsPath) ? fs.readFileSync(existingAgentsPath, "utf8") : "";
		const maxExistingChars = 12_000;
		const existingAgentsSnippet =
			existingAgentsRaw.length > maxExistingChars
				? `${existingAgentsRaw.slice(0, maxExistingChars)}\n\n<!-- truncated: ${existingAgentsRaw.length - maxExistingChars} chars omitted -->`
				: existingAgentsRaw;

		const chunks: string[] = [];
		let toolCallsStarted = 0;
		let toolCallsCompleted = 0;
		let assistantMessages = 0;
		const unsubscribe = session.subscribe((event) => {
			onEvent?.(event);
			if (event.type === "tool_execution_start") {
				toolCallsStarted += 1;
				return;
			}
			if (event.type === "tool_execution_end") {
				toolCallsCompleted += 1;
				return;
			}
			if (event.type === "message_end" && event.message.role === "assistant") {
				assistantMessages += 1;
				for (const part of event.message.content) {
					if (part.type === "text" && part.text.trim()) {
						chunks.push(part.text.trim());
					}
				}
			}
		});

		const prompt = [
			"Create AGENTS.md for this repository after inspecting the real project files.",
			existingAgentsSnippet.trim().length > 0
				? "An AGENTS.md already exists: preserve useful guidance, fill missing sections, and update stale parts."
				: "No AGENTS.md exists yet: create a complete first version.",
			"",
			"Requirements:",
			"- Explore repository structure and key files before writing.",
			"- You MUST call repository-inspection tools (ls/find/read/grep/bash) before final output.",
			"- Output ONLY final AGENTS.md content in markdown (no code fences, no commentary).",
			"- Include practical sections:",
			"  1) Project Overview",
			"  2) Stack and Runtime",
			"  3) Setup / Run / Test commands",
			"  4) Repository Map (important directories/files)",
			"  5) Development Workflow and Conventions",
			"  6) Troubleshooting / Pitfalls",
			"  7) Quick Task Playbooks (common tasks and where to edit)",
			"- Keep it concise but actionable.",
			"- Use concrete commands and file paths from this repository.",
			"- If information is unknown, say 'Unknown' instead of guessing.",
			existingAgentsSnippet.trim().length > 0 ? "" : undefined,
			existingAgentsSnippet.trim().length > 0 ? "Existing AGENTS.md:" : undefined,
			existingAgentsSnippet.trim().length > 0 ? "<existing_agents_md>" : undefined,
			existingAgentsSnippet.trim().length > 0 ? existingAgentsSnippet : undefined,
			existingAgentsSnippet.trim().length > 0 ? "</existing_agents_md>" : undefined,
		].join("\n");

		const strictRetryPrompt = [
			"Retry with strict validation:",
			"- First, inspect the repository using tools (ls/find/read/grep/bash).",
			"- Then output ONLY final AGENTS.md markdown.",
			"- Do not include commentary, plans, or fences.",
		].join("\n");

		try {
			let attempts = 0;
			let latestText = "";
			let latestAttemptToolCalls = 0;

			const runAttempt = async (attemptPrompt: string): Promise<{ text: string; toolCalls: number }> => {
				const chunkStart = chunks.length;
				const toolStart = toolCallsStarted;
				await session.prompt(attemptPrompt, { skipIosmAutopilot: true });
				const text = chunks.slice(chunkStart).join("\n\n").trim();
				return {
					text,
					toolCalls: Math.max(0, toolCallsStarted - toolStart),
				};
			};

			attempts += 1;
			const firstAttempt = await runAttempt(prompt);
			latestText = firstAttempt.text;
			latestAttemptToolCalls = firstAttempt.toolCalls;

			if (!latestText || latestAttemptToolCalls === 0) {
				attempts += 1;
				const secondAttempt = await runAttempt(strictRetryPrompt);
				latestText = secondAttempt.text;
				latestAttemptToolCalls = secondAttempt.toolCalls;
			}

			if (!latestText) {
				throw new Error("Agent returned empty AGENTS.md draft.");
			}
			if (latestAttemptToolCalls === 0) {
				throw new Error("Agent did not inspect repository files (0 tool calls).");
			}

			return {
				content: latestText,
				toolCallsStarted,
				toolCallsCompleted,
				assistantMessages,
				attempts,
			};
		} finally {
			unsubscribe();
			session.dispose();
		}
	}

	private async handleStandardInitSlashCommand(options: {
		cwd: string;
		force: boolean;
		agentVerify: boolean;
	}): Promise<void> {
		const playbookPath = path.join(options.cwd, "AGENTS.md");
		const agentsDir = path.join(options.cwd, ".iosm", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });

		const existed = fs.existsSync(playbookPath);
		this.showProgressLine(
			existed
				? "  Scanning repository and updating existing AGENTS.md with agent..."
				: "  Scanning repository and generating AGENTS.md with agent...",
		);
		const generated = await this.generateStandardAgentsGuideWithAgent(
			options.cwd,
			this.createIosmVerificationEventBridge({
				loaderMessage: `Initializing workspace... (${appKey(this.keybindings, "interrupt")} to interrupt)`,
			}),
		);
		fs.writeFileSync(playbookPath, this.buildStandardInitPlaybook(options.cwd, generated.content), "utf8");
		this.showCommandTextBlock(
			"Init (Standard Mode)",
			[
				`Profile: ${this.activeProfileName}`,
				`AGENTS.md: ${existed ? "updated" : "created"}`,
				`Generator: agent-driven repository scan (${generated.toolCallsStarted} tool calls, ${generated.assistantMessages} assistant messages, ${generated.attempts} attempt${generated.attempts > 1 ? "s" : ""})`,
				options.force && existed
					? "Mode: force overwrite requested."
					: "Mode: standard overwrite (existing guidance merged by agent when applicable).",
				`.iosm/agents: ready`,
				options.agentVerify
					? "Agent verification skipped in standard mode (available in profile `iosm`)."
					: "Verification: disabled.",
			].join("\n"),
		);
	}

	private async handleIosmInitSlashCommand(text: string): Promise<void> {
		if (this.session.isStreaming) {
			this.showWarning("Cannot run /init while the agent is processing a request.");
			return;
		}
		if (this.session.isCompacting) {
			this.showWarning("Cannot run /init while compaction is running.");
			return;
		}
		if (this.iosmAutomationRun) {
			this.showWarning("Cannot run /init while IOSM automation is running.");
			return;
		}
		if (this.iosmVerificationSession) {
			this.showWarning("Cannot run /init while IOSM verification is already running.");
			return;
		}

		const args = this.parseSlashArgs(text).slice(1);
		let force = false;
		let agentVerify = true;
		let targetDir: string | undefined;

		for (const arg of args) {
			if (arg === "-f" || arg === "--force") {
				force = true;
				continue;
			}
			if (arg === "--agent-verify") {
				agentVerify = true;
				continue;
			}
			if (arg === "--no-agent-verify" || arg === "--static-only") {
				agentVerify = false;
				continue;
			}
			if (arg.startsWith("-")) {
				this.showWarning(`Unknown option for /init: ${arg}`);
				this.showWarning("Usage: /init [path] [--force] [--no-agent-verify]");
				return;
			}
			if (!targetDir) {
				targetDir = arg;
				continue;
			}
			this.showWarning(`Unexpected argument for /init: ${arg}`);
			this.showWarning("Usage: /init [path] [--force] [--no-agent-verify]");
			return;
		}

		try {
			const cwd = path.resolve(this.sessionManager.getCwd(), targetDir ?? ".");
			if (this.activeProfileName !== "iosm") {
				await this.handleStandardInitSlashCommand({
					cwd,
					force,
					agentVerify,
				});
				return;
			}

			// Show init header in chat
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Text(
					theme.bold(theme.fg("accent", "◆ ")) + theme.bold("/init") + theme.fg("muted", ` ${cwd}`),
					1,
					0,
				),
			);
			this.ui.requestRender();

			const result = await initIosmWorkspace({ cwd, force });

			if (result.cycle?.reusedExistingCycle) {
				this.showProgressLine(`  Reusing existing cycle: ${result.cycle.cycleId}`);
			} else if (result.cycle) {
				this.showProgressLine(
					`  Analyzed ${result.analysis.files_analyzed} files (${result.analysis.source_file_count} src · ${result.analysis.test_file_count} tests · ${result.analysis.doc_file_count} docs)`,
				);
				this.showProgressLine(`  Created cycle: ${result.cycle.cycleId}`);
			}

			let verification: IosmInitVerificationSummary | undefined;
			if (agentVerify) {
				verification = await this.runIosmInitAgentVerification(
					result,
					cwd,
					this.createIosmVerificationEventBridge(),
				);
			}

			const currentSnapshot = this.resolveIosmSnapshot(result, verification);

			const checklist = buildIosmPriorityChecklist(currentSnapshot.metrics, 3);
			const guidePath = verification?.guidePath ?? getIosmGuidePath(result.rootDir);

			// Render rich summary card
			this.showIosmInitSummaryCard(result, currentSnapshot, checklist, guidePath, verification, agentVerify);
		} catch (error: unknown) {
			this.showError(
				`Failed to initialize IOSM workspace: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private showIosmInitSummaryCard(
		result: IosmInitResult,
		snapshot: IosmMetricSnapshot,
		checklist: ReturnType<typeof buildIosmPriorityChecklist>,
		guidePath: string,
		verification: IosmInitVerificationSummary | undefined,
		agentVerify: boolean,
	): void {
		const source = verification?.completed ? "verified" : "heuristic";
		const cycleId = result.cycle?.cycleId ?? "—";
		const home = process.env.HOME ?? "";

		const shortPath = (p: string): string =>
			home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;

		const metricBar = (value: number | null): string => {
			if (value === null) return "n/a ";
			const filled = Math.round(value * 8);
			return "█".repeat(filled) + "░".repeat(8 - filled) + ` ${value.toFixed(2)}`;
		};

		const statusIcon = (value: number | null): string => {
			if (value === null) return "?";
			if (value < 0.55) return "⚠";
			if (value < 0.75) return "~";
			return "✓";
		};

		const metrics = snapshot.metrics;
		const metricOrder: Array<keyof typeof metrics> = [
			"semantic",
			"logic",
			"performance",
			"simplicity",
			"modularity",
			"flow",
		];

		const metricRows = metricOrder
			.map((m) => {
				const v = metrics[m];
				const icon = statusIcon(v);
				const bar = metricBar(v);
				return `| ${icon} | ${m.padEnd(11)} | ${bar} |`;
			})
			.join("\n");

		const iosmIdx =
			snapshot.iosm_index !== null && snapshot.iosm_index !== undefined
				? snapshot.iosm_index.toFixed(3)
				: "n/a";
		const conf =
			snapshot.decision_confidence !== null && snapshot.decision_confidence !== undefined
				? snapshot.decision_confidence.toFixed(2)
				: "n/a";

		const priorityLines = checklist
			.map(
				(item, i) =>
					`${i + 1}. **${item.metric}** \`${item.value === null ? "n/a" : item.value.toFixed(2)}\` — ${item.action}`,
			)
			.join("\n");

		const goals =
			result.analysis.goals.length > 0 ? result.analysis.goals.map((g) => `- ${g}`).join("\n") : "- (none detected)";

		const fileStats = `${result.analysis.files_analyzed} total · ${result.analysis.source_file_count} src · ${result.analysis.test_file_count} tests · ${result.analysis.doc_file_count} docs`;

		const verifyStatus = !agentVerify
			? "_skipped (--no-agent-verify)_"
			: verification?.completed
				? `✓ completed (${verification.toolCalls ?? 0} tool calls)`
				: verification?.cancelled
					? "⚠ cancelled by user"
					: verification?.skippedReason
						? `⚠ skipped: ${verification.skippedReason}`
						: verification?.error
							? `✗ failed: ${verification.error}`
							: "_not run_";

		const md = `## IOSM workspace initialized

**Project:** \`${shortPath(result.rootDir)}\`
**Files:** ${fileStats}
**Cycle:** \`${cycleId}\`
**Assessment:** ${source}   **Verification:** ${verifyStatus}

### Detected goals
${goals}

### Metric scores

|   | Metric      | Score            |
|---|-------------|------------------|
${metricRows}

**IOSM-Index:** \`${iosmIdx}\`   **Confidence:** \`${conf}\`

### Top priorities this cycle

${priorityLines}

### Key workspace files

- \`IOSM.md\` — agent playbook (auto-loaded as context each session)
- \`iosm.yaml\` — cycle configuration${result.cycle ? `\n- \`.iosm/cycles/${cycleId}/cycle-report.json\`` : ""}
- \`${shortPath(guidePath)}\`

### Next steps

Re-read \`IOSM.md\`, then start a session describing which priority to tackle first.
The agent will automatically receive IOSM context on every turn.`;

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Markdown(md, 1, 0, this.getMarkdownThemeWithSettings()));
		this.chatContainer.addChild(new Spacer(1));
		this.ui.requestRender();
	}

	private handleIosmCycleListSlashCommand(): void {
		if (!this.requireIosmMode("/cycle-list")) return;
		try {
			const cycles = listIosmCycles(this.sessionManager.getCwd());
			if (cycles.length === 0) {
				this.showStatus("No IOSM cycles found.");
				return;
			}

			const lines: string[] = [];
			for (const cycle of cycles) {
				const goals = cycle.goals.length > 0 ? cycle.goals.join("; ") : "no goals recorded";
				lines.push(`${cycle.cycleId}  ${cycle.status}  ${cycle.decision}`);
				lines.push(`  ${goals}`);
			}
			this.showCommandTextBlock("IOSM Cycles", lines.join("\n"));
		} catch (error: unknown) {
			this.showError(`Failed to list IOSM cycles: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async handleIosmCyclePlanSlashCommand(text: string): Promise<void> {
		if (!this.requireIosmMode("/cycle-plan")) return;
		const args = this.parseSlashArgs(text).slice(1);
		let force = false;
		let cycleId: string | undefined;
		const goals: string[] = [];

		for (let index = 0; index < args.length; index++) {
			const arg = args[index];
			if (arg === "-f" || arg === "--force") {
				force = true;
				continue;
			}
			if (arg === "--id") {
				if (index + 1 >= args.length) {
					this.showWarning('Missing value for "--id".');
					this.showWarning('Usage: /cycle-plan [--id <cycle-id>] [--force] "goal one" "goal two"');
					return;
				}
				cycleId = args[index + 1];
				index += 1;
				continue;
			}
			if (arg.startsWith("-")) {
				this.showWarning(`Unknown option for /cycle-plan: ${arg}`);
				this.showWarning('Usage: /cycle-plan [--id <cycle-id>] [--force] "goal one" "goal two"');
				return;
			}
			goals.push(arg);
		}

		if (goals.length === 0) {
			this.showWarning('Usage: /cycle-plan [--id <cycle-id>] [--force] "goal one" "goal two"');
			return;
		}

		try {
			const planned = planIosmCycle({
				cwd: this.sessionManager.getCwd(),
				goals,
				force,
				cycleId,
			});
			this.showCommandTextBlock(
				"IOSM Cycle Plan",
				[
					`Planned IOSM cycle ${planned.cycleId}`,
					`  ${planned.cycleDir}`,
					`  baseline: ${planned.baselineReportPath}`,
					`  hypotheses: ${planned.hypothesesPath}`,
					`  report: ${planned.reportPath}`,
				].join("\n"),
			);
		} catch (error: unknown) {
			this.showError(`Failed to plan IOSM cycle: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private formatIosmCycleSelectionOption(index: number, cycle: ReturnType<typeof listIosmCycles>[number]): string {
		const goals = cycle.goals.length > 0 ? cycle.goals.join("; ") : "no goals recorded";
		return `${index}. ${cycle.cycleId} · ${cycle.status} · ${cycle.decision} · ${goals}`;
	}

	private async selectIosmCycleId(commandName: "/cycle-report" | "/cycle-status"): Promise<string | undefined> {
		const cycles = listIosmCycles(this.sessionManager.getCwd());
		if (cycles.length === 0) {
			this.showStatus("No IOSM cycles found.");
			return undefined;
		}
		const canShowInteractiveSelector = !!this.ui && !!this.editorContainer;
		if (!canShowInteractiveSelector) {
			return cycles[0]?.cycleId;
		}
		const options = cycles.map((cycle, index) => this.formatIosmCycleSelectionOption(index + 1, cycle));
		const selected = await this.showExtensionSelector(`${commandName}: select cycle`, options);
		if (!selected) {
			this.showStatus(`${commandName} cancelled.`);
			return undefined;
		}
		const selectedIndex = options.indexOf(selected);
		const cycle = selectedIndex >= 0 ? cycles[selectedIndex] : undefined;
		if (!cycle) {
			this.showWarning("Selected cycle is no longer available.");
			return undefined;
		}
		return cycle.cycleId;
	}

	private async handleIosmCycleReportSlashCommand(text: string): Promise<void> {
		if (!this.requireIosmMode("/cycle-report")) return;
		const args = this.parseSlashArgs(text).slice(1);
		if (args.some((arg) => arg.startsWith("-"))) {
			this.showWarning("Usage: /cycle-report [cycle-id]");
			return;
		}
		if (args.length > 1) {
			this.showWarning("Usage: /cycle-report [cycle-id]");
			return;
		}

		try {
			let cycleId: string | undefined = args[0];
			if (!cycleId) {
				cycleId = await this.selectIosmCycleId("/cycle-report");
				if (!cycleId) {
					return;
				}
			}
			const report = readIosmCycleReport(this.sessionManager.getCwd(), cycleId);
			this.showCommandJsonBlock("IOSM Cycle Report", report);
		} catch (error: unknown) {
			this.showError(`Failed to read IOSM cycle report: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async handleIosmCycleStatusSlashCommand(text: string): Promise<void> {
		if (!this.requireIosmMode("/cycle-status")) return;
		const args = this.parseSlashArgs(text).slice(1);
		if (args.some((arg) => arg.startsWith("-"))) {
			this.showWarning("Usage: /cycle-status [cycle-id]");
			return;
		}
		if (args.length > 1) {
			this.showWarning("Usage: /cycle-status [cycle-id]");
			return;
		}

		try {
			let cycleId: string | undefined = args[0];
			if (!cycleId) {
				cycleId = await this.selectIosmCycleId("/cycle-status");
				if (!cycleId) {
					return;
				}
			}
			const status = inspectIosmCycle(this.sessionManager.getCwd(), cycleId);
			const guardrails =
				status.guardrailsPass === null ? "pending" : status.guardrailsPass ? "pass" : "fail";
			const lines: string[] = [
				`Cycle: ${status.cycleId}`,
				`Status: ${status.status}`,
				`Decision: ${status.decision}`,
				`Report: ${status.reportPath}`,
				`Capacity: ${status.capacityPass ? "pass" : "fail"}`,
				`Guardrails: ${guardrails}`,
				`Report Complete: ${status.reportComplete ? "yes" : "no"}`,
				`Learning Closed: ${status.learningClosed ? "yes" : "no"}`,
				`History Recorded: ${status.historyRecorded ? "yes" : "no"}`,
			];

			if (status.blockingIssues.length > 0) {
				lines.push("", "Blocking Issues:");
				for (const issue of status.blockingIssues) {
					lines.push(`  - ${issue}`);
				}
			}
			if (status.warnings.length > 0) {
				lines.push("", "Warnings:");
				for (const warning of status.warnings) {
					lines.push(`  - ${warning}`);
				}
			}

			this.showCommandTextBlock("IOSM Cycle Status", lines.join("\n"));
		} catch (error: unknown) {
			this.showError(`Failed to inspect IOSM cycle: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async handleReloadCommand(): Promise<void> {
		if (this.session.isStreaming) {
			this.showWarning("Wait for the current response to finish before reloading.");
			return;
		}
		if (this.session.isCompacting) {
			this.showWarning("Wait for compaction to finish before reloading.");
			return;
		}

		this.resetExtensionUI();

		const loader = new BorderedLoader(this.ui, theme, "Reloading extensions, skills, prompts, themes...", {
			cancellable: false,
		});
		const previousEditor = this.editor;
		this.editorContainer.clear();
		this.editorContainer.addChild(loader);
		this.ui.setFocus(loader);
		this.ui.requestRender();

		const dismissLoader = (editor: Component) => {
			loader.dispose();
			this.editorContainer.clear();
			this.editorContainer.addChild(editor);
			this.ui.setFocus(editor);
			this.ui.requestRender();
		};

		try {
			await this.session.reload();
			if (this.mcpRuntime) {
				await this.mcpRuntime.refresh();
				this.syncMcpToolsWithSession();
				const mcpErrors = this.mcpRuntime.getErrors();
				if (mcpErrors.length > 0) {
					this.showWarning(
						`MCP config warning: ${mcpErrors[0]}${mcpErrors.length > 1 ? ` (+${mcpErrors.length - 1} more)` : ""}`,
					);
				}
			}
			setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
			this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
			const themeName = this.settingsManager.getTheme();
			const themeResult = themeName ? setTheme(themeName, true) : { success: true };
			if (!themeResult.success) {
				this.showError(`Failed to load theme "${themeName}": ${themeResult.error}\nFell back to dark theme.`);
			}
			const editorPaddingX = this.settingsManager.getEditorPaddingX();
			const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
			this.defaultEditor.setPaddingX(editorPaddingX);
			this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
			if (this.editor !== this.defaultEditor) {
				this.editor.setPaddingX?.(editorPaddingX);
				this.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
			}
			this.ui.setShowHardwareCursor(this.settingsManager.getShowHardwareCursor());
			this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
			this.setupAutocomplete(this.fdPath);
			const runner = this.session.extensionRunner;
			if (runner) {
				this.setupExtensionShortcuts(runner);
			}
			this.rebuildChatFromMessages();
			dismissLoader(this.editor as Component);
			this.showLoadedResources({
				extensionPaths: runner?.getExtensionPaths() ?? [],
				force: false,
				showDiagnosticsWhenQuiet: true,
			});
			const modelsJsonError = this.session.modelRegistry.getError();
			if (modelsJsonError) {
				this.showError(`models.json error: ${modelsJsonError}`);
			}
			this.showStatus("Reloaded extensions, skills, prompts, themes");
		} catch (error) {
			dismissLoader(previousEditor as Component);
			this.showError(`Reload failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async handleExportCommand(text: string): Promise<void> {
		const args = this.parseSlashArgs(text).slice(1);
		if (args.length > 1) {
			this.showWarning("Usage: /export [output-path]");
			return;
		}
		let outputPath: string | undefined = args[0];
		const canShowInteractiveSelector = !!this.ui && !!this.editorContainer;
		if (!outputPath && canShowInteractiveSelector) {
			const enteredPath = await this.showExtensionInput(
				"/export: output path (optional)",
				"Leave empty for default export file name",
			);
			if (enteredPath === undefined) {
				this.showStatus("Export cancelled");
				return;
			}
			const normalized = enteredPath.trim();
			outputPath = normalized.length > 0 ? normalized : undefined;
		}

		if (outputPath && fs.existsSync(outputPath) && canShowInteractiveSelector) {
			const overwrite = await this.showExtensionConfirm("Overwrite existing export file?", outputPath);
			if (!overwrite) {
				this.showStatus("Export cancelled");
				return;
			}
		}

		try {
			const filePath = await this.session.exportToHtml(outputPath);
			this.showStatus(`Session exported to: ${filePath}`);
		} catch (error: unknown) {
			this.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}

	private async handleShareCommand(): Promise<void> {
		// Check if gh is available and logged in
		try {
			const authResult = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
			if (authResult.status !== 0) {
				this.showError("GitHub CLI is not logged in. Run 'gh auth login' first.");
				return;
			}
		} catch {
			this.showError("GitHub CLI (gh) is not installed. Install it from https://cli.github.com/");
			return;
		}

		// Export to a temp file
		const tmpFile = path.join(os.tmpdir(), "session.html");
		try {
			await this.session.exportToHtml(tmpFile);
		} catch (error: unknown) {
			this.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
			return;
		}

		// Show cancellable loader, replacing the editor
		const loader = new BorderedLoader(this.ui, theme, "Creating gist...");
		this.editorContainer.clear();
		this.editorContainer.addChild(loader);
		this.ui.setFocus(loader);
		this.ui.requestRender();

		const restoreEditor = () => {
			loader.dispose();
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			try {
				fs.unlinkSync(tmpFile);
			} catch {
				// Ignore cleanup errors
			}
		};

		// Create a secret gist asynchronously
		let proc: ReturnType<typeof spawn> | null = null;

		loader.onAbort = () => {
			proc?.kill();
			restoreEditor();
			this.showStatus("Share cancelled");
		};

		try {
			const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
				proc = spawn("gh", ["gist", "create", "--public=false", tmpFile]);
				let stdout = "";
				let stderr = "";
				proc.stdout?.on("data", (data) => {
					stdout += data.toString();
				});
				proc.stderr?.on("data", (data) => {
					stderr += data.toString();
				});
				proc.on("close", (code) => resolve({ stdout, stderr, code }));
			});

			if (loader.signal.aborted) return;

			restoreEditor();

			if (result.code !== 0) {
				const errorMsg = result.stderr?.trim() || "Unknown error";
				this.showError(`Failed to create gist: ${errorMsg}`);
				return;
			}

			// Extract gist ID from the URL returned by gh
			// gh returns something like: https://gist.github.com/username/GIST_ID
			const gistUrl = result.stdout?.trim();
			const gistId = gistUrl?.split("/").pop();
			if (!gistId) {
				this.showError("Failed to parse gist ID from gh output");
				return;
			}

			// Create the preview URL
			const previewUrl = getShareViewerUrl(gistId);
			this.showStatus(`Share URL: ${previewUrl}\nGist: ${gistUrl}`);
		} catch (error: unknown) {
			if (!loader.signal.aborted) {
				restoreEditor();
				this.showError(`Failed to create gist: ${error instanceof Error ? error.message : "Unknown error"}`);
			}
		}
	}

	private handleCopyCommand(): void {
		const text = this.session.getLastAssistantText();
		if (!text) {
			this.showError("No agent messages to copy yet.");
			return;
		}

		try {
			copyToClipboard(text);
			this.showStatus("Copied last agent message to clipboard");
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private handleNameCommand(text: string): void {
		const name = text.replace(/^\/name\s*/, "").trim();
		if (!name) {
			const currentName = this.sessionManager.getSessionName();
			if (currentName) {
				this.chatContainer.addChild(new Spacer(1));
				this.chatContainer.addChild(new Text(theme.fg("dim", `Session name: ${currentName}`), 1, 0));
			} else {
				this.showWarning("Usage: /name <name>");
			}
			this.ui.requestRender();
			return;
		}

		this.sessionManager.appendSessionInfo(name);
		this.updateTerminalTitle();
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("dim", `Session name set: ${name}`), 1, 0));
		this.ui.requestRender();
	}

	private handleSessionCommand(): void {
		const stats = this.session.getSessionStats();
		const sessionName = this.sessionManager.getSessionName();

		let info = `${theme.bold("Session Info")}\n\n`;
		if (sessionName) {
			info += `${theme.fg("dim", "Name:")} ${sessionName}\n`;
		}
		info += `${theme.fg("dim", "File:")} ${stats.sessionFile ?? "In-memory"}\n`;
		info += `${theme.fg("dim", "ID:")} ${stats.sessionId}\n\n`;
		info += `${theme.bold("Messages")}\n`;
		info += `${theme.fg("dim", "User:")} ${stats.userMessages}\n`;
		info += `${theme.fg("dim", "Assistant:")} ${stats.assistantMessages}\n`;
		info += `${theme.fg("dim", "Tool Calls:")} ${stats.toolCalls}\n`;
		info += `${theme.fg("dim", "Tool Results:")} ${stats.toolResults}\n`;
		info += `${theme.fg("dim", "Total:")} ${stats.totalMessages}\n\n`;
		info += `${theme.bold("Tokens")}\n`;
		info += `${theme.fg("dim", "Input:")} ${stats.tokens.input.toLocaleString()}\n`;
		info += `${theme.fg("dim", "Output:")} ${stats.tokens.output.toLocaleString()}\n`;
		if (stats.tokens.cacheRead > 0) {
			info += `${theme.fg("dim", "Cache Read:")} ${stats.tokens.cacheRead.toLocaleString()}\n`;
		}
		if (stats.tokens.cacheWrite > 0) {
			info += `${theme.fg("dim", "Cache Write:")} ${stats.tokens.cacheWrite.toLocaleString()}\n`;
		}
		info += `${theme.fg("dim", "Total:")} ${stats.tokens.total.toLocaleString()}\n`;

		if (stats.cost > 0) {
			info += `\n${theme.bold("Cost")}\n`;
			info += `${theme.fg("dim", "Total:")} ${stats.cost.toFixed(4)}`;
		}

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(info, 1, 0));
		this.ui.requestRender();
	}

	private handleChangelogCommand(): void {
		const changelogPath = getChangelogPath();
		const allEntries = parseChangelog(changelogPath);

		const changelogMarkdown =
			allEntries.length > 0
				? allEntries
					.reverse()
					.map((e) => e.content)
					.join("\n\n")
				: "No changelog entries found.";

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder());
		this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Markdown(changelogMarkdown, 1, 1, this.getMarkdownThemeWithSettings()));
		this.chatContainer.addChild(new DynamicBorder());
		this.ui.requestRender();
	}

	/**
	 * Capitalize keybinding for display (e.g., "ctrl+c" -> "Ctrl+C").
	 */
	private capitalizeKey(key: string): string {
		return key
			.split("/")
			.map((k) =>
				k
					.split("+")
					.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
					.join("+"),
			)
			.join("/");
	}

	/**
	 * Get capitalized display string for an app keybinding action.
	 */
	private getAppKeyDisplay(action: AppAction): string {
		return this.capitalizeKey(appKey(this.keybindings, action));
	}

	/**
	 * Get capitalized display string for an editor keybinding action.
	 */
	private getEditorKeyDisplay(action: EditorAction): string {
		return this.capitalizeKey(editorKey(action));
	}

	private handleHotkeysCommand(): void {
		// Navigation keybindings
		const cursorWordLeft = this.getEditorKeyDisplay("cursorWordLeft");
		const cursorWordRight = this.getEditorKeyDisplay("cursorWordRight");
		const cursorLineStart = this.getEditorKeyDisplay("cursorLineStart");
		const cursorLineEnd = this.getEditorKeyDisplay("cursorLineEnd");
		const jumpForward = this.getEditorKeyDisplay("jumpForward");
		const jumpBackward = this.getEditorKeyDisplay("jumpBackward");
		const pageUp = this.getEditorKeyDisplay("pageUp");
		const pageDown = this.getEditorKeyDisplay("pageDown");

		// Editing keybindings
		const submit = this.getEditorKeyDisplay("submit");
		const newLine = this.getEditorKeyDisplay("newLine");
		const deleteWordBackward = this.getEditorKeyDisplay("deleteWordBackward");
		const deleteWordForward = this.getEditorKeyDisplay("deleteWordForward");
		const deleteToLineStart = this.getEditorKeyDisplay("deleteToLineStart");
		const deleteToLineEnd = this.getEditorKeyDisplay("deleteToLineEnd");
		const yank = this.getEditorKeyDisplay("yank");
		const yankPop = this.getEditorKeyDisplay("yankPop");
		const undo = this.getEditorKeyDisplay("undo");
		const tab = this.getEditorKeyDisplay("tab");

		// App keybindings
		const interrupt = this.getAppKeyDisplay("interrupt");
		const clear = this.getAppKeyDisplay("clear");
		const exit = this.getAppKeyDisplay("exit");
		const suspend = this.getAppKeyDisplay("suspend");
		const cycleProfile = this.getAppKeyDisplay("cycleProfile");
		const cycleThinkingLevel = this.getAppKeyDisplay("cycleThinkingLevel");
		const cycleModelForward = this.getAppKeyDisplay("cycleModelForward");
		const selectModel = this.getAppKeyDisplay("selectModel");
		const expandTools = this.getAppKeyDisplay("expandTools");
		const toggleThinking = this.getAppKeyDisplay("toggleThinking");
		const externalEditor = this.getAppKeyDisplay("externalEditor");
		const steer = this.getAppKeyDisplay("steer");
		const followUp = this.getAppKeyDisplay("followUp");
		const dequeue = this.getAppKeyDisplay("dequeue");

		let hotkeys = `
**Navigation**
| Key | Action |
|-----|--------|
| \`Arrow keys\` | Move cursor / browse history (Up when empty) |
| \`${cursorWordLeft}\` / \`${cursorWordRight}\` | Move by word |
| \`${cursorLineStart}\` | Start of line |
| \`${cursorLineEnd}\` | End of line |
| \`${jumpForward}\` | Jump forward to character |
| \`${jumpBackward}\` | Jump backward to character |
| \`${pageUp}\` / \`${pageDown}\` | Scroll by page |

**Editing**
| Key | Action |
|-----|--------|
| \`${submit}\` | Send message |
| \`${newLine}\` | New line${process.platform === "win32" ? " (Ctrl+Enter on Windows Terminal)" : ""} |
| \`${deleteWordBackward}\` | Delete word backwards |
| \`${deleteWordForward}\` | Delete word forwards |
| \`${deleteToLineStart}\` | Delete to start of line |
| \`${deleteToLineEnd}\` | Delete to end of line |
| \`${yank}\` | Paste the most-recently-deleted text |
| \`${yankPop}\` | Cycle through the deleted text after pasting |
| \`${undo}\` | Undo |

**Other**
| Key | Action |
|-----|--------|
| \`${tab}\` | Path completion / accept autocomplete |
| \`${interrupt}\` | Cancel autocomplete / abort streaming |
| \`${clear}\` | Clear editor (first) / exit (second) |
| \`${exit}\` | Exit (when editor is empty) |
| \`${suspend}\` | Suspend to background |
| \`${cycleProfile}\` | Cycle agent profile |
| \`${cycleThinkingLevel}\` | Cycle thinking level |
| \`${cycleModelForward}\` | Cycle models |
| \`${selectModel}\` | Open model selector |
| \`${expandTools}\` | Toggle tool output expansion |
| \`${toggleThinking}\` | Toggle thinking block visibility |
| \`${externalEditor}\` | Edit message in external editor |
| \`${steer}\` | Queue steer message |
| \`${followUp}\` | Queue follow-up message |
| \`${dequeue}\` | Restore queued messages |
| \`Ctrl+V\` | Paste image from clipboard |
| \`/\` | Slash commands |
| \`!\` | Run bash command |
| \`!!\` | Run bash command (excluded from context) |
`;

		// Add extension-registered shortcuts
		const extensionRunner = this.session.extensionRunner;
		if (extensionRunner) {
			const shortcuts = extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig());
			if (shortcuts.size > 0) {
				hotkeys += `
**Extensions**
| Key | Action |
|-----|--------|
`;
				for (const [key, shortcut] of shortcuts) {
					const description = shortcut.description ?? shortcut.extensionPath;
					const keyDisplay = key.replace(/\b\w/g, (c) => c.toUpperCase());
					hotkeys += `| \`${keyDisplay}\` | ${description} |\n`;
				}
			}
		}

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder());
		this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "Keyboard Shortcuts")), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Markdown(hotkeys.trim(), 1, 1, this.getMarkdownThemeWithSettings()));
		this.chatContainer.addChild(new DynamicBorder());
		this.ui.requestRender();
	}

	private async handleClearCommand(): Promise<void> {
		// Stop loading animation
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.statusContainer.clear();

		// New session via session (emits extension session events)
		await this.session.newSession();

		// Clear UI state
		this.chatContainer.clear();
		this.pendingMessagesContainer.clear();
		this.compactionQueuedMessages = [];
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
		this.pendingTools.clear();

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(`${theme.fg("accent", "✓ New session started")}`, 1, 1));
		this.refreshBuiltInHeader();
		this.ui.requestRender();
	}

	private handleDebugCommand(): void {
		const width = this.ui.terminal.columns;
		const height = this.ui.terminal.rows;
		const allLines = this.ui.render(width);

		const debugLogPath = getDebugLogPath();
		const debugData = [
			`Debug output at ${new Date().toISOString()}`,
			`Terminal: ${width}x${height}`,
			`Total lines: ${allLines.length}`,
			"",
			"=== All rendered lines with visible widths ===",
			...allLines.map((line, idx) => {
				const vw = visibleWidth(line);
				const escaped = JSON.stringify(line);
				return `[${idx}] (w=${vw}) ${escaped}`;
			}),
			"",
			"=== Agent messages (JSONL) ===",
			...this.session.messages.map((msg) => JSON.stringify(msg)),
			"",
		].join("\n");

		fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
		fs.writeFileSync(debugLogPath, debugData);

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new Text(`${theme.fg("accent", "✓ Debug log written")}\n${theme.fg("muted", debugLogPath)}`, 1, 1),
		);
		this.ui.requestRender();
	}

	private handleArminSaysHi(): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new ArminComponent(this.ui));
		this.ui.requestRender();
	}

	private handleDaxnuts(): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DaxnutsComponent(this.ui));
		this.ui.requestRender();
	}

	private checkDaxnutsEasterEgg(model: { provider: string; id: string }): void {
		if (model.provider === "opencode" && model.id.toLowerCase().includes("kimi-k2.5")) {
			this.handleDaxnuts();
		}
	}

	private async handleBashCommand(command: string, excludeFromContext = false): Promise<void> {
		const extensionRunner = this.session.extensionRunner;

		// Emit user_bash event to let extensions intercept
		const eventResult = extensionRunner
			? await extensionRunner.emitUserBash({
				type: "user_bash",
				command,
				excludeFromContext,
				cwd: process.cwd(),
			})
			: undefined;

		// If extension returned a full result, use it directly
		if (eventResult?.result) {
			const result = eventResult.result;

			// Create UI component for display
			this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext);
			if (this.session.isStreaming) {
				this.pendingMessagesContainer.addChild(this.bashComponent);
				this.pendingBashComponents.push(this.bashComponent);
			} else {
				this.chatContainer.addChild(this.bashComponent);
			}

			// Show output and complete
			if (result.output) {
				this.bashComponent.appendOutput(result.output);
			}
			this.bashComponent.setComplete(
				result.exitCode,
				result.cancelled,
				result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
				result.fullOutputPath,
			);

			// Record the result in session
			this.session.recordBashResult(command, result, { excludeFromContext });
			this.bashComponent = undefined;
			this.ui.requestRender();
			return;
		}

		// Normal execution path (possibly with custom operations)
		const isDeferred = this.session.isStreaming;
		this.bashComponent = new BashExecutionComponent(command, this.ui, excludeFromContext);

		if (isDeferred) {
			// Show in pending area when agent is streaming
			this.pendingMessagesContainer.addChild(this.bashComponent);
			this.pendingBashComponents.push(this.bashComponent);
		} else {
			// Show in chat immediately when agent is idle
			this.chatContainer.addChild(this.bashComponent);
		}
		this.ui.requestRender();

		try {
			const result = await this.session.executeBash(
				command,
				(chunk) => {
					if (this.bashComponent) {
						this.bashComponent.appendOutput(chunk);
						this.ui.requestRender();
					}
				},
				{ excludeFromContext, operations: eventResult?.operations },
			);

			if (this.bashComponent) {
				this.bashComponent.setComplete(
					result.exitCode,
					result.cancelled,
					result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
					result.fullOutputPath,
				);
			}
		} catch (error) {
			if (this.bashComponent) {
				this.bashComponent.setComplete(undefined, false);
			}
			this.showError(`Bash command failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		}

		this.bashComponent = undefined;
		this.ui.requestRender();
	}

	private async handleCompactCommand(customInstructions?: string): Promise<void> {
		const entries = this.sessionManager.getEntries();
		const messageCount = entries.filter((e) => e.type === "message").length;

		if (messageCount < 2) {
			this.showWarning("Nothing to compact (no messages yet)");
			return;
		}

		await this.executeCompaction(customInstructions, false);
	}

	private async executeCompaction(customInstructions?: string, isAuto = false): Promise<CompactionResult | undefined> {
		// Stop loading animation
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.statusContainer.clear();

		// Set up escape handler during compaction
		const originalOnEscape = this.defaultEditor.onEscape;
		this.defaultEditor.onEscape = () => {
			void this.interruptCurrentWork();
		};

		// Show compacting status
		this.chatContainer.addChild(new Spacer(1));
		const cancelHint = `(${appKey(this.keybindings, "interrupt")} to cancel)`;
		const label = isAuto ? `Auto-compacting context... ${cancelHint}` : `Compacting context... ${cancelHint}`;
		const compactingLoader = new Loader(
			this.ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			label,
		);
		this.statusContainer.addChild(compactingLoader);
		this.ui.requestRender();

		let result: CompactionResult | undefined;

		try {
			result = await this.session.compact(customInstructions);

			// Rebuild UI
			this.rebuildChatFromMessages();

			// Add compaction component at bottom so user sees it without scrolling
			const msg = createCompactionSummaryMessage(result.summary, result.tokensBefore, new Date().toISOString());
			this.addMessageToChat(msg);

			this.footer.invalidate();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError")) {
				this.showError("Compaction cancelled");
			} else {
				this.showError(`Compaction failed: ${message}`);
			}
		} finally {
			compactingLoader.stop();
			this.statusContainer.clear();
			this.defaultEditor.onEscape = originalOnEscape;
		}
		void this.flushCompactionQueue({ willRetry: false });
		return result;
	}

	stop(): void {
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.clearExtensionTerminalInputListeners();
		this.footer.dispose();
		this.footerDataProvider.dispose();
		if (this.unsubscribe) {
			this.unsubscribe();
		}
		if (this.isInitialized) {
			this.ui.stop();
			this.isInitialized = false;
		}
	}
}
