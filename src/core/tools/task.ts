import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { getTeamRun, updateTeamTaskStatus } from "../agent-teams.js";
import type { CustomSubagentDefinition } from "../subagents.js";

/**
 * Callback type passed in from sdk.ts to avoid circular imports.
 * Spawns a sub-session and runs it to completion, returning the final text output.
 */
export type SubagentRunResult = {
	output: string;
	sessionId?: string;
	stats?: {
		toolCallsStarted: number;
		toolCallsCompleted: number;
		assistantMessages: number;
	};
};

export type TaskToolProgressPhase = "queued" | "starting" | "running" | "responding";

export type TaskDelegateProgressStatus = "pending" | "running" | "done" | "failed";

export interface TaskDelegateProgressItem {
	index: number;
	description: string;
	profile: string;
	status: TaskDelegateProgressStatus;
}

export interface TaskToolProgress {
	kind: "subagent_progress";
	phase: TaskToolProgressPhase;
	message: string;
	cwd?: string;
	activeTool?: string;
	toolCallsStarted?: number;
	toolCallsCompleted?: number;
	assistantMessages?: number;
	delegateIndex?: number;
	delegateTotal?: number;
	delegateDescription?: string;
	delegateProfile?: string;
	delegateItems?: TaskDelegateProgressItem[];
}

export type SubagentRunner = (options: {
	systemPrompt: string;
	tools: string[];
	prompt: string;
	cwd: string;
	modelOverride?: string;
	signal?: AbortSignal;
	onProgress?: (progress: TaskToolProgress) => void;
}) => Promise<string | SubagentRunResult>;

const taskSchema = Type.Object({
	description: Type.String({
		description: "Short 3-5 word description of what the subagent will do",
	}),
	prompt: Type.String({
		description: "Full task prompt for the subagent",
	}),
	agent: Type.Optional(
		Type.String({
			description: "Optional custom subagent name loaded from .iosm/agents or global agents directory.",
		}),
	),
	profile: Type.Union(
		[
			Type.Literal("explore"),
			Type.Literal("plan"),
			Type.Literal("iosm"),
			Type.Literal("iosm_analyst"),
			Type.Literal("iosm_verifier"),
			Type.Literal("cycle_planner"),
			Type.Literal("full"),
		],
		{
			description:
				"Subagent capability profile: explore (read-only), plan (read + bash, no edits), iosm (full tools + IOSM methodology), iosm_analyst (read + bash for IOSM artifacts), iosm_verifier (artifact-focused checks), cycle_planner (cycle planning), full (all tools)",
		},
	),
	cwd: Type.Optional(
		Type.String({
			description:
				"Optional working directory for this subagent. Relative paths are resolved from the current workspace.",
		}),
	),
	lock_key: Type.Optional(
		Type.String({
			description:
				"Optional logical lock key for write serialization (e.g. src/api/**). Agents with the same lock key run write phases sequentially.",
		}),
	),
	run_id: Type.Optional(
		Type.String({
			description:
				"Optional orchestration run id (from /orchestrate). Use with task_id so the team board can track status.",
		}),
	),
	task_id: Type.Optional(
		Type.String({
			description:
				"Optional orchestration task id (for example task_1). Use with run_id to update the team board.",
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				"Optional model override for this subagent (for example anthropic/claude-sonnet-4 or model id).",
		}),
	),
	background: Type.Optional(
		Type.Boolean({
			description:
				"Run subagent in background and return immediately with run id. Use for detached async runs; orchestrated run_id/task_id calls execute foreground for deterministic coordination. Background mode is read-only policy by default.",
		}),
	),
	isolation: Type.Optional(
		Type.Union([Type.Literal("none"), Type.Literal("worktree")], {
			description:
				"Optional isolation mode. Set to worktree to run this subagent in a temporary git worktree.",
		}),
	),
});

export type TaskToolInput = Static<typeof taskSchema>;

/** Details attached to the tool result for UI display */
export interface TaskToolDetails {
	profile: string;
	description: string;
	outputLength: number;
	cwd: string;
	agent?: string;
	lockKey?: string;
	runId?: string;
	taskId?: string;
	model?: string;
	subagentSessionId?: string;
	transcriptPath?: string;
	isolation?: "none" | "worktree";
	worktreePath?: string;
	waitMs?: number;
	background?: boolean;
	backgroundStatusPath?: string;
	toolCallsStarted?: number;
	toolCallsCompleted?: number;
	assistantMessages?: number;
	delegatedTasks?: number;
	delegatedSucceeded?: number;
	delegatedFailed?: number;
}

export interface TaskToolOptions {
	resolveCustomSubagent?: (name: string) => CustomSubagentDefinition | undefined;
	availableCustomSubagents?: string[];
	availableCustomSubagentHints?: Array<{ name: string; description: string }>;
	/** Returns pending live meta updates entered during an active run. */
	getMetaMessages?: () => readonly string[];
}

/** Tool names available per profile */
const toolsByProfile: Record<string, string[]> = {
	explore: ["read", "grep", "find", "ls"],
	plan: ["read", "bash", "grep", "find", "ls"],
	iosm: ["read", "bash", "edit", "write", "grep", "find", "ls"],
	iosm_analyst: ["read", "bash", "grep", "find", "ls"],
	iosm_verifier: ["read", "bash", "write"],
	cycle_planner: ["read", "bash", "write"],
	full: ["read", "bash", "edit", "write", "grep", "find", "ls"],
};

/** System prompt injected per profile */
const systemPromptByProfile: Record<string, string> = {
	explore:
		"You are a fast read-only codebase explorer. Answer concisely. Never write or edit files.",
	plan: "You are a technical architect. Analyze the codebase and produce a clear implementation plan. Do not write or edit files.",
	iosm: "You are an IOSM execution agent. Use IOSM methodology and keep IOSM artifacts synchronized with implementation.",
	iosm_analyst:
		"You are an IOSM metrics analyst. Analyze .iosm/ artifacts and codebase metrics. Be precise and evidence-based.",
	iosm_verifier:
		"You are an IOSM verifier. Validate checks and update only required IOSM artifacts with deterministic reasoning.",
	cycle_planner:
		"You are an IOSM cycle planner. Propose and align cycle goals with measurable outcomes and concrete risks.",
	full: "You are a software engineering agent. Execute the task end-to-end.",
};

