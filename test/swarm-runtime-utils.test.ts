import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyRetryBucket, shouldRetry } from "../src/core/swarm/retry.js";
import { createSpawnFingerprint, SwarmSpawnQueue } from "../src/core/swarm/spawn.js";
import { SwarmStateStore } from "../src/core/swarm/state-store.js";
import type { SwarmPlan, SwarmRunMeta, SwarmRuntimeState } from "../src/core/swarm/types.js";

describe("swarm runtime utils", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `iosm-swarm-utils-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("deduplicates spawn candidates by fingerprint", () => {
		const queue = new SwarmSpawnQueue();
		const candidate = {
			description: "add missing tests",
			path: "src/auth/token.ts",
			changeType: "test",
			severity: "medium" as const,
		};
		const first = queue.enqueue(candidate);
		const second = queue.enqueue({ ...candidate, description: "  add missing tests " });
		expect(first.accepted).toBe(true);
		expect(second.accepted).toBe(false);
		expect(first.fingerprint).toBe(createSpawnFingerprint(candidate));
		expect(queue.size()).toBe(1);
	});

	it("classifies retry buckets and enforces retry limits", () => {
		expect(classifyRetryBucket("Permission denied writing file")).toBe("permission");
		expect(classifyRetryBucket("Cannot find module x")).toBe("dependency_import");
		expect(classifyRetryBucket("Test failed: expect(true).toBe(false)")).toBe("test");
		expect(classifyRetryBucket("Operation timed out after 30s")).toBe("timeout");

		const retryAllowed = shouldRetry({ errorMessage: "Test failed", currentRetries: 1 });
		expect(retryAllowed.retry).toBe(true);
		const retryDenied = shouldRetry({ errorMessage: "Permission denied", currentRetries: 1 });
		expect(retryDenied.retry).toBe(false);
	});

	it("persists state/event/report artifacts", () => {
		const runId = "swarm_test_run";
		const store = new SwarmStateStore(tempDir, runId);
		const plan: SwarmPlan = {
			source: "plain",
			request: "test swarm",
			notes: [],
			tasks: [
				{
					id: "task_1",
					brief: "do work",
					depends_on: [],
					scopes: ["src/**"],
					touches: ["src/a.ts"],
					concurrency_class: "implementation",
					severity: "medium",
					needs_user_input: false,
					spawn_policy: "allow",
				},
			],
		};
		const meta: SwarmRunMeta = {
			runId,
			createdAt: new Date().toISOString(),
			source: "plain",
			request: "test swarm",
			contract: {},
			contractHash: "hash",
			repoScaleMode: "small",
			semanticStatus: "optional_for_small_repo",
			maxParallel: 1,
		};
		const state: SwarmRuntimeState = {
			runId,
			status: "running",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			tick: 0,
			noProgressTicks: 0,
			readyQueue: ["task_1"],
			blockedTasks: [],
			tasks: {
				task_1: {
					id: "task_1",
					status: "ready",
					attempts: 0,
					depends_on: [],
					touches: ["src/a.ts"],
					scopes: ["src/**"],
				},
			},
			locks: {},
			retries: {},
			budget: {
				spentUsd: 0,
				warned80: false,
				hardStopped: false,
			},
		};

		store.init(meta, plan, state);
		store.appendEvent({
			type: "run_started",
			timestamp: new Date().toISOString(),
			runId,
			message: "started",
		});
		store.writeReports({
			integrationReport: "# report",
			gates: { pass: true },
			sharedContext: "# context",
		});

		expect(store.loadMeta()?.runId).toBe(runId);
		expect(store.loadPlan()?.tasks).toHaveLength(1);
		expect(store.loadState()?.status).toBe("running");
		expect(existsSync(join(tempDir, ".iosm", "orchestrate", runId, "events.jsonl"))).toBe(true);
		expect(readFileSync(join(tempDir, ".iosm", "orchestrate", runId, "reports", "integration_report.md"), "utf8")).toContain("# report");
	});
});
