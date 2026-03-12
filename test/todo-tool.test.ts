import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { afterEach, describe, expect, it } from "vitest";
import { createTodoReadTool, createTodoWriteTool } from "../src/core/tools/todo.js";

describe("todo tools", () => {
	const tempDirs: string[] = [];

	const makeTempDir = (): string => {
		const dir = mkdtempSync(join(tmpdir(), "iosm-todo-tool-"));
		tempDirs.push(dir);
		return dir;
	};

	afterEach(() => {
		for (const dir of tempDirs.splice(0, tempDirs.length)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("accepts markdown checklist strings and normalizes them into tasks", async () => {
		const cwd = makeTempDir();
		const tool = createTodoWriteTool(cwd);
		const validate = TypeCompiler.Compile(tool.parameters);

		const payload = {
			tasks: "- [in_progress] Preliminary security reconnaissance\n- [pending] Run static analysis (semgrep)",
		};

		expect(validate.Check(payload)).toBe(true);

		const result = await tool.execute("call_markdown_todo", payload);
		expect((result.content[0] as { type: "text"; text: string }).text).toContain("Task list updated");
		expect(result.details?.tasks).toMatchObject([
			{
				id: "preliminary-security-reconnaissance",
				subject: "Preliminary security reconnaissance",
				status: "in_progress",
			},
			{
				id: "run-static-analysis-semgrep",
				subject: "Run static analysis (semgrep)",
				status: "pending",
			},
		]);
	});

	it("accepts sparse task objects without id or subject and derives them", async () => {
		const cwd = makeTempDir();
		const tool = createTodoWriteTool(cwd);
		const validate = TypeCompiler.Compile(tool.parameters);

		const payload = {
			tasks: [
				{
					description: "Static Analysis (Semgrep & Bandit)",
					status: "pending",
				},
			],
		};

		expect(validate.Check(payload)).toBe(true);

		const result = await tool.execute("call_sparse_todo", payload);
		expect(result.details?.tasks).toMatchObject([
			{
				id: "static-analysis-semgrep-bandit",
				subject: "Static Analysis (Semgrep & Bandit)",
				description: "Static Analysis (Semgrep & Bandit)",
				status: "pending",
			},
		]);
	});

	it("treats empty todo_write payloads as no-op instead of validation failures", async () => {
		const cwd = makeTempDir();
		const writeTool = createTodoWriteTool(cwd);
		const readTool = createTodoReadTool(cwd);
		const validate = TypeCompiler.Compile(writeTool.parameters);

		expect(validate.Check({})).toBe(true);

		await writeTool.execute("call_seed_todo", {
			tasks: [{ id: "seed", subject: "Seed task", status: "pending" }],
		});
		const result = await writeTool.execute("call_empty_todo", {});
		const readback = await readTool.execute("call_read_todo", {});

		expect((result.content[0] as { type: "text"; text: string }).text).toContain("No task updates provided");
		expect((readback.content[0] as { type: "text"; text: string }).text).toContain("[seed] Seed task");
	});
});