const writeCapableProfiles = new Set(["full", "iosm_verifier", "cycle_planner"]);
const delegationTagName = "delegate_task";

type DelegationRequest = {
	description: string;
	profile: string;
	prompt: string;
	cwd?: string;
	lockKey?: string;
	model?: string;
	isolation?: "none" | "worktree";
	dependsOn?: number[];
};

type ParsedDelegationRequests = {
	cleanedOutput: string;
	requests: DelegationRequest[];
	warnings: string[];
};

class Semaphore {
	private active = 0;
	private readonly queue: Array<() => void> = [];

	constructor(private readonly limit: number) {}

	async acquire(): Promise<() => void> {
		if (this.active < this.limit) {
			this.active += 1;
			return () => this.release();
		}

		await new Promise<void>((resolve) => {
			this.queue.push(() => {
				this.active += 1;
				resolve();
			});
		});

		return () => this.release();
	}

	private release(): void {
		this.active = Math.max(0, this.active - 1);
		const next = this.queue.shift();
		if (next) {
			next();
		}
	}
}

class Mutex {
	private locked = false;
	private readonly waiters: Array<() => void> = [];

	async acquire(): Promise<() => void> {
		if (!this.locked) {
			this.locked = true;
			return () => this.release();
		}

		await new Promise<void>((resolve) => this.waiters.push(resolve));
		this.locked = true;
		return () => this.release();
	}

	private release(): void {
		this.locked = false;
		const next = this.waiters.shift();
		if (next) {
			next();
		}
	}
}

const maxParallelFromEnv = Number.parseInt(process.env.IOSM_SUBAGENT_MAX_PARALLEL ?? "4", 10);
const subagentSemaphore = new Semaphore(
	Number.isInteger(maxParallelFromEnv) && maxParallelFromEnv > 0 ? Math.min(maxParallelFromEnv, 20) : 4,
);
const maxDelegationDepthFromEnv = parseBoundedInt(process.env.IOSM_SUBAGENT_MAX_DELEGATION_DEPTH, 1, 0, 3);
const maxDelegationsPerTaskFromEnv = parseBoundedInt(
	process.env.IOSM_SUBAGENT_MAX_DELEGATIONS_PER_TASK,
	2,
	0,
	10,
);
const maxDelegatedParallelFromEnv = parseBoundedInt(process.env.IOSM_SUBAGENT_MAX_DELEGATE_PARALLEL, 4, 1, 10);
const maxDelegatedOutputCharsFromEnv = parseBoundedInt(process.env.IOSM_SUBAGENT_DELEGATED_OUTPUT_MAX_CHARS, 6000, 500, 20_000);
const maxMetaUpdatesPerCheckpoint = parseBoundedInt(process.env.IOSM_SUBAGENT_META_MAX_ITEMS, 5, 1, 20);
const maxMetaUpdateChars = parseBoundedInt(process.env.IOSM_SUBAGENT_META_MAX_CHARS, 600, 100, 4000);
const orchestrationSemaphores = new Map<string, Semaphore>();
const cwdWriteLocks = new Map<string, Mutex>();

function parseBoundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
	const parsed = raw ? Number.parseInt(raw, 10) : fallback;
	if (!Number.isInteger(parsed)) return fallback;
	return Math.max(min, Math.min(max, parsed));
}

function normalizeSpacing(text: string): string {
	return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function cloneDelegateItems(items: TaskDelegateProgressItem[] | undefined): TaskDelegateProgressItem[] | undefined {
	return items ? items.map((item) => ({ ...item })) : undefined;
}

function formatMetaCheckpoint(metaMessages: readonly string[] | undefined): {
	section: string | undefined;
	appliedCount: number;
} {
	if (!metaMessages || metaMessages.length === 0) {
		return { section: undefined, appliedCount: 0 };
	}
	const normalized = metaMessages
		.map((item) => item.replace(/\s+/g, " ").trim())
		.filter((item) => item.length > 0)
		.slice(-maxMetaUpdatesPerCheckpoint)
		.map((item) => (item.length > maxMetaUpdateChars ? `${item.slice(0, maxMetaUpdateChars - 3)}...` : item));

	if (normalized.length === 0) {
		return { section: undefined, appliedCount: 0 };
	}

	const lines = normalized.map((item, index) => `${index + 1}. ${item}`).join("\n");
	return {
		section: [
			"[META_UPDATES]",
			"Live user updates captured during execution. Apply them in this subtask if relevant.",
			"If conflicts exist, prioritize later items.",
			lines,
			"[/META_UPDATES]",
		].join("\n"),
		appliedCount: normalized.length,
	};
}

function isAbortError(error: unknown): boolean {
	if (error instanceof Error) {
		return /aborted/i.test(error.message);
	}
	if (typeof error === "string") {
		return /aborted/i.test(error);
	}
	return false;
}

function buildDelegationProtocolPrompt(depthRemaining: number): string {
	if (depthRemaining <= 0) {
		return [
			`Delegation protocol: depth limit reached.`,
			`Do not emit <${delegationTagName}> blocks.`,
		].join("\n");
	}
	return [
		`Delegation protocol (optional): if you discover a concrete follow-up that is better done by a separate specialist, emit up to ${maxDelegationsPerTaskFromEnv} XML block(s):`,
		`<${delegationTagName} profile="explore|plan|iosm|iosm_analyst|iosm_verifier|cycle_planner|full" description="short title" cwd="optional relative path" lock_key="optional lock key" model="optional model override" isolation="none|worktree" depends_on="optional indices like 1|3">`,
		"Detailed delegated task prompt",
		`</${delegationTagName}>`,
		`Only emit blocks when necessary. Keep normal analysis/answer text outside those blocks.`,
	].join("\n");
}

function withDelegationPrompt(basePrompt: string, depthRemaining: number): string {
	const protocol = buildDelegationProtocolPrompt(depthRemaining);
	return `${basePrompt}\n\n${protocol}`;
}

function parseDelegationRequests(output: string, maxRequests: number): ParsedDelegationRequests {
	const requests: DelegationRequest[] = [];
	const warnings: string[] = [];
	const pattern = new RegExp(`<${delegationTagName}\\b([^>]*)>([\\s\\S]*?)<\\/${delegationTagName}>`, "gi");

	const cleaned = output.replace(pattern, (_full, attrsRaw: string, bodyRaw: string) => {
		if (maxRequests <= 0) {
			warnings.push(`Ignored delegation block: max delegated tasks per run is 0.`);
			return "";
		}
		if (requests.length >= maxRequests) {
			warnings.push(`Ignored extra delegation block: max ${maxRequests} per run.`);
			return "";
		}
		const attrs: Record<string, string> = {};
		for (const match of attrsRaw.matchAll(/([A-Za-z_][A-Za-z0-9_-]*)="([^"]*)"/g)) {
			attrs[match[1].toLowerCase()] = match[2];
		}

		const prompt = normalizeSpacing(bodyRaw ?? "");
		if (!prompt) {
			warnings.push(`Ignored delegation block with empty prompt.`);
			return "";
		}
		const profile = (attrs.profile ?? "explore").trim();
		if (!(profile in toolsByProfile)) {
			warnings.push(`Ignored delegation block with unknown profile "${profile}".`);
			return "";
		}
		const isolationRaw = (attrs.isolation ?? "").trim().toLowerCase();
		const isolation =
			isolationRaw === "worktree" ? "worktree" : isolationRaw === "none" ? "none" : undefined;
		if (isolationRaw && !isolation) {
			warnings.push(`Ignored invalid isolation value "${attrs.isolation}".`);
			return "";
		}

		requests.push({
			description: (attrs.description ?? `delegated task ${requests.length + 1}`).trim(),
			profile,
			prompt,
			cwd: attrs.cwd?.trim() || undefined,
			lockKey: attrs.lock_key?.trim() || undefined,
			model: attrs.model?.trim() || undefined,
			isolation,
			dependsOn: attrs.depends_on
				? attrs.depends_on
						.split(/[|,]/)
						.map((token) => Number.parseInt(token.trim(), 10))
						.filter((value) => Number.isInteger(value) && value > 0)
				: undefined,
		});
		return "";
	});

	return {
		requests,
		warnings,
		cleanedOutput: normalizeSpacing(cleaned),
	};
}

