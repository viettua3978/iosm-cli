import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { main } from "../src/main.js";

describe("semantic command", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	let originalCwd: string;
	let originalAgentDir: string | undefined;
	let originalExitCode: typeof process.exitCode;

	beforeEach(() => {
		tempDir = join(tmpdir(), `iosm-semantic-command-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });

		originalCwd = process.cwd();
		originalAgentDir = process.env[ENV_AGENT_DIR];
		originalExitCode = process.exitCode;
		process.exitCode = undefined;
		process.env[ENV_AGENT_DIR] = agentDir;
		process.chdir(projectDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		process.exitCode = originalExitCode;
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("prints actionable status when semantic config is missing", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await main(["semantic", "status"]);
			const output = logSpy.mock.calls.map(([line]) => String(line)).join("\n");
			expect(output).toContain("Semantic search status");
			expect(output).toContain("configured: no");
			expect(output).toContain("config_user:");
			expect(output).toContain("config_project:");
			expect(errSpy).not.toHaveBeenCalled();
		} finally {
			logSpy.mockRestore();
			errSpy.mockRestore();
		}
	});

	it("fails query without config and suggests setup", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		process.exitCode = undefined;

		try {
			await main(["semantic", "query", "auth", "token"]);
			const stderr = errSpy.mock.calls.map(([line]) => String(line)).join("\n");
			expect(stderr).toContain("Semantic search is not configured.");
			expect(stderr).toContain("/semantic setup");
			expect(process.exitCode).toBe(1);
			expect(logSpy).not.toHaveBeenCalled();
		} finally {
			logSpy.mockRestore();
			errSpy.mockRestore();
		}
	});
});
