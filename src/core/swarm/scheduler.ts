import type { EngineeringContract } from "../contract.js";
import { touchesConflict, HierarchicalLockManager } from "./locks.js";
import { evaluateRunGates, evaluateTaskGates } from "./gates.js";
import { DEFAULT_RETRY_POLICY, shouldRetry, type SwarmRetryPolicy } from "./retry.js";
import { SwarmSpawnQueue } from "./spawn.js";
import type {
	SwarmDispatchResult,
	SwarmEvent,
	SwarmGateResult,
	SwarmPlan,
	SwarmRunGateResult,
	SwarmRuntimeState,
	SwarmSchedulerResult,
	SwarmTaskPlan,
	SwarmTaskRuntimeState,
} from "./types.js";

const TERMINAL_STATUSES = new Set<SwarmTaskRuntimeState["status"]>(["done", "error", "cancelled", "blocked"]);
const FAILURE_STATUSES = new Set<SwarmTaskRuntimeState["status"]>(["error", "cancelled"]);

function nowIso(): string {
	return new Date().toISOString();
}

function parseBoundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
	const parsed = raw ? Number.parseInt(raw, 10) : fallback;
	if (!Number.isInteger(parsed)) return fallback;
	return Math.max(min, Math.min(max, parsed));
}

function clampBoundedInt(value: number | undefined, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(value)));
}

