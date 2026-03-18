import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent } from "@mariozechner/pi-ai";
import { EventStream, getModel } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { INTERNAL_UI_META_CUSTOM_TYPE, isInternalUiMetaDetails } from "../src/core/messages.js";
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

function createAssistantMessage(
	text: string,
	usageOverride?: Partial<AssistantMessage["usage"]> & {
		cost?: Partial<NonNullable<AssistantMessage["usage"]>["cost"]>;
	},
): AssistantMessage {
	const defaultUsage = {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const usage = usageOverride
		? {
				...defaultUsage,
				...usageOverride,
				cost: {
					...defaultUsage.cost,
					...(usageOverride.cost ?? {}),
				},
			}
		: defaultUsage;

	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function extractTextualMessages(messages: Array<{ role?: string; content?: unknown }>): string[] {
	const texts: string[] = [];
	for (const message of messages) {
		const content = message.content;
		if (typeof content === "string") {
			texts.push(content);
			continue;
		}
		if (Array.isArray(content)) {
			const text = content
				.filter(
					(part): part is { type: string; text?: string } =>
						typeof part === "object" && part !== null && "type" in part,
				)
				.filter((part) => part.type === "text" && typeof part.text === "string")
				.map((part) => part.text as string)
				.join("\n");
			if (text) {
				texts.push(text);
			}
		}
	}
	return texts;
}

describe("AgentSession ultrathink", () => {
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `iosm-ultrathink-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		session?.dispose();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function createSession(
		streamFn: ConstructorParameters<typeof Agent>[0]["streamFn"],
		options?: { retryEnabled?: boolean },
	): AgentSession {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test prompt",
				tools: [],
			},
			streamFn,
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		if (options?.retryEnabled === false) {
			settingsManager.applyOverrides({
				retry: {
					enabled: false,
				},
			});
		}
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
			iosmAutopilotEnabled: false,
		});

		return session;
	}

	it("runs exactly q ultrathink iterations and restores the original tool set", async () => {
		const ultrathinkPrompts: string[] = [];
		let ultrathinkCalls = 0;

		const created = createSession(async (_model, context) => {
			const hiddenDirective = [...extractTextualMessages(context.messages as Array<{ role?: string; content?: unknown }>)]
				.reverse()
				.find((text) => text.includes("[ULTRATHINK INTERNAL]"));
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				if (hiddenDirective) {
					ultrathinkPrompts.push(hiddenDirective);
					if (hiddenDirective.includes("[ULTRATHINK INTERNAL] iteration ")) {
						ultrathinkCalls += 1;
					}
					const isFinal = hiddenDirective.includes("iteration 3/3");
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage(
							[
								"### Iteration Summary",
								"- pass complete",
								isFinal ? "### Final Analysis\nI used ultrathink mode. Final recommendation." : "",
								"### Evidence Notes",
								"- [NO_NEW_EVIDENCE_OK] No additional tool checks were needed for this mock iteration.",
								"### Next Checkpoint",
								"Goal: investigate auth regression",
								"Verified Facts:",
								"- fact observed",
								"Rejected Hypotheses:",
								"- none",
								"Open Questions:",
								"- open item",
								"Next Checks:",
								"- continue analysis",
							]
								.filter((line) => line.length > 0)
								.join("\n"),
						),
					});
					return;
				}
				stream.push({
					type: "done",
					reason: "stop",
					message: createAssistantMessage("normal response"),
				});
			});
			return stream;
		});

		const originalTools = created.getActiveToolNames();
		expect(originalTools).toContain("bash");
		expect(originalTools).toContain("edit");
		expect(originalTools).toContain("write");

		await created.prompt("/ultrathink -q 3 investigate auth regression");

		expect(ultrathinkCalls).toBe(3);
		const iterationPrompts = ultrathinkPrompts.filter((text) => text.includes("[ULTRATHINK INTERNAL] iteration "));
		expect(iterationPrompts).toHaveLength(3);
		expect(iterationPrompts[0]).toContain("Phase: Recon");
		expect(iterationPrompts[1]).toContain("Phase: Verify");
		expect(iterationPrompts[2]).toContain("Phase: Synthesis");
		expect(iterationPrompts[0]).toContain("STRICT RULES");
		expect(iterationPrompts[0]).toContain("iteration 1/3");
		expect(iterationPrompts[1]).toContain("iteration 2/3");
		expect(iterationPrompts[2]).toContain("iteration 3/3");

		const uiMetaMessages = created.messages.filter(
			(message) => message.role === "custom" && message.customType === INTERNAL_UI_META_CUSTOM_TYPE,
		);
		const ultrathinkAliases = uiMetaMessages
			.map((message) => (isInternalUiMetaDetails(message.details) ? message.details : undefined))
			.filter((details): details is NonNullable<typeof details> => details !== undefined)
			.filter((details) => details.kind === "orchestration_context")
			.filter((details) => (details.rawPrompt ?? "").includes("[ULTRATHINK INTERNAL] iteration "))
			.map((details) => ({ rawPrompt: details.rawPrompt, displayText: details.displayText }));
		expect(ultrathinkAliases).toHaveLength(3);
		expect(ultrathinkAliases).toEqual([
			expect.objectContaining({
				rawPrompt: expect.stringContaining("[ULTRATHINK INTERNAL] iteration 1/3"),
				displayText: expect.stringContaining("Ultrathink iteration 1/3 (Recon)"),
			}),
			expect.objectContaining({
				rawPrompt: expect.stringContaining("[ULTRATHINK INTERNAL] iteration 2/3"),
				displayText: expect.stringContaining("Ultrathink iteration 2/3 (Verify)"),
			}),
			expect.objectContaining({
				rawPrompt: expect.stringContaining("[ULTRATHINK INTERNAL] iteration 3/3"),
				displayText: expect.stringContaining("Ultrathink iteration 3/3 (Synthesis)"),
			}),
		]);
		expect(created.getActiveToolNames()).toEqual(originalTools);
	});

	it("early-stops on stagnation and performs a final synthesis pass", async () => {
		const ultrathinkPrompts: string[] = [];
		let ultrathinkCalls = 0;

		const created = createSession(async (_model, context) => {
			const hiddenDirective = [...extractTextualMessages(context.messages as Array<{ role?: string; content?: unknown }>)]
				.reverse()
				.find((text) => text.includes("[ULTRATHINK INTERNAL]"));
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				if (!hiddenDirective) {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("normal response") });
					return;
				}

				ultrathinkPrompts.push(hiddenDirective);
				if (hiddenDirective.includes("[ULTRATHINK INTERNAL] iteration ")) {
					ultrathinkCalls += 1;
				}
				const isFinal = hiddenDirective.includes("iteration 3/3");
				stream.push({
					type: "done",
					reason: "stop",
					message: createAssistantMessage(
						[
							"### Iteration Summary",
							"- no new changes detected",
							isFinal ? "### Final Analysis\nI used ultrathink mode. Consolidated response." : "",
							"### Evidence Notes",
							"- [NO_NEW_EVIDENCE_OK] Stagnation detected with no additional tool checks.",
							"### Next Checkpoint",
							"Goal: stabilize auth objective",
							"Verified Facts:",
							"- same fact set",
							"Rejected Hypotheses:",
							"- none",
							"Open Questions:",
							"- none",
							"Next Checks:",
							"- none",
						].join("\n"),
					),
				});
			});
			return stream;
		});

		await created.prompt("/ultrathink -q 6 stabilize auth objective");

		expect(ultrathinkCalls).toBe(4);
		const iterationPrompts = ultrathinkPrompts.filter((text) => text.includes("[ULTRATHINK INTERNAL] iteration "));
		expect(iterationPrompts[0]).toContain("iteration 1/6");
		expect(iterationPrompts[1]).toContain("iteration 2/6");
		expect(iterationPrompts[2]).toContain("iteration 3/6");
		expect(iterationPrompts[3]).toContain("iteration 4/4");
	});

	it("cuts depth when token budget is exceeded and finalizes on the next pass", async () => {
		const ultrathinkPrompts: string[] = [];
		let ultrathinkCalls = 0;

		const created = createSession(async (_model, context) => {
			const hiddenDirective = [...extractTextualMessages(context.messages as Array<{ role?: string; content?: unknown }>)]
				.reverse()
				.find((text) => text.includes("[ULTRATHINK INTERNAL]"));
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				if (!hiddenDirective) {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("normal response") });
					return;
				}

				ultrathinkPrompts.push(hiddenDirective);
				if (hiddenDirective.includes("[ULTRATHINK INTERNAL] iteration ")) {
					ultrathinkCalls += 1;
				}
				const isFinal = hiddenDirective.includes("iteration 2/2");
				const usageOverride =
					ultrathinkCalls === 1
						? {
								input: 60001,
								output: 10,
								totalTokens: 60011,
								cost: { total: 0.001 },
							}
						: undefined;
				stream.push({
					type: "done",
					reason: "stop",
					message: createAssistantMessage(
						[
							"### Iteration Summary",
							"- budget-aware pass complete",
							isFinal ? "### Final Analysis\nI used ultrathink mode. Finalized under budget constraints." : "",
							"### Evidence Notes",
							"- [NO_NEW_EVIDENCE_OK] No additional checks required for this mock pass.",
							"### Next Checkpoint",
							"Goal: budget constrained objective",
							"Verified Facts:",
							"- constrained fact set",
							"Rejected Hypotheses:",
							"- none",
							"Open Questions:",
							"- none",
							"Next Checks:",
							"- finalize output",
						].join("\n"),
						usageOverride,
					),
				});
			});
			return stream;
		});

		await created.prompt("/ultrathink -q 5 budget constrained objective");

		expect(ultrathinkCalls).toBe(2);
		const iterationPrompts = ultrathinkPrompts.filter((text) => text.includes("[ULTRATHINK INTERNAL] iteration "));
		expect(iterationPrompts[0]).toContain("iteration 1/5");
		expect(iterationPrompts[1]).toContain("iteration 2/2");
	});

	it("uses previous user intent when /ultrathink is invoked without query", async () => {
		const ultrathinkPrompts: string[] = [];

		const created = createSession(async (_model, context) => {
			const hiddenDirective = [
				...extractTextualMessages(context.messages as Array<{ role?: string; content?: unknown }>),
			]
				.reverse()
				.find((text) => text.includes("[ULTRATHINK INTERNAL]"));
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				if (hiddenDirective) {
					ultrathinkPrompts.push(hiddenDirective);
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage(
							[
								"### Iteration Summary",
								"- inferred objective from context",
								"### Evidence Notes",
								"- [NO_NEW_EVIDENCE_OK] Context inspection was sufficient for this pass.",
								"### Next Checkpoint",
								"Goal: stabilize token refresh",
								"Verified Facts:",
								"- gathered from context",
								"Rejected Hypotheses:",
								"- none",
								"Open Questions:",
								"- pending",
								"Next Checks:",
								"- inspect auth service",
							].join("\n"),
						),
					});
					return;
				}

				stream.push({
					type: "done",
					reason: "stop",
					message: createAssistantMessage("acknowledged"),
				});
			});
			return stream;
		});

		await created.prompt("Need to stabilize token refresh in auth flow.");
		await created.prompt("/ultrathink -q 2");

		const iterationPrompts = ultrathinkPrompts.filter((text) => text.includes("[ULTRATHINK INTERNAL] iteration "));
		expect(iterationPrompts.length).toBe(2);
		expect(iterationPrompts[0]).toContain("Need to stabilize token refresh in auth flow.");
	});

	it("rejects /ultrathink while the agent is already streaming", async () => {
		const created = createSession((_model, _context, options) => {
			const stream = new MockAssistantStream();
			const signal = options?.signal;
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				const pollAbort = () => {
					if (signal?.aborted) {
						stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
						return;
					}
					setTimeout(pollAbort, 5);
				};
				pollAbort();
			});
			return stream;
		});

		const pending = created.prompt("long-running prompt");
		await new Promise((resolve) => setTimeout(resolve, 15));

		await expect(created.prompt("/ultrathink")).rejects.toThrow(
			"Cannot start /ultrathink while the agent is processing another request.",
		);

		await created.abort();
		await pending.catch(() => {});
	});

	it("does not fail the run when evidence policy stays non-compliant after repair", async () => {
		const hiddenPrompts: string[] = [];

		const created = createSession(async (_model, context) => {
			const hiddenDirective = [...extractTextualMessages(context.messages as Array<{ role?: string; content?: unknown }>)]
				.reverse()
				.find((text) => text.includes("[ULTRATHINK INTERNAL]"));
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				if (!hiddenDirective) {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("normal response") });
					return;
				}

				hiddenPrompts.push(hiddenDirective);
				if (hiddenDirective.includes("iteration 2/2")) {
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage(
							[
								"### Iteration Summary",
								"- fallback synthesis complete",
								"### Final Analysis",
								"I used ultrathink mode. Returning best-effort synthesis after policy fallback.",
								"### Evidence Notes",
								"- Best-effort mode after repeated evidence-format mismatch.",
								"### Next Checkpoint",
								"Goal: investigate auth",
								"Verified Facts:",
								"- baseline observed",
								"Rejected Hypotheses:",
								"- none",
								"Open Questions:",
								"- none",
								"Next Checks:",
								"- finalize",
							].join("\n"),
						),
					});
					return;
				}

				// Intentionally keep this non-compliant (numeric claim without evidence tags)
				// to ensure ultrathink degrades gracefully instead of throwing.
				stream.push({
					type: "done",
					reason: "stop",
					message: createAssistantMessage(
						[
							"### Iteration Summary",
							"- observed 2 files and 1 hotspot",
							"### Evidence Notes",
							"- pending",
							"### Next Checkpoint",
							"Goal: investigate auth",
							"Verified Facts:",
							"- baseline observed",
							"Rejected Hypotheses:",
							"- none",
							"Open Questions:",
							"- open",
							"Next Checks:",
							"- continue",
						].join("\n"),
					),
				});
			});
			return stream;
		});

		await expect(created.prompt("/ultrathink -q 5 investigate auth")).resolves.toBeUndefined();
		const lastAssistantText = created.getLastAssistantText();
		expect(lastAssistantText).toContain("best-effort synthesis");
		expect(hiddenPrompts).toEqual(
			expect.arrayContaining([
				expect.stringContaining("iteration 1/5"),
				expect.stringContaining("compliance repair 1/5"),
				expect.stringContaining("iteration 2/2"),
			]),
		);
	});

	it("restores original tools when ultrathink fails", async () => {
		const created = createSession(async (_model, context) => {
			const hasHiddenDirective = extractTextualMessages(
				context.messages as Array<{ role?: string; content?: unknown }>,
			).some((text) => text.includes("[ULTRATHINK INTERNAL]"));
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				stream.push({
					type: "done",
					reason: "stop",
					message: createAssistantMessage(
						hasHiddenDirective
							? [
									"### Iteration Summary",
									"- partial pass",
									"### Evidence Notes",
									"- [NO_NEW_EVIDENCE_OK] Mock validation without additional tools.",
									"### Next Checkpoint",
									"Goal: investigate auth",
									"Verified Facts:",
									"- fact",
									"Rejected Hypotheses:",
									"- none",
									"Open Questions:",
									"- open",
									"Next Checks:",
									"- continue",
								].join("\n")
							: "ok",
					),
				});
			});
			return stream;
		});

		const originalTools = created.getActiveToolNames();
		const originalPrompt = created.prompt.bind(created);
		const forcedFailure = new Error("forced ultrathink failure");

		(created as unknown as { prompt: typeof created.prompt }).prompt = async (text, options) => {
			if (options?.skipUltrathinkCommand) {
				throw forcedFailure;
			}
			return originalPrompt(text, options);
		};

		await expect(originalPrompt("/ultrathink -q 2 investigate auth")).rejects.toThrow("forced ultrathink failure");
		expect(created.getActiveToolNames()).toEqual(originalTools);
	});
});
