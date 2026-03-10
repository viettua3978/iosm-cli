import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@mariozechner/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel, type Message } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
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

describe("AgentSession IOSM autopilot", () => {
	let tempDir: string;
	let session: AgentSession;
	let capturedMessages: Message[] = [];

	beforeEach(() => {
		tempDir = join(tmpdir(), `iosm-autopilot-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(join(tempDir, "package.json"), JSON.stringify({ name: "autopilot-fixture", private: true }), "utf8");
	});

	afterEach(() => {
		session?.dispose();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
		capturedMessages = [];
	});

	function createSession(options?: { withApiKey?: boolean }): AgentSession {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test prompt",
				tools: [],
			},
			convertToLlm,
			streamFn: async (_model, context) => {
				capturedMessages = [...context.messages];
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		if (options?.withApiKey !== false) {
			authStorage.setRuntimeApiKey("anthropic", "test-key");
		}
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

	it("injects iosm runtime context before the user message", async () => {
		createSession();

		await session.prompt("Improve auth flow");

		expect(session.messages[0]?.role).toBe("custom");
		expect(session.messages[0]).toMatchObject({ customType: "iosm-runtime", display: false });
		expect(String((session.messages[0] as { content?: unknown }).content)).toContain("[IOSM runtime context for next turn]");
		expect(String((session.messages[0] as { content?: unknown }).content)).toContain("auto_initialized_this_turn: yes");

		expect(capturedMessages).toHaveLength(2);
		expect(capturedMessages[0]?.role).toBe("user");
		expect(capturedMessages[0]?.content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "text",
					text: expect.stringContaining("[IOSM runtime context for next turn]"),
				}),
			]),
		);
		expect(capturedMessages[0]?.content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "text",
					text: expect.stringContaining("auto_initialized_this_turn: yes"),
				}),
			]),
		);
		expect(capturedMessages[1]?.role).toBe("user");
		expect(capturedMessages[1]?.content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "text",
					text: "Improve auth flow",
				}),
			]),
		);
	});

	it("skips iosm runtime injection for internal prompts when requested", async () => {
		createSession();

		await session.prompt("Verifier prompt", {
			expandPromptTemplates: false,
			skipIosmAutopilot: true,
		});

		expect(capturedMessages).toHaveLength(1);
		expect(capturedMessages[0]?.role).toBe("user");
	});

	it("does not leak iosm runtime context after a failed validation", async () => {
		createSession({ withApiKey: false });

		await expect(session.prompt("Improve auth flow")).rejects.toThrow("No API key found for anthropic");

		session.modelRegistry.authStorage.setRuntimeApiKey("anthropic", "test-key");
		await session.prompt("Improve auth flow");

		expect(capturedMessages).toHaveLength(2);
		const runtimeDirectives = capturedMessages.filter((message) =>
			message.content.some(
				(part) => part.type === "text" && part.text.includes("[IOSM runtime context for next turn]"),
			),
		);
		expect(runtimeDirectives).toHaveLength(1);
	});
});