function compact(values: string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function isTerminal(status: SwarmTaskRuntimeState["status"]): boolean {
	return TERMINAL_STATUSES.has(status);
}

function severityWeight(task: SwarmTaskPlan): number {
	if (task.severity === "high") return 3;
	if (task.severity === "medium") return 2;
	return 1;
}

function collectDependents(plan: SwarmPlan): Map<string, number> {
	const result = new Map<string, number>();
	for (const task of plan.tasks) {
		for (const dep of task.depends_on) {
			result.set(dep, (result.get(dep) ?? 0) + 1);
		}
	}
	return result;
}

function createTaskRuntimeState(task: SwarmTaskPlan): SwarmTaskRuntimeState {
	return {
		id: task.id,
		status: task.depends_on.length === 0 ? "ready" : "pending",
		attempts: 0,
		depends_on: [...task.depends_on],
		touches: [...task.touches],
		scopes: [...task.scopes],
	};
}

function buildInitialState(input: {
	runId: string;
	plan: SwarmPlan;
	budgetUsd?: number;
	existingState?: SwarmRuntimeState;
}): SwarmRuntimeState {
	if (input.existingState) {
		return {
			...input.existingState,
			updatedAt: nowIso(),
			status: input.existingState.status === "completed" ? "running" : input.existingState.status,
		};
	}

	const tasks: Record<string, SwarmTaskRuntimeState> = {};
	for (const task of input.plan.tasks) {
		tasks[task.id] = createTaskRuntimeState(task);
	}

	return {
		runId: input.runId,
		status: "running",
		createdAt: nowIso(),
		updatedAt: nowIso(),
		tick: 0,
		noProgressTicks: 0,
		readyQueue: Object.values(tasks)
			.filter((task) => task.status === "ready")
			.map((task) => task.id),
		blockedTasks: [],
		tasks,
		locks: {},
		retries: {},
		budget: {
			limitUsd: input.budgetUsd,
			spentUsd: 0,
			warned80: false,
			hardStopped: false,
		},
	};
}

function runHasOnlyBlockedTasks(state: SwarmRuntimeState): boolean {
	const tasks = Object.values(state.tasks);
	const unfinished = tasks.filter((task) => !isTerminal(task.status));
	if (unfinished.length > 0) return false;
	return tasks.length > 0 && tasks.some((task) => task.status === "blocked");
}

function collectReadyTasks(state: SwarmRuntimeState, planById: Map<string, SwarmTaskPlan>): string[] {
	const ready: string[] = [];
	for (const [taskId, runtime] of Object.entries(state.tasks)) {
		if (runtime.status !== "pending" && runtime.status !== "ready") continue;
		const plan = planById.get(taskId);
		if (!plan) continue;
		const depsDone = plan.depends_on.every((dep) => state.tasks[dep]?.status === "done");
		if (!depsDone) {
			runtime.status = "pending";
			continue;
		}
		if (runtime.status !== "ready") {
			runtime.status = "ready";
		}
		ready.push(taskId);
	}
	return ready;
}

function blockDependentsOfFailure(input: {
	failedTaskId: string;
	state: SwarmRuntimeState;
	planById: Map<string, SwarmTaskPlan>;
}): string[] {
	const blocked: string[] = [];
	const queue: string[] = [input.failedTaskId];
	const seen = new Set<string>(queue);

	while (queue.length > 0) {
		const failedId = queue.shift();
		if (!failedId) break;

		for (const [taskId, runtime] of Object.entries(input.state.tasks)) {
			if (runtime.status !== "pending" && runtime.status !== "ready") continue;
			const plan = input.planById.get(taskId);
			if (!plan || !plan.depends_on.includes(failedId)) continue;
			runtime.status = "blocked";
			runtime.completedAt = nowIso();
			runtime.lastError = `Dependency failed: ${failedId}`;
			blocked.push(taskId);
			if (!seen.has(taskId)) {
				seen.add(taskId);
				queue.push(taskId);
			}
		}
	}

	return blocked;
}

function selectBatch(input: {
	readyTaskIds: string[];
	planById: Map<string, SwarmTaskPlan>;
	maxParallel: number;
	dependents: Map<string, number>;
}): string[] {
	const sorted = [...input.readyTaskIds].sort((a, b) => {
		const taskA = input.planById.get(a);
		const taskB = input.planById.get(b);
		if (!taskA || !taskB) return a.localeCompare(b);
		const severityDelta = severityWeight(taskB) - severityWeight(taskA);
		if (severityDelta !== 0) return severityDelta;
		const dependentDelta = (input.dependents.get(b) ?? 0) - (input.dependents.get(a) ?? 0);
		if (dependentDelta !== 0) return dependentDelta;
		return a.localeCompare(b);
	});

	const selected: string[] = [];
	for (const taskId of sorted) {
		const plan = input.planById.get(taskId);
		if (!plan) continue;
		const hasConflictWithSelected = selected.some((existingId) => {
			const existing = input.planById.get(existingId);
			if (!existing) return false;
			return touchesConflict(existing.touches, plan.touches);
		});
		if (hasConflictWithSelected) continue;
		selected.push(taskId);
		if (selected.length >= Math.max(1, input.maxParallel)) break;
	}
	return selected;
}

function progressScore(task: SwarmTaskPlan, dependents: Map<string, number>): number {
	const dependentWeight = dependents.get(task.id) ?? 0;
	const touchWeight = Math.min(3, Math.max(1, task.touches.length));
	return severityWeight(task) * 3 + dependentWeight * 2 + touchWeight;
}

function applyProgressHeuristic(input: {
	readyTaskIds: string[];
	planById: Map<string, SwarmTaskPlan>;
	dependents: Map<string, number>;
	state: SwarmRuntimeState;
	activateAfterNoProgressTicks: number;
	minScore: number;
}): string[] {
	if (input.readyTaskIds.length <= 1) return input.readyTaskIds;
	if (input.state.noProgressTicks < input.activateAfterNoProgressTicks) return input.readyTaskIds;

	const scored = input.readyTaskIds
		.map((taskId) => {
			const plan = input.planById.get(taskId);
			if (!plan) return undefined;
			return { taskId, score: progressScore(plan, input.dependents), severity: plan.severity };
		})
		.filter((item): item is { taskId: string; score: number; severity: SwarmTaskPlan["severity"] } => item !== undefined)
		.sort((a, b) => b.score - a.score || a.taskId.localeCompare(b.taskId));
	if (scored.length === 0) return input.readyTaskIds;

	const topScore = scored[0]!.score;
	const threshold = Math.max(input.minScore, topScore - 2);
	const filtered = scored
		.filter((item) => item.score >= threshold || item.severity === "high")
		.map((item) => item.taskId);
	return filtered.length > 0 ? filtered : [scored[0]!.taskId];
}

function conflictDensity(input: { taskIds: string[]; planById: Map<string, SwarmTaskPlan> }): number {
	const count = input.taskIds.length;
	if (count < 2) return 0;
	let conflictingPairs = 0;
	let totalPairs = 0;
	for (let i = 0; i < count; i += 1) {
		const a = input.planById.get(input.taskIds[i]!);
		if (!a) continue;
		for (let j = i + 1; j < count; j += 1) {
			const b = input.planById.get(input.taskIds[j]!);
			if (!b) continue;
			totalPairs += 1;
			if (touchesConflict(a.touches, b.touches)) {
				conflictingPairs += 1;
			}
		}
	}
	return totalPairs > 0 ? conflictingPairs / totalPairs : 0;
}

function applyConflictDensityGuard(input: {
	readyTaskIds: string[];
	planById: Map<string, SwarmTaskPlan>;
	maxParallel: number;
	threshold: number;
	minParallel: number;
}): { effectiveMaxParallel: number; density: number } {
	const density = conflictDensity({ taskIds: input.readyTaskIds, planById: input.planById });
	if (density < input.threshold) {
		return { effectiveMaxParallel: input.maxParallel, density };
	}
	const scaled = Math.max(
		input.minParallel,
		Math.floor(input.maxParallel * Math.max(0.2, 1 - density)),
	);
	return {
		effectiveMaxParallel: Math.max(1, Math.min(input.maxParallel, scaled)),
		density,
	};
}

function shouldStopForBudget(state: SwarmRuntimeState): boolean {
	const limit = state.budget.limitUsd;
	if (limit === undefined || limit <= 0) return false;
	if (!state.budget.warned80 && state.budget.spentUsd >= limit * 0.8) {
		state.budget.warned80 = true;
	}
	if (state.budget.spentUsd >= limit) {
		state.budget.hardStopped = true;
		return true;
	}
	return false;
}

export interface RunSwarmSchedulerOptions {
	runId: string;
	plan: SwarmPlan;
	contract: EngineeringContract;
	maxParallel: number;
	budgetUsd?: number;
	existingState?: SwarmRuntimeState;
	retryPolicy?: SwarmRetryPolicy;
	/** Max time for a single dispatch call in milliseconds. Defaults to IOSM_SWARM_DISPATCH_TIMEOUT_MS or 180000. */
	dispatchTimeoutMs?: number;
	noProgressTickLimit?: number;
	spawnCap?: number;
	progressHeuristic?: {
		enabled?: boolean;
		activateAfterNoProgressTicks?: number;
		minScore?: number;
	};
	conflictDensityGuard?: {
		enabled?: boolean;
		threshold?: number;
		minParallel?: number;
	};
	confirmSpawn?: (input: {
		candidate: NonNullable<SwarmDispatchResult["spawnCandidates"]>[number];
		parentTask: SwarmTaskPlan;
		parentTaskRuntime: SwarmTaskRuntimeState;
		state: SwarmRuntimeState;
	}) => Promise<boolean>;
	dispatchTask: (input: {
		task: SwarmTaskPlan;
		runtime: SwarmTaskRuntimeState;
		tick: number;
	}) => Promise<SwarmDispatchResult>;
	onEvent?: (event: SwarmEvent, state: SwarmRuntimeState) => void;
	onStateChanged?: (state: SwarmRuntimeState) => void;
	shouldStop?: () => boolean;
}

export interface RunSwarmSchedulerExtendedResult extends SwarmSchedulerResult {
	spawnBacklog: Array<{ fingerprint: string; description: string; path: string; changeType: string }>;
}

export async function runSwarmScheduler(
	options: RunSwarmSchedulerOptions,
): Promise<RunSwarmSchedulerExtendedResult> {
	const planById = new Map(options.plan.tasks.map((task) => [task.id, task]));
	const dependents = collectDependents(options.plan);
	const retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
	const envDispatchTimeoutMs = parseBoundedInt(
		process.env.IOSM_SWARM_DISPATCH_TIMEOUT_MS,
		180_000,
		1_000,
		1_800_000,
	);
	const dispatchTimeoutMs = clampBoundedInt(options.dispatchTimeoutMs, envDispatchTimeoutMs, 1_000, 1_800_000);
	const noProgressLimit = Math.max(3, options.noProgressTickLimit ?? 8);
	const spawnCap = Math.max(1, options.spawnCap ?? 30);
	const progressHeuristicEnabled = options.progressHeuristic?.enabled !== false;
	const progressHeuristicActivateAfter = Math.max(1, options.progressHeuristic?.activateAfterNoProgressTicks ?? 2);
	const progressHeuristicMinScore = Math.max(1, options.progressHeuristic?.minScore ?? 4);
	const conflictGuardEnabled = options.conflictDensityGuard?.enabled !== false;
	const conflictGuardThreshold = Math.min(1, Math.max(0, options.conflictDensityGuard?.threshold ?? 0.45));
	const conflictGuardMinParallel = Math.max(1, options.conflictDensityGuard?.minParallel ?? 1);

	const state = buildInitialState({
		runId: options.runId,
		plan: options.plan,
		budgetUsd: options.budgetUsd,
		existingState: options.existingState,
	});
	const lockManager = new HierarchicalLockManager();
	const taskGateByTaskId = new Map<string, SwarmGateResult>();
	const spawned = new SwarmSpawnQueue();
	const events: SwarmEvent[] = [];

	for (const [taskId, taskState] of Object.entries(state.tasks)) {
		if (taskState.status === "running") {
			taskState.status = "pending";
			taskState.startedAt = undefined;
		}
		if (taskState.status === "done") {
			const plan = planById.get(taskId);
			if (plan) {
				taskGateByTaskId.set(taskId, evaluateTaskGates({ ...plan, touches: taskState.touches }, options.contract));
			}
		}
	}

	const emit = (type: SwarmEvent["type"], message: string, payload?: Record<string, unknown>, taskId?: string): void => {
		const event: SwarmEvent = {
			type,
			timestamp: nowIso(),
			runId: options.runId,
			tick: state.tick,
			message,
			payload,
			...(taskId ? { taskId } : {}),
		};
		events.push(event);
		options.onEvent?.(event, state);
	};

	emit("run_started", `Swarm run ${options.runId} started`, {
		tasks: options.plan.tasks.length,
		maxParallel: options.maxParallel,
		budgetUsd: options.budgetUsd,
	});
	options.onStateChanged?.(state);

	while (true) {
		if (options.shouldStop?.()) {
			state.status = "stopped";
			state.lastError = "Run interrupted by user.";
			emit("run_stopped", state.lastError);
			break;
		}

		state.tick += 1;
		state.updatedAt = nowIso();
		emit("tick", `scheduler_tick=${state.tick}`);

		if (shouldStopForBudget(state)) {
			state.status = "stopped";
			state.lastError = "Budget hard-stop reached.";
			emit("run_stopped", state.lastError, {
				budgetLimitUsd: state.budget.limitUsd,
				spentUsd: state.budget.spentUsd,
			});
			options.onStateChanged?.(state);
			break;
		}

		const readyTaskIds = collectReadyTasks(state, planById);
		state.readyQueue = [...readyTaskIds];
		state.blockedTasks = Object.values(state.tasks)
			.filter((task) => task.status === "blocked")
			.map((task) => task.id)
			.sort((a, b) => a.localeCompare(b));

		if (readyTaskIds.length === 0) {
			const allTerminal = Object.values(state.tasks).every((task) => isTerminal(task.status));
			if (allTerminal) {
				const runGate = evaluateRunGates({
					taskStates: state.tasks,
					taskGateResults: [...taskGateByTaskId.values()],
					contract: options.contract,
				});
				emit("gate_run", runGate.pass ? "run_gates_passed" : "run_gates_failed", {
					warnings: runGate.warnings,
					failures: runGate.failures,
				});
				if (runGate.pass && Object.values(state.tasks).every((task) => task.status === "done" || task.status === "blocked")) {
					state.status = runHasOnlyBlockedTasks(state) ? "blocked" : "completed";
					emit(state.status === "completed" ? "run_completed" : "run_blocked", `Swarm run ${state.status}`);
				} else {
					state.status = "failed";
					state.lastError = runGate.failures.join(" | ") || "Run gates failed.";
					emit("run_failed", state.lastError);
				}
				options.onStateChanged?.(state);
				break;
			}
			state.noProgressTicks += 1;
			if (state.noProgressTicks >= noProgressLimit) {
				state.status = "blocked";
				state.lastError = "No progress threshold reached.";
				emit("run_blocked", state.lastError, { noProgressTicks: state.noProgressTicks });
				options.onStateChanged?.(state);
				break;
			}
			options.onStateChanged?.(state);
			continue;
		}

		const progressReady = progressHeuristicEnabled
			? applyProgressHeuristic({
				readyTaskIds,
				planById,
				dependents,
				state,
				activateAfterNoProgressTicks: progressHeuristicActivateAfter,
				minScore: progressHeuristicMinScore,
			})
			: readyTaskIds;

		const guard = conflictGuardEnabled
			? applyConflictDensityGuard({
				readyTaskIds: progressReady,
				planById,
				maxParallel: options.maxParallel,
				threshold: conflictGuardThreshold,
				minParallel: conflictGuardMinParallel,
			})
			: { effectiveMaxParallel: options.maxParallel, density: conflictDensity({ taskIds: progressReady, planById }) };
		emit("tick", "scheduler_guards", {
			ready: readyTaskIds.length,
			progress_candidates: progressReady.length,
			conflict_density: Number(guard.density.toFixed(3)),
			effective_max_parallel: guard.effectiveMaxParallel,
			no_progress_ticks: state.noProgressTicks,
		});

		const preselected = selectBatch({
			readyTaskIds: progressReady,
			planById,
			maxParallel: guard.effectiveMaxParallel,
			dependents,
		});

		const selected: string[] = [];
		for (const taskId of preselected) {
			const plan = planById.get(taskId);
			if (!plan) continue;
			const lockCheck = lockManager.canAcquire(taskId, plan.touches);
			if (!lockCheck.ok) {
				const runtime = state.tasks[taskId];
				if (runtime) {
					runtime.status = "blocked";
					runtime.lastError = `Lock conflict: ${lockCheck.conflicts
						.map((conflict) => `${conflict.touch}<->${conflict.conflictingTouch}`)
						.join(", ")}`;
					emit("task_blocked", runtime.lastError, { conflicts: lockCheck.conflicts }, taskId);
				}
				continue;
			}
			selected.push(taskId);
		}

		if (selected.length === 0) {
			state.noProgressTicks += 1;
			if (state.noProgressTicks >= noProgressLimit) {
				state.status = "blocked";
				state.lastError = "No dispatch candidates after lock/budget filters.";
				emit("run_blocked", state.lastError, { ready: readyTaskIds });
				options.onStateChanged?.(state);
				break;
			}
			options.onStateChanged?.(state);
			continue;
		}

			let progressThisTick = false;
			const dispatchContexts: Array<{ taskId: string; plan: SwarmTaskPlan; runtime: SwarmTaskRuntimeState }> = [];
			for (const taskId of selected) {
				const plan = planById.get(taskId);
				const runtime = state.tasks[taskId];
				if (!plan || !runtime) continue;
				lockManager.acquire(taskId, runtime.touches.length > 0 ? runtime.touches : plan.touches);
				state.locks = lockManager.snapshot();
				emit("lock_acquired", `lock acquired for ${taskId}`, { touches: runtime.touches }, taskId);

				runtime.status = "running";
				runtime.attempts += 1;
				runtime.startedAt = nowIso();
				emit("task_running", `task ${taskId} running`, { attempt: runtime.attempts }, taskId);
				dispatchContexts.push({ taskId, plan, runtime });
			}
			options.onStateChanged?.(state);

			const dispatchResults = await Promise.all(
				dispatchContexts.map(async ({ taskId, plan, runtime }) => {
					let result: SwarmDispatchResult;
					try {
						const dispatchPromise = options.dispatchTask({
							task: plan,
							runtime,
							tick: state.tick,
						});
						// Prevent unhandled rejections when timeout wins the race.
						void dispatchPromise.catch(() => {
							// handled by timeout race path
						});
						let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
						const timeoutPromise = new Promise<SwarmDispatchResult>((resolve) => {
							timeoutHandle = setTimeout(() => {
								resolve({
									taskId,
									status: "error",
									error: `Dispatch timed out after ${dispatchTimeoutMs}ms.`,
									failureCause: "timeout",
								});
							}, dispatchTimeoutMs);
						});
						try {
							result = await Promise.race([dispatchPromise, timeoutPromise]);
						} finally {
							if (timeoutHandle) {
								clearTimeout(timeoutHandle);
							}
						}
					} catch (error) {
						result = {
							taskId,
							status: "error",
							error: error instanceof Error ? error.message : String(error),
						};
					}
					return { taskId, plan, runtime, result };
				}),
			);

			for (const { taskId, plan, runtime, result } of dispatchResults) {
				if (result.touchesRefined && result.touchesRefined.length > 0) {
					runtime.touches = compact(result.touchesRefined);
					lockManager.downgrade(taskId, runtime.touches);
					state.locks = lockManager.snapshot();
				}

				if (typeof result.costUsd === "number" && Number.isFinite(result.costUsd) && result.costUsd > 0) {
					state.budget.spentUsd += result.costUsd;
				}

				if (result.status === "done") {
					runtime.status = "done";
					runtime.completedAt = nowIso();
					runtime.lastError = undefined;
					progressThisTick = true;
					emit("task_done", `task ${taskId} done`, undefined, taskId);

					const gateResult = evaluateTaskGates({ ...plan, touches: runtime.touches }, options.contract);
					taskGateByTaskId.set(taskId, gateResult);
					emit(
						"gate_task",
						gateResult.pass ? "task_gates_passed" : "task_gates_failed",
						{
							warnings: gateResult.warnings,
							failures: gateResult.failures,
						},
						taskId,
					);
				} else if (result.status === "blocked") {
					runtime.status = "blocked";
					runtime.lastError = result.error ?? "Task blocked by user input or policy.";
					runtime.completedAt = nowIso();
					emit("task_blocked", runtime.lastError, undefined, taskId);
				} else {
					const errorMessage = result.error ?? "Unknown task failure.";
					const currentRetries = state.retries[taskId] ?? 0;
					const nonRetryableFailure =
						result.failureCause === "protocol_violation" || result.failureCause === "interrupted";
					const retryDecision = nonRetryableFailure
						? { retry: false, bucket: "unknown" as const, max: 0 }
						: shouldRetry({
								errorMessage,
								currentRetries,
								policy: retryPolicy,
							});
					if (retryDecision.retry) {
						state.retries[taskId] = currentRetries + 1;
						runtime.status = "ready";
						runtime.lastError = errorMessage;
						emit(
							"task_retry",
							`retry ${state.retries[taskId]}/${retryDecision.max} for ${taskId} (${retryDecision.bucket})`,
							{
								error: errorMessage,
								bucket: retryDecision.bucket,
								failureCause: result.failureCause ?? retryDecision.bucket,
							},
							taskId,
						);
					} else {
						runtime.status = "error";
						runtime.completedAt = nowIso();
						runtime.lastError = errorMessage;
						emit(
							"task_error",
							errorMessage,
							{ bucket: retryDecision.bucket, failureCause: result.failureCause ?? retryDecision.bucket },
							taskId,
						);
						if (FAILURE_STATUSES.has(runtime.status)) {
							const blockedDependents = blockDependentsOfFailure({
								failedTaskId: taskId,
								state,
								planById,
							});
							for (const blockedTaskId of blockedDependents) {
								const blockedRuntime = state.tasks[blockedTaskId];
								emit(
									"task_blocked",
									blockedRuntime?.lastError ?? `Dependency failed: ${taskId}`,
									{ dependency: taskId },
									blockedTaskId,
								);
							}
							if (blockedDependents.length > 0) {
								progressThisTick = true;
							}
						}
					}
				}

				for (const candidate of result.spawnCandidates ?? []) {
					if (spawned.size() >= spawnCap) break;
					const requiresConfirmation = candidate.severity === "high" || plan.spawn_policy === "manual_high_risk";
					if (requiresConfirmation && options.confirmSpawn) {
						const approved = await options.confirmSpawn({
							candidate,
							parentTask: plan,
							parentTaskRuntime: runtime,
							state,
						});
						if (!approved) {
							emit(
								"spawn_rejected",
								`spawn rejected from ${taskId}`,
								{
									description: candidate.description,
									path: candidate.path,
									changeType: candidate.changeType,
									severity: candidate.severity,
								},
								taskId,
							);
							continue;
						}
					}
					const queued = spawned.enqueue(candidate);
					if (!queued.accepted) continue;
					emit(
						"spawn_enqueued",
						`spawn queued from ${taskId}`,
						{
							fingerprint: queued.fingerprint,
							description: candidate.description,
							path: candidate.path,
							changeType: candidate.changeType,
							severity: candidate.severity,
						},
						taskId,
					);
				}

				lockManager.release(taskId);
				state.locks = lockManager.snapshot();
				emit("lock_released", `lock released for ${taskId}`, undefined, taskId);
				options.onStateChanged?.(state);
			}

		if (shouldStopForBudget(state)) {
			state.status = "stopped";
			state.lastError = "Budget hard-stop reached.";
			emit("run_stopped", state.lastError, {
				budgetLimitUsd: state.budget.limitUsd,
				spentUsd: state.budget.spentUsd,
			});
			options.onStateChanged?.(state);
			break;
		}

		state.noProgressTicks = progressThisTick ? 0 : state.noProgressTicks + 1;
		options.onStateChanged?.(state);
		if (!progressThisTick && state.noProgressTicks >= noProgressLimit) {
			state.status = "blocked";
			state.lastError = "No measurable progress within scheduler threshold.";
			emit("run_blocked", state.lastError, { noProgressTicks: state.noProgressTicks });
			options.onStateChanged?.(state);
			break;
		}
	}

	const runGate: SwarmRunGateResult = evaluateRunGates({
		taskStates: state.tasks,
		taskGateResults: [...taskGateByTaskId.values()],
		contract: options.contract,
	});
	if (state.status === "completed" && !runGate.pass) {
		state.status = "failed";
		state.lastError = runGate.failures.join(" | ") || "Run gates failed.";
		emit("run_failed", state.lastError);
	}

	const drainedSpawn = spawned.drain(spawnCap).map(({ fingerprint, candidate }) => ({
		fingerprint,
		description: candidate.description,
		path: candidate.path,
		changeType: candidate.changeType,
	}));

	return {
		state,
		taskGates: [...taskGateByTaskId.values()],
		runGate,
		events,
		spawnBacklog: drainedSpawn,
	};
}
