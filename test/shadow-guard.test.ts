import { describe, expect, it, vi } from "vitest";
import { ShadowGuard } from "../src/core/shadow-guard.js";

describe("shadow guard", () => {
	it("enables strict read-only mode and restores tools on disable", () => {
		let activeTools = ["read", "bash", "edit", "write", "task"];
		const setActiveTools = vi.fn((next: string[]) => {
			activeTools = [...next];
		});

		const guard = new ShadowGuard({
			getActiveTools: () => [...activeTools],
			getAllTools: () => ["read", "grep", "find", "ls", "bash", "edit", "write", "task"],
			setActiveTools,
		});

		guard.enable();
		expect(setActiveTools).toHaveBeenCalled();
		expect(activeTools).toEqual(["read", "grep", "find", "ls"]);
		expect(guard.shouldDenyTool("edit")).toBe(true);
		expect(guard.shouldDenyTool("read")).toBe(false);

		guard.disable();
		expect(activeTools).toEqual(["read", "bash", "edit", "write", "task"]);
		expect(guard.isEnabled()).toBe(false);
	});

	it("tracks restore tools while shadow mode remains enabled", () => {
		let activeTools = ["read", "bash"];
		const guard = new ShadowGuard({
			getActiveTools: () => [...activeTools],
			getAllTools: () => ["read", "grep", "bash", "edit", "write", "task"],
			setActiveTools: (next) => {
				activeTools = [...next];
			},
		});

		guard.enable();
		guard.setRestoreToolNames(["read", "task", "todo_read"]);
		guard.disable();
		expect(activeTools).toEqual(["read", "task", "todo_read"]);
	});

	it("treats git_write/fs_ops/test/lint/typecheck/db tools as mutating when shadow mode is enabled", () => {
		let activeTools = ["read", "git_write", "fs_ops", "test_run", "lint_run", "typecheck_run", "db_run", "bash"];
		const guard = new ShadowGuard({
			getActiveTools: () => [...activeTools],
			getAllTools: () => [
				"read",
				"fetch",
				"web_search",
				"git_read",
				"git_write",
				"fs_ops",
				"test_run",
				"lint_run",
				"typecheck_run",
				"db_run",
				"bash",
				"edit",
				"write",
				"task",
			],
			setActiveTools: (next) => {
				activeTools = [...next];
			},
		});

		guard.enable();
		expect(guard.shouldDenyTool("git_write")).toBe(true);
		expect(guard.shouldDenyTool("fs_ops")).toBe(true);
		expect(guard.shouldDenyTool("test_run")).toBe(true);
		expect(guard.shouldDenyTool("lint_run")).toBe(true);
		expect(guard.shouldDenyTool("typecheck_run")).toBe(true);
		expect(guard.shouldDenyTool("db_run")).toBe(true);
		expect(activeTools).toContain("fetch");
		expect(activeTools).toContain("web_search");
		expect(activeTools).toContain("git_read");
		expect(activeTools).not.toContain("git_write");
		expect(activeTools).not.toContain("fs_ops");
		expect(activeTools).not.toContain("test_run");
		expect(activeTools).not.toContain("lint_run");
		expect(activeTools).not.toContain("typecheck_run");
		expect(activeTools).not.toContain("db_run");
	});
});
