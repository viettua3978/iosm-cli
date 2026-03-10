import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@mariozechner/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { TASK_PLAN_CUSTOM_TYPE } from "../src/core/task-plan.js";
import { createTestResourceLoader } from "./utilities.js";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("AgentSession task-plan extraction", () => {
	let tempDir: string;
	let session: AgentSession;

	beforeEach(() => {
		tempDir = join(tmpdir(), `iosm-task-plan-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(join(tempDir, "package.json"), JSON.stringify({ name: "task-plan-fixture", private: true }), "utf8");
	});

	afterEach(() => {
		session?.dispose();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function createSession(): AgentSession {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test prompt",
				tools: [],
			},
			convertToLlm,
			streamFn: async () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage(
							[
								"Implementation started.",
								"<task_plan complexity=\"complex\">",
								"- [done] Inspect relevant files",
								"- [in_progress] Implement parser and UI hook",
								"- [pending] Add tests",
								"</task_plan>",
								"Proceeding with step 2 now.",
							].join("\n"),
						),
					});
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});
		return session;
	}

	it("stores cleaned assistant text and emits a structured task-plan message", async () => {
		createSession();

		await session.prompt("Refactor planning flow", {
			skipIosmAutopilot: true,
		});

		const assistant = session.messages.find((message) => message.role === "assistant") as AssistantMessage | undefined;
		expect(assistant).toBeDefined();
		const assistantText = assistant?.content.find((part) => part.type === "text");
		expect(assistantText?.type).toBe("text");
		expect((assistantText as { text: string }).text).not.toContain("<task_plan");

		const taskPlan = session.messages.find(
			(message) => message.role === "custom" && message.customType === TASK_PLAN_CUSTOM_TYPE,
		);
		expect(taskPlan).toBeDefined();
		expect(taskPlan).toMatchObject({
			role: "custom",
			customType: TASK_PLAN_CUSTOM_TYPE,
			display: true,
		});
		expect(String(taskPlan?.content)).toContain("Execution plan (1/3 complete)");
		expect(taskPlan?.details).toMatchObject({
			totalSteps: 3,
			completedSteps: 1,
			currentStepIndex: 1,
		});
	});
});
