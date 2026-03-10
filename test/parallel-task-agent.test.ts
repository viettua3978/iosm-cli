import { describe, expect, it } from "vitest";
import { shouldExecuteTaskCallsInParallel } from "../src/core/parallel-task-agent.js";

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
});
