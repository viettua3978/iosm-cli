import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTeamRun, getTeamRun, updateTeamTaskStatus } from "../src/core/agent-teams.js";
import { createTaskTool } from "../src/core/tools/task.js";

describe("subagent orchestration", () => {
	const tempDirs: string[] = [];

	const makeTempDir = (): string => {
		const dir = mkdtempSync(join(tmpdir(), "iosm-subagent-orch-"));
		tempDirs.push(dir);
		return dir;
	};

	afterEach(() => {
		for (const dir of tempDirs.splice(0, tempDirs.length)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("updates team task status lifecycle on disk", () => {
		const cwd = makeTempDir();
		const run = createTeamRun({
			cwd,
			mode: "parallel",
			agents: 2,
			task: "test orchestration",
			assignments: [
				{ profile: "full", cwd, dependsOn: [] },
				{ profile: "explore", cwd, dependsOn: [1] },
			],
		});

		expect(run.tasks[0]?.status).toBe("pending");
		expect(run.tasks[1]?.status).toBe("pending");

		updateTeamTaskStatus({ cwd, runId: run.runId, taskId: "task_1", status: "running" });
		updateTeamTaskStatus({ cwd, runId: run.runId, taskId: "task_1", status: "done" });

		const loaded = getTeamRun(cwd, run.runId);
		expect(loaded?.tasks.find((task) => task.id === "task_1")?.status).toBe("done");
		expect(loaded?.tasks.find((task) => task.id === "task_2")?.status).toBe("pending");
	});

	it("task tool writes done/error status to team runs when run_id/task_id are provided", async () => {
		const cwd = makeTempDir();
		const runOk = createTeamRun({
			cwd,
			mode: "sequential",
			agents: 1,
			task: "ok task",
			assignments: [{ profile: "full", cwd, dependsOn: [] }],
		});

		const toolOk = createTaskTool(
			cwd,
			async () => ({
				output: "completed",
				sessionId: "session_ok",
			}),
			{},
		);
		await toolOk.execute("call_ok", {
			description: "ok task",
			prompt: "do something",
			profile: "full",
			run_id: runOk.runId,
			task_id: "task_1",
		});
		expect(getTeamRun(cwd, runOk.runId)?.tasks[0]?.status).toBe("done");

		const runErr = createTeamRun({
			cwd,
			mode: "sequential",
			agents: 1,
			task: "failing task",
			assignments: [{ profile: "full", cwd, dependsOn: [] }],
		});
		const toolErr = createTaskTool(cwd, async () => {
			throw new Error("boom");
		});

		await expect(
			toolErr.execute("call_err", {
				description: "failing task",
				prompt: "fail intentionally",
				profile: "full",
				run_id: runErr.runId,
				task_id: "task_1",
			}),
		).rejects.toThrow(/Subagent failed/);
		expect(getTeamRun(cwd, runErr.runId)?.tasks[0]?.status).toBe("error");
	});

	it("forwards model override to runner and supports background custom subagents", async () => {
		const cwd = makeTempDir();
		const observed: Array<{ modelOverride?: string; prompt: string }> = [];
		const tool = createTaskTool(
			cwd,
			async (options) => {
				observed.push({ modelOverride: options.modelOverride, prompt: options.prompt });
				return { output: "ok", sessionId: "session_model" };
			},
			{
				resolveCustomSubagent: (name) =>
					name === "bg_reader"
						? {
								name: "bg_reader",
								description: "background reader",
								sourcePath: "fixture",
								profile: "explore",
								instructions: "Background read instructions",
								model: "anthropic/claude-sonnet-4",
								background: true,
							}
						: undefined,
				availableCustomSubagents: ["bg_reader"],
			},
		);

		const started = await tool.execute("call_bg", {
			description: "background job",
			prompt: "scan docs",
			profile: "explore",
			agent: "bg_reader",
		});
		const text = (started.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("Started background subagent run");
		expect(started.details?.background).toBe(true);

		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(observed[0]?.modelOverride).toBe("anthropic/claude-sonnet-4");
		expect(observed[0]?.prompt).toContain("Background read instructions");
		expect(observed[0]?.prompt).toContain("User task:\nscan docs");
	});

	it("honors maxParallel from orchestration run metadata", async () => {
		const cwd = makeTempDir();

		let active = 0;
		let maxActive = 0;
		const runner = async () => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolve) => setTimeout(resolve, 25));
			active -= 1;
			return { output: "ok" };
		};
		const tool = createTaskTool(cwd, runner);

		const runLimited = createTeamRun({
			cwd,
			mode: "parallel",
			agents: 2,
			maxParallel: 1,
			task: "limited run",
			assignments: [
				{ profile: "explore", cwd, dependsOn: [] },
				{ profile: "explore", cwd, dependsOn: [] },
			],
		});
		await Promise.all([
			tool.execute("limited_1", {
				description: "limited 1",
				prompt: "a",
				profile: "explore",
				run_id: runLimited.runId,
				task_id: "task_1",
			}),
			tool.execute("limited_2", {
				description: "limited 2",
				prompt: "b",
				profile: "explore",
				run_id: runLimited.runId,
				task_id: "task_2",
			}),
		]);
		expect(maxActive).toBe(1);

		active = 0;
		maxActive = 0;
		const runOpen = createTeamRun({
			cwd,
			mode: "parallel",
			agents: 2,
			maxParallel: 2,
			task: "open run",
			assignments: [
				{ profile: "explore", cwd, dependsOn: [] },
				{ profile: "explore", cwd, dependsOn: [] },
			],
		});
		await Promise.all([
			tool.execute("open_1", {
				description: "open 1",
				prompt: "a",
				profile: "explore",
				run_id: runOpen.runId,
				task_id: "task_1",
			}),
			tool.execute("open_2", {
				description: "open 2",
				prompt: "b",
				profile: "explore",
				run_id: runOpen.runId,
				task_id: "task_2",
			}),
		]);
		expect(maxActive).toBe(2);
	});

	it("forces foreground execution for tracked orchestration tasks", async () => {
		const cwd = makeTempDir();
		const run = createTeamRun({
			cwd,
			mode: "parallel",
			agents: 1,
			task: "foreground enforcement",
			assignments: [{ profile: "explore", cwd, dependsOn: [] }],
		});
		const tool = createTaskTool(cwd, async () => ({ output: "foreground output" }));

		const result = await tool.execute("call_fg", {
			description: "tracked task",
			prompt: "run tracked",
			profile: "explore",
			run_id: run.runId,
			task_id: "task_1",
			background: true,
		});

		expect((result.content[0] as { type: "text"; text: string }).text).toBe("foreground output");
		expect(result.details?.background).toBe(false);
	});

	it("runs write-capable tasks in parallel when no lock_key is provided", async () => {
		const cwd = makeTempDir();
		let active = 0;
		let maxActive = 0;
		const tool = createTaskTool(cwd, async () => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolve) => setTimeout(resolve, 25));
			active -= 1;
			return { output: "ok" };
		});

		await Promise.all([
			tool.execute("call_full_1", {
				description: "full agent one",
				prompt: "analyze",
				profile: "full",
			}),
			tool.execute("call_full_2", {
				description: "full agent two",
				prompt: "analyze",
				profile: "full",
			}),
		]);

		expect(maxActive).toBe(2);
	});

	it("executes delegated subtasks emitted by subagent output", async () => {
		const cwd = makeTempDir();
		const prompts: string[] = [];
		const tool = createTaskTool(cwd, async (options) => {
			prompts.push(options.prompt);
			if (options.prompt === "root-task") {
				return {
					output:
						'Root analysis complete.\n<delegate_task profile="explore" description="Patch vuln">apply fix</delegate_task>',
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			if (options.prompt === "apply fix") {
				return {
					output: "Fix applied.",
					stats: { toolCallsStarted: 2, toolCallsCompleted: 2, assistantMessages: 1 },
				};
			}
			return { output: "unexpected" };
		});

		const result = await tool.execute("call_delegate", {
			description: "delegate flow",
			prompt: "root-task",
			profile: "full",
		});

		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(prompts).toEqual(["root-task", "apply fix"]);
		expect(text).toContain("Root analysis complete.");
		expect(text).toContain("### Delegated Subtasks");
		expect(text).toContain("Fix applied.");
		expect(result.details?.delegatedTasks).toBe(1);
		expect(result.details?.delegatedSucceeded).toBe(1);
		expect(result.details?.delegatedFailed).toBe(0);
		expect(result.details?.toolCallsStarted).toBe(3);
		expect(result.details?.toolCallsCompleted).toBe(3);
	});

	it("emits delegate mini-list progress updates", async () => {
		const cwd = makeTempDir();
		const tool = createTaskTool(cwd, async (options) => {
			if (options.prompt === "root-task") {
				return {
					output:
						'Root analysis complete.\n<delegate_task profile="explore" description="Patch vuln">child-one</delegate_task>\n<delegate_task profile="plan" description="Audit UX">child-two</delegate_task>',
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			if (options.prompt === "child-one") {
				return {
					output: "Child one done.",
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			if (options.prompt === "child-two") {
				return {
					output: "Child two done.",
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			return { output: "unexpected" };
		});

		const progressSnapshots: Array<Record<string, unknown>> = [];
		await tool.execute(
			"call_delegate_progress",
			{
				description: "delegate progress",
				prompt: "root-task",
				profile: "full",
			},
			undefined,
			(update) => {
				const progress = update.details?.progress as Record<string, unknown> | undefined;
				if (progress) {
					progressSnapshots.push(progress);
				}
			},
		);

		const hasRunningList = progressSnapshots.some((progress) => {
			const items = progress.delegateItems as Array<{ status?: string }> | undefined;
			return Array.isArray(items) && items.length === 2 && items.some((item) => item.status === "running");
		});
		const hasDoneList = progressSnapshots.some((progress) => {
			const items = progress.delegateItems as Array<{ status?: string }> | undefined;
			return Array.isArray(items) && items.length === 2 && items.every((item) => item.status === "done");
		});

		expect(hasRunningList).toBe(true);
		expect(hasDoneList).toBe(true);
	});

	it("runs independent delegated subtasks in parallel", async () => {
		const cwd = makeTempDir();
		let active = 0;
		let maxActive = 0;

		const tool = createTaskTool(cwd, async (options) => {
			if (options.prompt === "root-task") {
				return {
					output:
						'Root analysis.\n<delegate_task profile="explore" description="A">child-one</delegate_task>\n<delegate_task profile="plan" description="B">child-two</delegate_task>',
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			if (options.prompt === "child-one" || options.prompt === "child-two") {
				active += 1;
				maxActive = Math.max(maxActive, active);
				await new Promise((resolve) => setTimeout(resolve, 25));
				active -= 1;
				return {
					output: `${options.prompt} done`,
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			return { output: "unexpected" };
		});

		await tool.execute("call_delegate_parallel", {
			description: "delegate parallel",
			prompt: "root-task",
			profile: "full",
		});

		expect(maxActive).toBe(2);
	});

	it("honors depends_on ordering for delegated subtasks", async () => {
		const cwd = makeTempDir();
		let firstCompleted = false;
		let secondStartedBeforeFirstDone = false;

		const tool = createTaskTool(cwd, async (options) => {
			if (options.prompt === "root-task") {
				return {
					output:
						'Root analysis.\n<delegate_task profile="explore" description="First">child-one</delegate_task>\n<delegate_task profile="plan" description="Second" depends_on="1">child-two</delegate_task>',
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			if (options.prompt === "child-one") {
				await new Promise((resolve) => setTimeout(resolve, 20));
				firstCompleted = true;
				return {
					output: "child-one done",
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			if (options.prompt === "child-two") {
				if (!firstCompleted) {
					secondStartedBeforeFirstDone = true;
				}
				return {
					output: "child-two done",
					stats: { toolCallsStarted: 1, toolCallsCompleted: 1, assistantMessages: 1 },
				};
			}
			return { output: "unexpected" };
		});

		await tool.execute("call_delegate_depends", {
			description: "delegate depends_on",
			prompt: "root-task",
			profile: "full",
		});

		expect(secondStartedBeforeFirstDone).toBe(false);
	});

	it("rejects write-capable background policy", async () => {
		const cwd = makeTempDir();
		const tool = createTaskTool(cwd, async () => ({ output: "ok" }), {
			resolveCustomSubagent: (name) =>
				name === "bg_writer"
					? {
							name: "bg_writer",
							description: "background writer",
							sourcePath: "fixture",
							profile: "full",
							instructions: "Do work",
							background: true,
						}
					: undefined,
		});

		await expect(
			tool.execute("call_bg_policy", {
				description: "policy check",
				prompt: "write files",
				profile: "full",
				agent: "bg_writer",
			}),
		).rejects.toThrow(/Background policy violation/);
	});
});
