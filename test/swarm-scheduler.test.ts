import { describe, expect, it } from "vitest";
import { runSwarmScheduler } from "../src/core/swarm/scheduler.js";
import type { SwarmPlan } from "../src/core/swarm/types.js";

describe("swarm scheduler", () => {
	it("dispatches independent tasks concurrently up to maxParallel", async () => {
		const plan: SwarmPlan = {
			source: "plain",
			request: "parallel dispatch check",
			notes: [],
			tasks: [
				{
					id: "task_1",
					brief: "task one",
					depends_on: [],
					scopes: ["src/a/**"],
					touches: ["src/a/file.ts"],
					concurrency_class: "implementation",
					severity: "medium",
					needs_user_input: false,
					spawn_policy: "allow",
				},
				{
					id: "task_2",
					brief: "task two",
					depends_on: [],
					scopes: ["src/b/**"],
					touches: ["src/b/file.ts"],
					concurrency_class: "implementation",
					severity: "medium",
					needs_user_input: false,
					spawn_policy: "allow",
				},
				{
					id: "task_3",
					brief: "task three",
					depends_on: [],
					scopes: ["src/c/**"],
					touches: ["src/c/file.ts"],
					concurrency_class: "implementation",
					severity: "medium",
					needs_user_input: false,
					spawn_policy: "allow",
				},
			],
		};

		let active = 0;
		let maxActive = 0;
		const result = await runSwarmScheduler({
			runId: "swarm_scheduler_parallel_dispatch",
			plan,
			contract: {},
			maxParallel: 2,
			dispatchTask: async ({ task }) => {
				active += 1;
				maxActive = Math.max(maxActive, active);
				await new Promise((resolve) => setTimeout(resolve, 25));
				active -= 1;
				return {
					taskId: task.id,
					status: "done",
				};
			},
		});

		expect(result.state.status).toBe("completed");
		expect(maxActive).toBe(2);
	});

	it("runs a dependent DAG to completion", async () => {
		const plan: SwarmPlan = {
			source: "plain",
			request: "refactor auth",
			notes: [],
			tasks: [
				{
					id: "task_1",
					brief: "analyze",
					depends_on: [],
					scopes: ["src/auth/**"],
					touches: ["src/auth/map.ts"],
					concurrency_class: "analysis",
					severity: "low",
					needs_user_input: false,
					spawn_policy: "allow",
				},
				{
					id: "task_2",
					brief: "implement",
					depends_on: ["task_1"],
					scopes: ["src/auth/**"],
					touches: ["src/auth/token.ts"],
					concurrency_class: "implementation",
					severity: "high",
					needs_user_input: false,
					spawn_policy: "allow",
				},
				{
					id: "task_3",
					brief: "verify",
					depends_on: ["task_2"],
					scopes: ["src/auth/**"],
					touches: ["test/auth/token.test.ts"],
					concurrency_class: "verification",
					severity: "medium",
					needs_user_input: false,
					spawn_policy: "allow",
				},
			],
		};

		const executed: string[] = [];
		const result = await runSwarmScheduler({
			runId: "swarm_scheduler_ok",
			plan,
			contract: {},
			maxParallel: 2,
			dispatchTask: async ({ task }) => {
				executed.push(task.id);
				return {
					taskId: task.id,
					status: "done",
					costUsd: 0.1,
				};
			},
		});

		expect(result.state.status).toBe("completed");
		expect(result.runGate.pass).toBe(true);
		expect(Object.values(result.state.tasks).every((task) => task.status === "done")).toBe(true);
		expect(executed).toEqual(["task_1", "task_2", "task_3"]);
	});

	it("retries failed task within retry taxonomy limits", async () => {
		const plan: SwarmPlan = {
			source: "plain",
			request: "fix flaky test",
			notes: [],
			tasks: [
				{
					id: "task_1",
					brief: "run tests",
					depends_on: [],
					scopes: ["test/**"],
					touches: ["test/flaky.test.ts"],
					concurrency_class: "tests",
					severity: "medium",
					needs_user_input: false,
					spawn_policy: "allow",
				},
			],
		};

		let attempt = 0;
		const result = await runSwarmScheduler({
			runId: "swarm_scheduler_retry",
			plan,
			contract: {},
			maxParallel: 1,
			dispatchTask: async ({ task }) => {
				attempt += 1;
				if (attempt === 1) {
					return {
						taskId: task.id,
						status: "error",
						error: "Test failed: expect(true).toBe(false)",
					};
				}
				return {
					taskId: task.id,
					status: "done",
				};
			},
		});

		expect(attempt).toBe(2);
		expect(result.state.tasks.task_1?.status).toBe("done");
		expect(result.state.retries.task_1).toBe(1);
	});

	it("propagates failureCause into task_retry and task_error events", async () => {
		const plan: SwarmPlan = {
			source: "plain",
			request: "delegate failure escalation",
			notes: [],
			tasks: [
				{
					id: "task_1",
					brief: "run delegated work",
					depends_on: [],
					scopes: ["src/**"],
					touches: ["src/app.ts"],
					concurrency_class: "implementation",
					severity: "high",
					needs_user_input: false,
					spawn_policy: "allow",
				},
			],
		};

		let attempts = 0;
		const failureCause = "delegates_failed 1/2 (logic_error=1)";
		const result = await runSwarmScheduler({
			runId: "swarm_scheduler_failure_cause",
			plan,
			contract: {},
			maxParallel: 1,
			dispatchTask: async ({ task }) => {
				attempts += 1;
				return {
					taskId: task.id,
					status: "error",
					error: "delegates_failed 1/2",
					failureCause,
				};
			},
		});

		expect(attempts).toBe(2);
		const retryEvent = result.events.find((event) => event.type === "task_retry");
		const errorEvent = result.events.find((event) => event.type === "task_error");
		expect(retryEvent?.payload?.failureCause).toBe(failureCause);
		expect(errorEvent?.payload?.failureCause).toBe(failureCause);
		expect(result.state.tasks.task_1?.status).toBe("error");
	});

	it("applies conflict-density guard and emits scheduler guard events", async () => {
		const plan: SwarmPlan = {
			source: "plain",
			request: "parallel touching same area",
			notes: [],
			tasks: [
				{
					id: "task_1",
					brief: "task 1",
					depends_on: [],
					scopes: ["src/auth/**"],
					touches: ["src/auth/**"],
					concurrency_class: "implementation",
					severity: "medium",
					needs_user_input: false,
					spawn_policy: "allow",
				},
				{
					id: "task_2",
					brief: "task 2",
					depends_on: [],
					scopes: ["src/auth/**"],
					touches: ["src/auth/token.ts"],
					concurrency_class: "implementation",
					severity: "medium",
					needs_user_input: false,
					spawn_policy: "allow",
				},
				{
					id: "task_3",
					brief: "task 3",
					depends_on: [],
					scopes: ["src/auth/**"],
					touches: ["src/auth/session.ts"],
					concurrency_class: "implementation",
					severity: "medium",
					needs_user_input: false,
					spawn_policy: "allow",
				},
			],
		};

		const guardPayloads: Array<Record<string, unknown>> = [];
		const result = await runSwarmScheduler({
			runId: "swarm_scheduler_conflict_guard",
			plan,
			contract: {},
			maxParallel: 3,
			conflictDensityGuard: {
				threshold: 0.1,
				minParallel: 1,
			},
			dispatchTask: async ({ task }) => ({
				taskId: task.id,
				status: "done",
			}),
			onEvent: (event) => {
				if (event.type === "tick" && event.message === "scheduler_guards" && event.payload) {
					guardPayloads.push(event.payload);
				}
			},
		});

		expect(result.state.status).toBe("completed");
		expect(guardPayloads.length).toBeGreaterThan(0);
		expect(Number(guardPayloads[0]?.effective_max_parallel ?? 3)).toBeLessThanOrEqual(2);
	});

	it("requires confirmation for high-risk spawn candidates", async () => {
		const plan: SwarmPlan = {
			source: "plain",
			request: "spawn gating",
			notes: [],
			tasks: [
				{
					id: "task_1",
					brief: "main task",
					depends_on: [],
					scopes: ["src/**"],
					touches: ["src/main.ts"],
					concurrency_class: "implementation",
					severity: "high",
					needs_user_input: false,
					spawn_policy: "manual_high_risk",
				},
			],
		};

		let confirmCalls = 0;
		const result = await runSwarmScheduler({
			runId: "swarm_scheduler_spawn_confirm",
			plan,
			contract: {},
			maxParallel: 1,
			dispatchTask: async ({ task }) => ({
				taskId: task.id,
				status: "done",
				spawnCandidates: [
					{
						description: "touch database migration",
						path: "src/db/migrations/001.sql",
						changeType: "schema",
						severity: "high",
						parentTaskId: task.id,
					},
				],
			}),
			confirmSpawn: async () => {
				confirmCalls += 1;
				return false;
			},
		});

		expect(confirmCalls).toBe(1);
		expect(result.spawnBacklog).toHaveLength(0);
		expect(result.events.some((event) => event.type === "spawn_rejected")).toBe(true);
	});
});
