import type { EngineeringContract } from "../contract.js";
import type { RepoScaleMode } from "../project-index/types.js";

export type SwarmTaskStatus = "pending" | "ready" | "running" | "done" | "error" | "blocked" | "cancelled";
export type SwarmRunStatus = "running" | "completed" | "blocked" | "stopped" | "failed";
export type SwarmSeverity = "low" | "medium" | "high";
export type SwarmConcurrencyClass = "default" | "analysis" | "implementation" | "verification" | "docs" | "tests";
export type SwarmSpawnPolicy = "allow" | "manual_high_risk" | "deny";

export interface SwarmTaskPlan {
	id: string;
	brief: string;
	depends_on: string[];
	scopes: string[];
	touches: string[];
	concurrency_class: SwarmConcurrencyClass;
	severity: SwarmSeverity;
	needs_user_input: boolean;
	model_hint?: string;
	spawn_policy?: SwarmSpawnPolicy;
}

export interface SwarmTaskRuntimeState {
	id: string;
	status: SwarmTaskStatus;
	attempts: number;
	depends_on: string[];
	startedAt?: string;
	completedAt?: string;
	lastError?: string;
	touches: string[];
	scopes: string[];
}

export interface SwarmBudgetState {
	limitUsd?: number;
	spentUsd: number;
	warned80: boolean;
	hardStopped: boolean;
}

export interface SwarmRuntimeState {
	runId: string;
	status: SwarmRunStatus;
	createdAt: string;
	updatedAt: string;
	tick: number;
	noProgressTicks: number;
	readyQueue: string[];
	blockedTasks: string[];
	tasks: Record<string, SwarmTaskRuntimeState>;
	locks: Record<string, string[]>;
	retries: Record<string, number>;
	budget: SwarmBudgetState;
	lastError?: string;
}

export type SwarmEventType =
	| "run_started"
	| "tick"
	| "task_ready"
	| "task_running"
	| "task_done"
	| "task_error"
	| "task_blocked"
	| "task_retry"
	| "lock_acquired"
	| "lock_released"
	| "spawn_enqueued"
	| "spawn_rejected"
	| "run_completed"
	| "run_blocked"
	| "run_stopped"
	| "run_failed"
	| "gate_task"
	| "gate_run";

export interface SwarmEvent {
	type: SwarmEventType;
	timestamp: string;
	runId: string;
	tick?: number;
	taskId?: string;
	message: string;
	payload?: Record<string, unknown>;
}

export interface SwarmGateResult {
	taskId: string;
	pass: boolean;
	warnings: string[];
	failures: string[];
	checks: string[];
}

export interface SwarmRunGateResult {
	pass: boolean;
	warnings: string[];
	failures: string[];
}

export interface SwarmSpawnCandidate {
	description: string;
	path: string;
	changeType: string;
	severity: SwarmSeverity;
	parentTaskId?: string;
}

export interface SwarmDispatchResult {
	taskId: string;
	status: "done" | "error" | "blocked";
	error?: string;
	failureCause?: string;
	costUsd?: number;
	touchesRefined?: string[];
	spawnCandidates?: SwarmSpawnCandidate[];
}

export interface SwarmPlan {
	source: "plain" | "singular";
	request: string;
	tasks: SwarmTaskPlan[];
	notes: string[];
}

export interface SwarmRunMeta {
	runId: string;
	createdAt: string;
	source: "plain" | "singular";
	request: string;
	contract: EngineeringContract;
	contractHash: string;
	repoScaleMode: RepoScaleMode;
	semanticStatus?: string;
	maxParallel: number;
	budgetUsd?: number;
	linkedSingularRunId?: string;
	linkedSingularOption?: string;
}

export interface SwarmSchedulerResult {
	state: SwarmRuntimeState;
	taskGates: SwarmGateResult[];
	runGate: SwarmRunGateResult;
	events: SwarmEvent[];
}
