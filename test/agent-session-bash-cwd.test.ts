import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

describe("AgentSession executeBash cwd", () => {
	let rootDir: string;
	let workspaceDir: string;
	let session: AgentSession;

	beforeEach(() => {
		rootDir = join(tmpdir(), `pi-bash-cwd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		workspaceDir = join(rootDir, "workspace");
		mkdirSync(workspaceDir, { recursive: true });
	});

	afterEach(() => {
		session?.dispose();
		if (rootDir && existsSync(rootDir)) {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	it("runs manual bash commands inside the session cwd", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(workspaceDir, rootDir);
		const authStorage = AuthStorage.create(join(rootDir, "auth.json"));
		const modelRegistry = new ModelRegistry(authStorage, rootDir);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: workspaceDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		const result = await session.executeBash("pwd");
		expect(realpathSync(result.output.trim())).toBe(realpathSync(workspaceDir));
	});
});
