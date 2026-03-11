import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

describe("createAgentSession default model restore", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-sdk-model-restore-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("hydrates missing saved provider model from models.dev and restores it", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				new Response(
					JSON.stringify({
						"zai-coding-plan": {
							id: "zai-coding-plan",
							name: "Z.AI Coding Plan",
							env: ["ZHIPU_API_KEY"],
							api: "https://api.z.ai/api/coding/paas/v4",
							npm: "@ai-sdk/openai-compatible",
							models: {
								"glm-5": {
									id: "glm-5",
									name: "GLM-5",
									reasoning: true,
									modalities: { input: ["text"] },
									cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
									limit: { context: 128000, output: 8192 },
								},
							},
						},
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
			),
		);

		const authStorage = AuthStorage.inMemory();
		authStorage.set("zai-coding-plan", { type: "api_key", key: "z-key-123" });
		const modelRegistry = new ModelRegistry(authStorage, undefined);
		const settingsManager = SettingsManager.inMemory({
			defaultProvider: "zai-coding-plan",
			defaultModel: "glm-5",
		});

		const { session, modelFallbackMessage } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			settingsManager,
			authStorage,
			modelRegistry,
		});

		expect(session.model?.provider).toBe("zai-coding-plan");
		expect(session.model?.id).toBe("glm-5");
		expect(modelFallbackMessage).toBeUndefined();
	});
});
