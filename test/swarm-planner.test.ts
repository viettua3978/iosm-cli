import { describe, expect, it } from "vitest";
import type { ProjectIndex } from "../src/core/project-index/types.js";
import { buildSwarmPlanFromSingular, buildSwarmPlanFromTask } from "../src/core/swarm/planner.js";

function buildIndex(paths: string[]): ProjectIndex {
	const nowIso = new Date().toISOString();
	const nowMs = Date.now();
	return {
		meta: {
			version: 1,
			cwd: "/tmp/test-repo",
			builtAt: nowIso,
			updatedAt: nowIso,
			totalFiles: paths.length,
			sourceFiles: paths.filter((path) => !/test|spec/i.test(path)).length,
			testFiles: paths.filter((path) => /test|spec/i.test(path)).length,
			repoScaleMode: "small",
		},
		entries: paths.map((path, index) => ({
			path,
			size: 100 + index,
			mtimeMs: nowMs,
			ownerZone: path.split("/").slice(0, 2).join("/"),
			imports: [],
			symbols: [],
			changeFreq: 1,
		})),
	};
}

describe("swarm planner", () => {
	it("builds parallel workstreams for complex plain-language tasks", () => {
		const index = buildIndex([
			"src/security/auth.ts",
			"src/security/rbac.ts",
			"src/security/middleware.ts",
			"src/storage/database.ts",
			"src/storage/schema.ts",
			"src/gateway/routes.ts",
			"src/gateway/app.ts",
			"src/planning/judge.ts",
			"src/planning/compass.ts",
			"test/security/auth.test.ts",
		]);

		const plan = buildSwarmPlanFromTask({
			request: "Audit security and improve auth, storage, and gateway reliability",
			contract: {
				quality_gates: ["tests pass"],
				definition_of_done: ["report prepared"],
			},
			index,
		});

		const analysisTask = plan.tasks[0]!;
		expect(analysisTask.depends_on).toEqual([]);

		const workstreamTasks = plan.tasks.filter((task) => /workstream \d+\//i.test(task.brief));
		expect(workstreamTasks.length).toBeGreaterThanOrEqual(2);
		for (const task of workstreamTasks) {
			expect(task.depends_on).toEqual([]);
		}

		const verificationTask = plan.tasks.find((task) => task.brief.startsWith("Verify behavior and quality gates for:"));
		expect(verificationTask).toBeTruthy();
		expect((verificationTask?.depends_on ?? []).slice().sort()).toEqual(
			[analysisTask.id, ...workstreamTasks.map((task) => task.id)].sort(),
		);

		const finalizeTask = plan.tasks.find((task) => task.brief === "Finalize integration report and contract gate checklist.");
		expect(finalizeTask).toBeTruthy();
		expect(finalizeTask?.depends_on).toEqual([verificationTask!.id]);
	});

	it("keeps simple requests compact while preserving verification flow", () => {
		const index = buildIndex(["src/main.ts", "src/lib/helpers.ts", "test/main.test.ts"]);
		const plan = buildSwarmPlanFromTask({
			request: "Fix typo",
			contract: {},
			index,
		});

		const workstreamTasks = plan.tasks.filter((task) => /workstream \d+\//i.test(task.brief));
		expect(workstreamTasks.length).toBe(1);
		const analysisTask = plan.tasks[0]!;
		const verificationTask = plan.tasks.find((task) => task.brief.startsWith("Verify behavior and quality gates for:"));
		expect((verificationTask?.depends_on ?? []).slice().sort()).toEqual([analysisTask.id, workstreamTasks[0]!.id].sort());
	});

	it("builds parallel middle workstreams for singular options with multiple plan steps", () => {
		const index = buildIndex([
			"src/security/auth.ts",
			"src/security/rbac.ts",
			"src/storage/database.ts",
			"src/gateway/routes.ts",
			"test/security/auth.test.ts",
		]);
		const plan = buildSwarmPlanFromSingular({
			analysis: {
				runId: "singular_run_1",
				request: "Harden auth and gateway reliability",
				generatedAt: new Date().toISOString(),
				scannedFiles: 10,
				sourceFiles: 8,
				testFiles: 2,
				matchedFiles: [],
				baselineComplexity: "high",
				baselineBlastRadius: "medium",
				recommendation: "implement_incrementally",
				recommendationReason: "parallelizable streams",
				contractSignals: [],
				options: [],
			},
			option: {
				id: "1",
				title: "Parallel hardening",
				summary: "Split auth, gateway, and verification",
				complexity: "high",
				blast_radius: "medium",
				suggested_files: ["src/security/auth.ts", "src/gateway/routes.ts"],
				plan: [
					"Prepare baseline and interfaces",
					"Harden auth flow and token checks",
					"Harden gateway input validation and middleware",
					"Run verification and integration checks",
				],
				pros: [],
				cons: [],
			},
			contract: {},
			index,
		});

		expect(plan.tasks.length).toBeGreaterThanOrEqual(5);
		expect(plan.tasks[0]?.depends_on).toEqual([]);
		expect(plan.tasks[1]?.depends_on).toEqual([plan.tasks[0]!.id]);
		expect(plan.tasks[2]?.depends_on).toEqual([plan.tasks[0]!.id]);
		expect(plan.tasks[3]?.depends_on.slice().sort()).toEqual([plan.tasks[1]!.id, plan.tasks[2]!.id].sort());
	});

	it("expands two-step singular options into parallel implementation slices", () => {
		const index = buildIndex([
			"src/auth/token.ts",
			"src/auth/session.ts",
			"src/auth/rbac.ts",
			"src/gateway/routes.ts",
			"src/gateway/app.ts",
			"src/storage/database.ts",
			"src/storage/schema.ts",
			"src/planning/judge.ts",
			"src/planning/compass.ts",
			"test/auth/token.test.ts",
			"test/gateway/routes.test.ts",
		]);
		const plan = buildSwarmPlanFromSingular({
			analysis: {
				runId: "singular_run_2",
				request: "Harden auth and gateway paths with rollout safety",
				generatedAt: new Date().toISOString(),
				scannedFiles: 20,
				sourceFiles: 16,
				testFiles: 4,
				matchedFiles: [],
				baselineComplexity: "high",
				baselineBlastRadius: "medium",
				recommendation: "implement_incrementally",
				recommendationReason: "parallelizable slices",
				contractSignals: [],
				options: [],
			},
			option: {
				id: "1",
				title: "Two-step hardened rollout",
				summary: "Prepare then execute hardened rollout",
				complexity: "high",
				blast_radius: "medium",
				suggested_files: [
					"src/auth/token.ts",
					"src/auth/session.ts",
					"src/gateway/routes.ts",
					"src/storage/database.ts",
				],
				plan: ["Prepare boundaries and safeguards", "Execute hardened rollout and verification"],
				pros: [],
				cons: [],
			},
			contract: {},
			index,
		});

		const streamTasks = plan.tasks.filter((task) => /^Implementation slice \d+\//.test(task.brief));
		expect(streamTasks.length).toBeGreaterThanOrEqual(2);
		const finalFromOption = plan.tasks.find((task) => task.brief === "Execute hardened rollout and verification");
		expect(finalFromOption).toBeTruthy();
		expect((finalFromOption?.depends_on ?? []).slice().sort()).toEqual(streamTasks.map((task) => task.id).sort());
	});
});
