import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyPostToolUseHooks,
	applyPreToolUseHooks,
	applyStopHooks,
	applyUserPromptSubmitHooks,
	emptyHooksConfig,
	loadHooksConfig,
	type LoadedHooksConfig,
	type HookRule,
} from "../src/core/hooks.js";

function pushRule(config: LoadedHooksConfig, bucket: keyof LoadedHooksConfig, rule: HookRule): void {
	const target = config[bucket];
	if (Array.isArray(target)) {
		target.push(rule);
	}
}

describe("hooks", () => {
	let tempDir: string;
	let homeDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `hooks-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		homeDir = join(tempDir, "home");
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "workspace", "apps", "demo");
		mkdirSync(homeDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("loads hierarchical hooks and allows closer scope to override broader scope", () => {
		const homeHooksDir = join(homeDir, ".iosm");
		const workspaceHooksDir = join(tempDir, "workspace", ".iosm");
		mkdirSync(homeHooksDir, { recursive: true });
		mkdirSync(workspaceHooksDir, { recursive: true });

		writeFileSync(
			join(homeHooksDir, "hooks.json"),
			JSON.stringify({
				UserPromptSubmit: [
					{
						id: "home-block",
						action: "block",
						match: "secret",
						message: "blocked by home",
					},
				],
			}),
		);

		writeFileSync(
			join(workspaceHooksDir, "hooks.json"),
			JSON.stringify({
				UserPromptSubmit: [
					{
						id: "workspace-allow",
						action: "allow",
						match: "secret",
					},
				],
			}),
		);

		const loaded = loadHooksConfig({ cwd, agentDir, homeDir });
		const result = applyUserPromptSubmitHooks(loaded, "show secret config");

		expect(result.blocked).toBe(false);
		expect(result.text).toBe("show secret config");
		expect(loaded.sources).toContain(join(homeHooksDir, "hooks.json"));
		expect(loaded.sources).toContain(join(workspaceHooksDir, "hooks.json"));
	});

	it("adds prompt append snippets and warning notices", () => {
		const config = emptyHooksConfig();
		pushRule(config, "userPromptSubmit", {
			id: "warn-deploy",
			event: "UserPromptSubmit",
			action: "warn",
			match: "deploy",
			caseSensitive: false,
			message: "double-check deployment target",
			sourcePath: "/tmp/hooks.json",
		});
		pushRule(config, "userPromptSubmit", {
			id: "append-checklist",
			event: "UserPromptSubmit",
			action: "append",
			match: "deploy",
			caseSensitive: false,
			append: "Confirm rollback plan and owner before applying changes.",
			sourcePath: "/tmp/hooks.json",
		});

		const result = applyUserPromptSubmitHooks(config, "deploy release");

		expect(result.blocked).toBe(false);
		expect(result.notices).toContain("[warn-deploy] double-check deployment target");
		expect(result.text).toContain("deploy release");
		expect(result.text).toContain("Confirm rollback plan and owner before applying changes.");
	});

	it("can block a tool via PreToolUse", () => {
		const config = emptyHooksConfig();
		pushRule(config, "preToolUse", {
			id: "deny-rm",
			event: "PreToolUse",
			action: "block",
			toolNames: ["bash"],
			match: "rm -rf",
			caseSensitive: false,
			message: "dangerous delete blocked",
			sourcePath: "/tmp/hooks.json",
		});

		const result = applyPreToolUseHooks(config, {
			toolName: "bash",
			cwd: "/tmp/project",
			input: { command: "rm -rf /tmp/project" },
			summary: "run rm -rf /tmp/project",
		});

		expect(result.allowed).toBe(false);
		expect(result.message).toContain("[deny-rm] dangerous delete blocked");
	});

	it("returns notices for PostToolUse and Stop hooks", () => {
		const config = emptyHooksConfig();
		pushRule(config, "postToolUse", {
			id: "write-error",
			event: "PostToolUse",
			action: "warn",
			toolNames: ["write"],
			match: "error:true",
			caseSensitive: false,
			message: "write produced an error",
			sourcePath: "/tmp/hooks.json",
		});
		pushRule(config, "stop", {
			id: "stop-any",
			event: "Stop",
			action: "warn",
			match: "abort",
			caseSensitive: false,
			message: "session stop observed",
			sourcePath: "/tmp/hooks.json",
		});

		const postNotices = applyPostToolUseHooks(config, {
			toolName: "write",
			outputText: "failed",
			isError: true,
		});
		const stopNotices = applyStopHooks(config, "abort");

		expect(postNotices).toContain("[write-error] write produced an error");
		expect(stopNotices).toContain("[stop-any] session stop observed");
	});

	it("reports diagnostics for invalid regex rules", () => {
		const hooksDir = join(cwd, ".iosm");
		mkdirSync(hooksDir, { recursive: true });
		writeFileSync(
			join(hooksDir, "hooks.json"),
			JSON.stringify({
				PreToolUse: [{ id: "bad-regex", action: "block", regex: "[" }],
			}),
		);

		const loaded = loadHooksConfig({ cwd, agentDir, homeDir });
		expect(loaded.diagnostics.length).toBeGreaterThan(0);
		expect(loaded.diagnostics.some((d) => d.message.includes("invalid regex"))).toBe(true);
	});
});
