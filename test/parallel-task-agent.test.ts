import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import {
	__parallelTaskAgentTestUtils,
	shouldExecuteTaskCallsInParallel,
} from "../src/core/parallel-task-agent.js";

describe("parallel task execution policy", () => {
	it("enables parallel execution for multiple task calls", () => {
		const toolCalls = [
			{ type: "toolCall" as const, id: "a", name: "task", arguments: {} },
			{ type: "toolCall" as const, id: "b", name: "task", arguments: {} },
		];
		expect(shouldExecuteTaskCallsInParallel(toolCalls)).toBe(true);
	});

	it("keeps sequential execution for non-task or single calls", () => {
		expect(
			shouldExecuteTaskCallsInParallel([{ type: "toolCall" as const, id: "a", name: "task", arguments: {} }]),
		).toBe(false);
		expect(
			shouldExecuteTaskCallsInParallel([
				{ type: "toolCall" as const, id: "a", name: "task", arguments: {} },
				{ type: "toolCall" as const, id: "b", name: "bash", arguments: {} },
			]),
		).toBe(false);
	});

	it("preempts parallel task calls when steering arrives mid-batch", async () => {
		const assistantMessage = {
			content: [
				{ type: "toolCall" as const, id: "task_a", name: "task", arguments: { prompt: "a" } },
				{ type: "toolCall" as const, id: "task_b", name: "task", arguments: { prompt: "b" } },
			],
		};
		const tools = [
			{
				name: "task",
				parameters: Type.Object({}, { additionalProperties: true }),
				execute: async (_toolCallId: string, _args: unknown, signal?: AbortSignal) =>
					await new Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, never> }>(
						(resolve, reject) => {
							const timer = setTimeout(() => {
								resolve({
									content: [{ type: "text", text: "done" }],
									details: {},
								});
							}, 700);
							signal?.addEventListener(
								"abort",
								() => {
									clearTimeout(timer);
									reject(new Error("Operation aborted"));
								},
								{ once: true },
							);
						},
					),
			},
		];
		const stream = { push: () => undefined } as any;
		let steeringReady = false;
		let steeringServed = false;
		setTimeout(() => {
			steeringReady = true;
		}, 20);
		const getSteeringMessages = async () => {
			if (!steeringReady || steeringServed) return [];
			steeringServed = true;
			return [
				{
					role: "user",
					content: [{ type: "text", text: "interrupt" }],
					timestamp: Date.now(),
				} as any,
			];
		};

		const startedAt = Date.now();
		const result = await __parallelTaskAgentTestUtils.executeToolCallsWithPolicy(
			tools as any,
			assistantMessage,
			new AbortController().signal,
			stream,
			getSteeringMessages,
		);
		const elapsedMs = Date.now() - startedAt;

		expect(elapsedMs).toBeLessThan(500);
		expect(result.steeringMessages?.length).toBe(1);
		expect(result.toolResults).toHaveLength(2);
		expect(result.toolResults.every((item) => item.isError)).toBe(true);
		expect(
			result.toolResults.every((item) =>
				item.content.some((content) => content.type === "text" && content.text?.includes("Skipped due to queued user message.")),
			),
		).toBe(true);
	});
});
