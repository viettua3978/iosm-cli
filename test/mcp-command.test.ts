import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { main } from "../src/main.js";

describe("mcp command", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	let originalCwd: string;
	let originalAgentDir: string | undefined;
	let originalExitCode: typeof process.exitCode;

	beforeEach(() => {
		tempDir = join(tmpdir(), `iosm-mcp-command-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

	it("adds and lists a project MCP server", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await main([
				"mcp",
				"add",
				"filesystem",
				"--scope",
				"project",
				"--transport",
				"stdio",
				"--command",
				"node",
				"--arg",
				"-e",
				"--arg",
				"process.exit(0)",
				"--disable",
			]);

			const mcpConfigPath = join(projectDir, ".mcp.json");
			expect(existsSync(mcpConfigPath)).toBe(true);
			const config = JSON.parse(readFileSync(mcpConfigPath, "utf-8")) as {
				mcpServers?: Record<string, { command?: string; enabled?: boolean }>;
			};
			expect(config.mcpServers?.filesystem?.command).toBe("node");
			expect(config.mcpServers?.filesystem?.enabled).toBe(false);

			await main(["mcp", "list"]);
			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("filesystem");
			expect(errSpy).not.toHaveBeenCalled();
		} finally {
			logSpy.mockRestore();
			errSpy.mockRestore();
		}
	});

	it("removes MCP server from project config", async () => {
		await main([
			"mcp",
			"add",
			"filesystem",
			"--scope",
			"project",
			"--transport",
			"stdio",
			"--command",
			"node",
			"--arg",
			"-e",
			"--arg",
			"process.exit(0)",
			"--disable",
		]);

		await main(["mcp", "remove", "filesystem", "--scope", "project"]);

		const config = JSON.parse(readFileSync(join(projectDir, ".mcp.json"), "utf-8")) as {
			mcpServers?: Record<string, unknown>;
		};
		expect(config.mcpServers?.filesystem).toBeUndefined();
	});
});