function getCwdLockKey(cwd: string): string {
	// Normalize lock key to keep behavior consistent across path aliases.
	return path.resolve(cwd).toLowerCase();
}

function getOrCreateWriteLock(cwd: string): Mutex {
	const key = getCwdLockKey(cwd);
	const existing = cwdWriteLocks.get(key);
	if (existing) return existing;
	const created = new Mutex();
	cwdWriteLocks.set(key, created);
	return created;
}

function getRunParallelLimit(cwd: string, runId: string): number | undefined {
	const teamRun = getTeamRun(cwd, runId);
	if (!teamRun) return undefined;
	if (teamRun.mode === "sequential") return 1;
	const maxParallel = teamRun.maxParallel;
	if (!Number.isInteger(maxParallel) || !maxParallel || maxParallel < 1) {
		return Math.max(1, Math.min(teamRun.agents, 20));
	}
	return Math.max(1, Math.min(maxParallel, 20));
}

function getOrCreateOrchestrationSemaphore(cwd: string, runId: string): Semaphore | undefined {
	const limit = getRunParallelLimit(cwd, runId);
	if (!limit || limit < 1) return undefined;
	const key = `${path.resolve(cwd).toLowerCase()}::${runId}::${limit}`;
	const existing = orchestrationSemaphores.get(key);
	if (existing) return existing;
	const created = new Semaphore(limit);
	orchestrationSemaphores.set(key, created);
	return created;
}

function persistSubagentTranscript(input: {
	rootCwd: string;
	runId: string;
	description: string;
	profile: string;
	agent?: string;
	lockKey?: string;
	model?: string;
	subagentCwd: string;
	sessionId?: string;
	prompt: string;
	output: string;
	isolation?: "none" | "worktree";
	worktreePath?: string;
}): string | undefined {
	try {
		const dir = path.join(input.rootCwd, ".iosm", "subagents", "runs");
		mkdirSync(dir, { recursive: true });
		const filePath = path.join(dir, `${input.runId}.md`);
		const lines = [
			"---",
			`run_id: ${input.runId}`,
			`profile: ${input.profile}`,
			`description: ${JSON.stringify(input.description)}`,
			`cwd: ${JSON.stringify(input.subagentCwd)}`,
			`agent: ${JSON.stringify(input.agent ?? "")}`,
			`lock_key: ${JSON.stringify(input.lockKey ?? "")}`,
			`model: ${JSON.stringify(input.model ?? "")}`,
			`session_id: ${JSON.stringify(input.sessionId ?? "")}`,
			`isolation: ${JSON.stringify(input.isolation ?? "none")}`,
			`worktree_path: ${JSON.stringify(input.worktreePath ?? "")}`,
			`created_at: ${new Date().toISOString()}`,
			"---",
			"",
			"## Prompt",
			"",
			input.prompt,
			"",
			"## Output",
			"",
			input.output,
			"",
		];
		writeFileSync(filePath, lines.join("\n"), "utf8");
		return filePath;
	} catch {
		return undefined;
	}
}

type BackgroundRunStatus = {
	runId: string;
	status: "queued" | "running" | "done" | "error";
	createdAt: string;
	startedAt?: string;
	finishedAt?: string;
	description: string;
	profile: string;
	cwd: string;
	agent?: string;
	model?: string;
	error?: string;
	transcriptPath?: string;
};

function writeBackgroundRunStatus(rootCwd: string, status: BackgroundRunStatus): string | undefined {
	try {
		const dir = path.join(rootCwd, ".iosm", "subagents", "background");
		mkdirSync(dir, { recursive: true });
		const filePath = path.join(dir, `${status.runId}.json`);
		writeFileSync(filePath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
		return filePath;
	} catch {
		return undefined;
	}
}

function gitResult(args: string[], cwd: string): { ok: boolean; stdout: string } {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return {
		ok: result.status === 0,
		stdout: (result.stdout ?? "").trim(),
	};
}

function provisionWorktree(
	rootCwd: string,
	targetCwd: string,
	runId: string,
): { runCwd: string; worktreePath?: string; cleanup: () => void } {
	const insideRepo = gitResult(["rev-parse", "--is-inside-work-tree"], rootCwd);
	if (!insideRepo.ok || insideRepo.stdout !== "true") {
		return { runCwd: targetCwd, cleanup: () => {} };
	}
	const repoRootResult = gitResult(["rev-parse", "--show-toplevel"], rootCwd);
	if (!repoRootResult.ok || !repoRootResult.stdout) {
		return { runCwd: targetCwd, cleanup: () => {} };
	}

	const repoRoot = repoRootResult.stdout;
	const relative = path.relative(repoRoot, targetCwd);
	if (relative.startsWith("..")) {
		return { runCwd: targetCwd, cleanup: () => {} };
	}

	const worktreePath = path.join(rootCwd, ".iosm", "subagents", "worktrees", runId);
	mkdirSync(path.dirname(worktreePath), { recursive: true });
	const added = gitResult(["worktree", "add", "--detach", worktreePath], repoRoot);
	if (!added.ok) {
		return { runCwd: targetCwd, cleanup: () => {} };
	}

	const runCwd = path.resolve(worktreePath, relative);
	const cleanup = (): void => {
		try {
			gitResult(["worktree", "remove", "--force", worktreePath], repoRoot);
		} catch {
			// best effort
		}
		try {
			rmSync(worktreePath, { recursive: true, force: true });
		} catch {
			// best effort
		}
	};

	return { runCwd, worktreePath, cleanup };
}

/**
 * Create the Task tool using the factory pattern.
 *
 * The `runner` callback is supplied by sdk.ts to avoid a circular import:
 * sdk.ts → task.ts (tool) would otherwise import sdk.ts again.
 *
 * @param cwd  Working directory forwarded to the subagent.
 * @param runner  Callback that creates and runs a sub-session.
 */
export function createTaskTool(
	cwd: string,
	runner: SubagentRunner,
	options?: TaskToolOptions,
): AgentTool<typeof taskSchema> {
	const customAgentsSnippet =
		options?.availableCustomSubagentHints && options.availableCustomSubagentHints.length > 0
			? ` Available custom agents: ${options.availableCustomSubagentHints
					.map((item) => `${item.name} (${item.description})`)
					.join(", ")}.`
			: options?.availableCustomSubagents && options.availableCustomSubagents.length > 0
				? ` Available custom agents: ${options.availableCustomSubagents.join(", ")}.`
			: "";
	return {
		name: "task",
		label: "task",
		description:
			"Launch a specialized subagent to handle a subtask in isolation. " +
			"Use for: codebase exploration (profile=explore), architectural planning (profile=plan), " +
			"IOSM artifact analysis (profile=iosm_analyst/iosm_verifier/cycle_planner), or end-to-end implementation (profile=full). " +
			"Set cwd to isolate subagents into different project areas when orchestrating parallel work. " +
			"The subagent runs to completion and returns its full text output. " +
			"It may request bounded follow-up delegation via <delegate_task> blocks that are executed by the parent task tool." +
			customAgentsSnippet,
		parameters: taskSchema,
		execute: async (
			_toolCallId: string,
			{
				description,
				prompt,
				agent: agentName,
				profile,
				cwd: targetCwd,
				lock_key: lockKey,
				run_id: orchestrationRunId,
				task_id: orchestrationTaskId,
				model: requestedModel,
				background,
				isolation,
			}: TaskToolInput,
			_signal?: AbortSignal,
			onUpdate?,
		) => {
			const throwIfAborted = (): void => {
				if (_signal?.aborted) {
					throw new Error("Operation aborted");
				}
			};

			const runId = `subagent_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
			const customSubagent =
				agentName && options?.resolveCustomSubagent ? options.resolveCustomSubagent(agentName) : undefined;
			if (agentName && !customSubagent) {
				const available =
					options?.availableCustomSubagents && options.availableCustomSubagents.length > 0
						? ` Available custom agents: ${options.availableCustomSubagents.join(", ")}.`
						: "";
				throw new Error(`Unknown subagent: ${agentName}.${available}`);
			}

			const effectiveProfile = customSubagent?.profile ?? profile;
			let tools = customSubagent?.tools
				? [...customSubagent.tools]
				: [...(toolsByProfile[effectiveProfile] ?? toolsByProfile.explore)];
			if (customSubagent?.disallowedTools?.length) {
				const blocked = new Set(customSubagent.disallowedTools);
				tools = tools.filter((tool) => !blocked.has(tool));
			}
			const delegationDepth = maxDelegationDepthFromEnv;
			const baseSystemPrompt =
				customSubagent?.systemPrompt ??
				systemPromptByProfile[effectiveProfile] ??
				systemPromptByProfile.full;
			const systemPrompt = withDelegationPrompt(baseSystemPrompt, delegationDepth);
			const promptWithInstructions =
				customSubagent?.instructions && customSubagent.instructions.trim().length > 0
					? `${customSubagent.instructions.trim()}\n\nUser task:\n${prompt}`
					: prompt;
			const effectiveModelOverride = requestedModel?.trim() || customSubagent?.model?.trim() || undefined;
			const requestedBackground = background === true || customSubagent?.background === true;
			const trackedOrchestrationRun =
				orchestrationRunId && orchestrationTaskId ? getTeamRun(cwd, orchestrationRunId) : undefined;
			// Deterministic orchestration UX: run tracked team tasks in foreground so the parent turn
			// naturally waits for subagents and aggregates their outputs without ad-hoc polling.
			const runInBackground = trackedOrchestrationRun ? false : requestedBackground;
			const requestedSubagentCwd = targetCwd
				? path.resolve(cwd, targetCwd)
				: customSubagent?.cwd ?? cwd;
			if (!existsSync(requestedSubagentCwd) || !statSync(requestedSubagentCwd).isDirectory()) {
				throw new Error(`Subagent cwd does not exist or is not a directory: ${requestedSubagentCwd}`);
			}
			if (runInBackground && writeCapableProfiles.has(effectiveProfile)) {
				throw new Error(
					`Background policy violation: profile "${effectiveProfile}" is write-capable. Use explore/plan/iosm_analyst for background mode.`,
				);
			}
			const useWorktree = isolation === "worktree";

			const queuedAt = Date.now();
			let latestProgress: TaskToolProgress | undefined;
			const emitProgress = (incoming: TaskToolProgress): void => {
				const activeTool = "activeTool" in incoming ? incoming.activeTool : latestProgress?.activeTool;
				const delegateIndex = "delegateIndex" in incoming ? incoming.delegateIndex : latestProgress?.delegateIndex;
				const delegateTotal = "delegateTotal" in incoming ? incoming.delegateTotal : latestProgress?.delegateTotal;
				const delegateDescription =
					"delegateDescription" in incoming ? incoming.delegateDescription : latestProgress?.delegateDescription;
				const delegateProfile =
					"delegateProfile" in incoming ? incoming.delegateProfile : latestProgress?.delegateProfile;
				const delegateItems =
					"delegateItems" in incoming
						? cloneDelegateItems(incoming.delegateItems)
						: cloneDelegateItems(latestProgress?.delegateItems);
				const merged: TaskToolProgress = {
					kind: "subagent_progress",
					phase: incoming.phase,
					message: incoming.message,
					cwd: incoming.cwd ?? latestProgress?.cwd ?? requestedSubagentCwd,
					activeTool,
					toolCallsStarted: incoming.toolCallsStarted ?? latestProgress?.toolCallsStarted,
					toolCallsCompleted: incoming.toolCallsCompleted ?? latestProgress?.toolCallsCompleted,
					assistantMessages: incoming.assistantMessages ?? latestProgress?.assistantMessages,
					delegateIndex,
					delegateTotal,
					delegateDescription,
					delegateProfile,
					delegateItems,
				};
				latestProgress = merged;
				if (!onUpdate) return;
				onUpdate({
					content: [{ type: "text" as const, text: merged.message }],
					details: { progress: merged },
				});
			};
			throwIfAborted();
			emitProgress({
				kind: "subagent_progress",
				phase: "queued",
				message: "queued",
				cwd: requestedSubagentCwd,
				toolCallsStarted: 0,
				toolCallsCompleted: 0,
				assistantMessages: 0,
			});

			const executeSubagent = async (): Promise<{ text: string; details: TaskToolDetails }> => {
				let releaseRunSlot: (() => void) | undefined;
				let releaseSlot: (() => void) | undefined;
				let releaseWriteLock: (() => void) | undefined;
				let releaseIsolation: (() => void) | undefined;
				let subagentCwd = requestedSubagentCwd;
				let worktreePath: string | undefined;
				let runStats: SubagentRunResult["stats"] | undefined;
				try {
					throwIfAborted();
					const orchestrationSemaphore =
						orchestrationRunId && orchestrationTaskId
							? getOrCreateOrchestrationSemaphore(cwd, orchestrationRunId)
							: undefined;
					if (orchestrationSemaphore) {
						releaseRunSlot = await orchestrationSemaphore.acquire();
						throwIfAborted();
					}
					releaseSlot = await subagentSemaphore.acquire();
					throwIfAborted();
					if (orchestrationRunId && orchestrationTaskId) {
						updateTeamTaskStatus({
							cwd,
							runId: orchestrationRunId,
							taskId: orchestrationTaskId,
							status: "running",
						});
					}
					if (writeCapableProfiles.has(effectiveProfile)) {
						const explicitLockKey = lockKey?.trim();
						// Parallel orchestration should remain truly parallel by default.
						// Serialize write-capable agents only when an explicit lock_key is provided.
						if (explicitLockKey) {
							const lock = getOrCreateWriteLock(explicitLockKey);
							releaseWriteLock = await lock.acquire();
						}
					}
					if (useWorktree) {
						const isolated = provisionWorktree(cwd, requestedSubagentCwd, runId);
						subagentCwd = isolated.runCwd;
						worktreePath = isolated.worktreePath;
						releaseIsolation = isolated.cleanup;
					}
					emitProgress({
						kind: "subagent_progress",
						phase: "starting",
						message: "starting subagent",
						cwd: subagentCwd,
						activeTool: undefined,
					});

					let output: string;
					let subagentSessionId: string | undefined;
					let delegatedTasks = 0;
					let delegatedSucceeded = 0;
					let delegatedFailed = 0;
					const delegationWarnings: string[] = [];
					const delegatedSections: Array<string | undefined> = [];
					const delegatedStats = {
						toolCallsStarted: 0,
						toolCallsCompleted: 0,
						assistantMessages: 0,
					};
					try {
						const rootMeta = formatMetaCheckpoint(options?.getMetaMessages?.());
						const rootPrompt =
							rootMeta.section && rootMeta.appliedCount > 0
								? `${promptWithInstructions}\n\n${rootMeta.section}`
								: promptWithInstructions;
						if (rootMeta.appliedCount > 0) {
							emitProgress({
								kind: "subagent_progress",
								phase: "running",
								message: `applied ${rootMeta.appliedCount} meta update(s) to root task`,
								cwd: subagentCwd,
								activeTool: undefined,
							});
						}
						const result = await runner({
							systemPrompt,
							tools,
							prompt: rootPrompt,
							cwd: subagentCwd,
							modelOverride: effectiveModelOverride,
							signal: _signal,
							onProgress: (progress) => emitProgress(progress),
						});
						throwIfAborted();
						if (typeof result === "string") {
							output = result;
						} else {
							output = result.output;
							subagentSessionId = result.sessionId;
							runStats = result.stats;
						}

						const parsedDelegation = parseDelegationRequests(
							output,
							delegationDepth > 0 ? maxDelegationsPerTaskFromEnv : 0,
						);
						output = parsedDelegation.cleanedOutput;
						delegationWarnings.push(...parsedDelegation.warnings);
						const delegateTotal = parsedDelegation.requests.length;
						const delegateItems: TaskDelegateProgressItem[] = parsedDelegation.requests.map((request, index) => ({
							index: index + 1,
							description: request.description,
							profile: request.profile,
							status: "pending",
						}));
						const normalizedDependsOn: number[][] = parsedDelegation.requests.map((request, index) => {
							const current = index + 1;
							const raw = request.dependsOn ?? [];
							const unique = new Set<number>();
							for (const dep of raw) {
								if (!Number.isInteger(dep) || dep <= 0 || dep > delegateTotal || dep === current) {
									delegationWarnings.push(
										`Delegated task ${current} has invalid depends_on reference "${dep}" and it was ignored.`,
									);
									continue;
								}
								unique.add(dep);
							}
							return Array.from(unique).sort((a, b) => a - b);
						});
						delegatedTasks += delegateTotal;
						if (delegateTotal > 0) {
							emitProgress({
								kind: "subagent_progress",
								phase: "running",
								message: `delegation scheduler: ${delegateTotal} task(s), max parallel ${Math.min(delegateTotal, maxDelegatedParallelFromEnv)}`,
								cwd: subagentCwd,
								activeTool: undefined,
								delegateTotal,
								delegateItems,
							});
						}

						const pendingIndices = new Set<number>(Array.from({ length: delegateTotal }, (_v, i) => i));
						const runningDelegates = new Map<number, Promise<void>>();
						const maxDelegateParallel = Math.max(1, Math.min(delegateTotal || 1, maxDelegatedParallelFromEnv));

						const statusOf = (idx: number): TaskDelegateProgressStatus =>
							delegateItems[idx]?.status ?? "pending";

						const markDelegateFailed = (index: number, message: string, details?: string): void => {
							const request = parsedDelegation.requests[index];
							if (delegateItems[index]) {
								delegateItems[index].status = "failed";
							}
							delegatedFailed += 1;
							if (details) {
								delegationWarnings.push(details);
							}
							delegatedSections[index] =
								`#### ${index + 1}. ${request.description} (${request.profile})\nERROR: ${message}`;
							emitProgress({
								kind: "subagent_progress",
								phase: "running",
								message,
								cwd: subagentCwd,
								activeTool: undefined,
								delegateIndex: index + 1,
								delegateTotal,
								delegateDescription: request.description,
								delegateProfile: request.profile,
								delegateItems,
							});
						};

						const runDelegate = async (index: number): Promise<void> => {
							throwIfAborted();
							const request = parsedDelegation.requests[index];
							const childProfile = request.profile;
							if (delegateItems[index]) {
								delegateItems[index].status = "running";
							}
							emitProgress({
								kind: "subagent_progress",
								phase: "running",
								message: `delegating ${index + 1}/${delegateTotal}: ${request.description}`,
								cwd: subagentCwd,
								activeTool: undefined,
								delegateIndex: index + 1,
								delegateTotal,
								delegateDescription: request.description,
								delegateProfile: childProfile,
								delegateItems,
							});

							const childTools = [...(toolsByProfile[childProfile] ?? toolsByProfile.explore)];
							const childBaseSystemPrompt =
								systemPromptByProfile[childProfile] ?? systemPromptByProfile.full;
							const childSystemPrompt = withDelegationPrompt(
								childBaseSystemPrompt,
								Math.max(0, delegationDepth - 1),
							);
							const requestedChildCwd = request.cwd ? path.resolve(subagentCwd, request.cwd) : subagentCwd;
							if (!existsSync(requestedChildCwd) || !statSync(requestedChildCwd).isDirectory()) {
								markDelegateFailed(
									index,
									`delegate ${index + 1}/${delegateTotal} skipped: missing cwd`,
									`Delegated task "${request.description}" skipped: cwd does not exist (${requestedChildCwd}).`,
								);
								return;
							}

							let childReleaseLock: (() => void) | undefined;
							let childReleaseIsolation: (() => void) | undefined;
							let childCwd = requestedChildCwd;
							try {
								throwIfAborted();
								const explicitChildLock = request.lockKey?.trim();
								if (writeCapableProfiles.has(childProfile) && explicitChildLock) {
									const lock = getOrCreateWriteLock(explicitChildLock);
									childReleaseLock = await lock.acquire();
									throwIfAborted();
								}
								if (request.isolation === "worktree") {
									const isolated = provisionWorktree(cwd, requestedChildCwd, `${runId}_delegate_${index + 1}`);
									childCwd = isolated.runCwd;
									childReleaseIsolation = isolated.cleanup;
								}

								const delegateMeta = formatMetaCheckpoint(options?.getMetaMessages?.());
								const delegatePrompt =
									delegateMeta.section && delegateMeta.appliedCount > 0
										? `${request.prompt}\n\n${delegateMeta.section}`
										: request.prompt;
								if (delegateMeta.appliedCount > 0) {
									emitProgress({
										kind: "subagent_progress",
										phase: "running",
										message: `delegate ${index + 1}/${delegateTotal}: applied ${delegateMeta.appliedCount} meta update(s)`,
										cwd: childCwd,
										activeTool: undefined,
										delegateIndex: index + 1,
										delegateTotal,
										delegateDescription: request.description,
										delegateProfile: childProfile,
										delegateItems,
									});
								}

								const childResult = await runner({
									systemPrompt: childSystemPrompt,
									tools: childTools,
									prompt: delegatePrompt,
									cwd: childCwd,
									modelOverride: request.model,
									signal: _signal,
									onProgress: (progress) => {
										emitProgress({
											kind: "subagent_progress",
											phase: "running",
											message: `delegate ${index + 1}/${delegateTotal}: ${progress.message}`,
											cwd: progress.cwd ?? childCwd,
											activeTool: progress.activeTool,
											delegateIndex: index + 1,
											delegateTotal,
											delegateDescription: request.description,
											delegateProfile: childProfile,
											delegateItems,
										});
									},
								});
								throwIfAborted();

								let childOutput: string;
								let childStats: SubagentRunResult["stats"] | undefined;
								if (typeof childResult === "string") {
									childOutput = childResult;
								} else {
									childOutput = childResult.output;
									childStats = childResult.stats;
								}

								const parsedChildDelegation = parseDelegationRequests(childOutput, 0);
								childOutput = parsedChildDelegation.cleanedOutput;
								delegationWarnings.push(
									...parsedChildDelegation.warnings.map((warning) => `Child ${index + 1}: ${warning}`),
								);
								delegatedSucceeded += 1;
								if (delegateItems[index]) {
									delegateItems[index].status = "done";
								}
								delegatedStats.toolCallsStarted += childStats?.toolCallsStarted ?? 0;
								delegatedStats.toolCallsCompleted += childStats?.toolCallsCompleted ?? 0;
								delegatedStats.assistantMessages += childStats?.assistantMessages ?? 0;
								const normalizedChildOutput = childOutput.trim().length > 0 ? childOutput.trim() : "(no output)";
								const childOutputExcerpt =
									normalizedChildOutput.length > maxDelegatedOutputCharsFromEnv
										? `${normalizedChildOutput.slice(0, Math.max(1, maxDelegatedOutputCharsFromEnv - 3))}...`
										: normalizedChildOutput;
								delegatedSections[index] =
									`#### ${index + 1}. ${request.description} (${childProfile})\n${childOutputExcerpt}`;
								emitProgress({
									kind: "subagent_progress",
									phase: "running",
									message: `delegate ${index + 1}/${delegateTotal} done`,
									cwd: childCwd,
									activeTool: undefined,
									delegateIndex: index + 1,
									delegateTotal,
									delegateDescription: request.description,
									delegateProfile: childProfile,
									delegateItems,
								});
							} catch (error) {
								const message = error instanceof Error ? error.message : String(error);
								if (_signal?.aborted || isAbortError(error)) {
									throw new Error("Operation aborted");
								}
								markDelegateFailed(index, `delegate ${index + 1}/${delegateTotal} failed`, message);
							} finally {
								childReleaseIsolation?.();
								childReleaseLock?.();
							}
						};

						const resolveBlockedByFailedDependencies = (): boolean => {
							let changed = false;
							for (const index of Array.from(pendingIndices)) {
								const deps = normalizedDependsOn[index] ?? [];
								if (deps.length === 0) continue;
								const failedDep = deps.find((dep) => statusOf(dep - 1) === "failed");
								if (!failedDep) continue;
								pendingIndices.delete(index);
								markDelegateFailed(
									index,
									`delegate ${index + 1}/${delegateTotal} skipped: dependency ${failedDep} failed`,
									`Delegated task ${index + 1} skipped because dependency ${failedDep} failed.`,
								);
								changed = true;
							}
							return changed;
						};

						const launchReadyDelegates = (): boolean => {
							let launched = false;
							while (runningDelegates.size < maxDelegateParallel) {
								let nextIndex: number | undefined;
								for (const index of pendingIndices) {
									const deps = normalizedDependsOn[index] ?? [];
									const allDone = deps.every((dep) => statusOf(dep - 1) === "done");
									if (allDone) {
										nextIndex = index;
										break;
									}
								}
								if (nextIndex === undefined) {
									break;
								}
								pendingIndices.delete(nextIndex);
								const promise = runDelegate(nextIndex).finally(() => {
									runningDelegates.delete(nextIndex);
								});
								runningDelegates.set(nextIndex, promise);
								launched = true;
							}
							return launched;
						};

						while (pendingIndices.size > 0 || runningDelegates.size > 0) {
							throwIfAborted();
							const changed = resolveBlockedByFailedDependencies();
							const launched = launchReadyDelegates();
							if (runningDelegates.size === 0) {
								if (pendingIndices.size > 0 && !changed && !launched) {
									for (const index of Array.from(pendingIndices)) {
										pendingIndices.delete(index);
										const deps = normalizedDependsOn[index] ?? [];
										markDelegateFailed(
											index,
											`delegate ${index + 1}/${delegateTotal} blocked: unresolved depends_on`,
											`Delegated task ${index + 1} blocked by unresolved dependencies: ${deps.join(", ") || "unknown"}.`,
										);
									}
								}
								break;
							}
							await Promise.race(Array.from(runningDelegates.values()));
						}
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						if (_signal?.aborted || isAbortError(error)) {
							throw new Error("Operation aborted");
						}
						const details: TaskToolDetails = {
							profile: effectiveProfile,
							description,
							outputLength: 0,
							cwd: subagentCwd,
							agent: customSubagent?.name,
							lockKey: lockKey?.trim() || undefined,
							runId,
							taskId: orchestrationTaskId,
							model: effectiveModelOverride,
							isolation: useWorktree ? "worktree" : "none",
							worktreePath,
							waitMs: Date.now() - queuedAt,
							background: runInBackground,
							toolCallsStarted: runStats?.toolCallsStarted ?? latestProgress?.toolCallsStarted,
							toolCallsCompleted: runStats?.toolCallsCompleted ?? latestProgress?.toolCallsCompleted,
							assistantMessages: runStats?.assistantMessages ?? latestProgress?.assistantMessages,
							delegatedTasks: delegatedTasks > 0 ? delegatedTasks : undefined,
							delegatedSucceeded: delegatedTasks > 0 ? delegatedSucceeded : undefined,
							delegatedFailed: delegatedTasks > 0 ? delegatedFailed : undefined,
						};
						if (orchestrationRunId && orchestrationTaskId) {
							updateTeamTaskStatus({
								cwd,
								runId: orchestrationRunId,
								taskId: orchestrationTaskId,
								status: "error",
							});
						}
						throw Object.assign(new Error(`Subagent failed: ${message}`), { details });
					}

					const normalizedOutput = output.trim().length > 0 ? output.trim() : "(Subagent completed with no output)";
					const finalSections: string[] = [normalizedOutput];
					if (delegatedTasks > 0) {
						const header = `### Delegated Subtasks (${delegatedSucceeded}/${delegatedTasks} done)`;
						const delegatedBlocks = delegatedSections.filter(
							(section): section is string => typeof section === "string" && section.trim().length > 0,
						);
						finalSections.push([header, ...delegatedBlocks].join("\n\n"));
					}
					if (delegationWarnings.length > 0) {
						finalSections.push(`### Delegation Notes\n${delegationWarnings.map((w) => `- ${w}`).join("\n")}`);
					}
					const text = finalSections.join("\n\n");
						emitProgress({
							kind: "subagent_progress",
							phase: "responding",
							message: delegatedTasks > 0 ? "aggregating delegated results" : "finalizing response",
							cwd: subagentCwd,
							activeTool: undefined,
							delegateIndex: undefined,
							delegateTotal: undefined,
							delegateDescription: undefined,
							delegateProfile: undefined,
							delegateItems: undefined,
						});

					const transcriptPath = persistSubagentTranscript({
						rootCwd: cwd,
						runId,
						description,
						profile: effectiveProfile,
						agent: customSubagent?.name,
						lockKey: lockKey?.trim() || undefined,
						model: effectiveModelOverride,
						subagentCwd,
						sessionId: subagentSessionId,
						prompt: promptWithInstructions,
						output: text,
						isolation: useWorktree ? "worktree" : "none",
						worktreePath,
					});
					const details: TaskToolDetails = {
						profile: effectiveProfile,
						description,
						outputLength: text.length,
						cwd: subagentCwd,
						agent: customSubagent?.name,
						lockKey: lockKey?.trim() || undefined,
						runId,
						taskId: orchestrationTaskId,
						model: effectiveModelOverride,
						subagentSessionId,
						transcriptPath,
						isolation: useWorktree ? "worktree" : "none",
						worktreePath,
						waitMs: Date.now() - queuedAt,
						background: runInBackground,
						toolCallsStarted:
							typeof (runStats?.toolCallsStarted ?? latestProgress?.toolCallsStarted) === "number"
								? (runStats?.toolCallsStarted ?? latestProgress?.toolCallsStarted ?? 0) +
									delegatedStats.toolCallsStarted
								: delegatedStats.toolCallsStarted > 0
									? delegatedStats.toolCallsStarted
									: undefined,
						toolCallsCompleted:
							typeof (runStats?.toolCallsCompleted ?? latestProgress?.toolCallsCompleted) === "number"
								? (runStats?.toolCallsCompleted ?? latestProgress?.toolCallsCompleted ?? 0) +
									delegatedStats.toolCallsCompleted
								: delegatedStats.toolCallsCompleted > 0
									? delegatedStats.toolCallsCompleted
									: undefined,
						assistantMessages:
							typeof (runStats?.assistantMessages ?? latestProgress?.assistantMessages) === "number"
								? (runStats?.assistantMessages ?? latestProgress?.assistantMessages ?? 0) +
									delegatedStats.assistantMessages
								: delegatedStats.assistantMessages > 0
									? delegatedStats.assistantMessages
									: undefined,
						delegatedTasks: delegatedTasks > 0 ? delegatedTasks : undefined,
						delegatedSucceeded: delegatedTasks > 0 ? delegatedSucceeded : undefined,
						delegatedFailed: delegatedTasks > 0 ? delegatedFailed : undefined,
					};
					if (orchestrationRunId && orchestrationTaskId) {
						updateTeamTaskStatus({
							cwd,
							runId: orchestrationRunId,
							taskId: orchestrationTaskId,
							status: "done",
						});
					}
					return { text, details };
				} finally {
					releaseIsolation?.();
					releaseWriteLock?.();
					releaseSlot?.();
					releaseRunSlot?.();
				}
			};

			if (runInBackground) {
				const now = new Date().toISOString();
				const queuedStatusPath = writeBackgroundRunStatus(cwd, {
					runId,
					status: "queued",
					createdAt: now,
					description,
					profile: effectiveProfile,
					cwd: requestedSubagentCwd,
					agent: customSubagent?.name,
					model: effectiveModelOverride,
				});
				void (async () => {
					writeBackgroundRunStatus(cwd, {
						runId,
						status: "running",
						createdAt: now,
						startedAt: new Date().toISOString(),
						description,
						profile: effectiveProfile,
						cwd: requestedSubagentCwd,
						agent: customSubagent?.name,
						model: effectiveModelOverride,
					});
					try {
						const result = await executeSubagent();
						writeBackgroundRunStatus(cwd, {
							runId,
							status: "done",
							createdAt: now,
							finishedAt: new Date().toISOString(),
							description,
							profile: effectiveProfile,
							cwd: result.details.cwd,
							agent: customSubagent?.name,
							model: effectiveModelOverride,
							transcriptPath: result.details.transcriptPath,
						});
					} catch (error) {
						writeBackgroundRunStatus(cwd, {
							runId,
							status: "error",
							createdAt: now,
							finishedAt: new Date().toISOString(),
							description,
							profile: effectiveProfile,
							cwd: requestedSubagentCwd,
							agent: customSubagent?.name,
							model: effectiveModelOverride,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				})();
				return {
					content: [
						{
							type: "text" as const,
							text: `Started background subagent run ${runId}. Check .iosm/subagents/background and /subagent-runs for results.`,
						},
					],
					details: {
						profile: effectiveProfile,
						description,
						outputLength: 0,
						cwd: requestedSubagentCwd,
						agent: customSubagent?.name,
						lockKey: lockKey?.trim() || undefined,
						runId,
						taskId: orchestrationTaskId,
						model: effectiveModelOverride,
						background: true,
						backgroundStatusPath: queuedStatusPath,
						waitMs: Date.now() - queuedAt,
						isolation: useWorktree ? "worktree" : "none",
						toolCallsStarted: latestProgress?.toolCallsStarted,
						toolCallsCompleted: latestProgress?.toolCallsCompleted,
						assistantMessages: latestProgress?.assistantMessages,
					},
				};
			}

			const result = await executeSubagent();
			return {
				content: [{ type: "text" as const, text: result.text }],
				details: result.details,
			};
		},
	};
}
