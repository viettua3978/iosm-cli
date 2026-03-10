import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import { TaskPlanMessageComponent } from "../src/modes/interactive/components/task-plan-message.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

describe("TaskPlanMessageComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders compact summary with current step in collapsed mode", () => {
		const component = new TaskPlanMessageComponent({
			complexity: "complex",
			steps: [
				{ status: "done", title: "Inspect files" },
				{ status: "in_progress", title: "Implement parser" },
				{ status: "pending", title: "Run tests" },
			],
			currentStepIndex: 1,
			completedSteps: 1,
			totalSteps: 3,
		});

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("[plan]");
		expect(rendered).toContain("Complex task plan: 1/3 done");
		expect(rendered).toContain("Current: Implement parser");
		expect(rendered).toContain("Steps hidden");
	});

	it("renders full step list in expanded mode", () => {
		const component = new TaskPlanMessageComponent({
			complexity: "complex",
			steps: [
				{ status: "done", title: "Inspect files" },
				{ status: "in_progress", title: "Implement parser" },
				{ status: "blocked", title: "Resolve API decision" },
			],
			currentStepIndex: 1,
			completedSteps: 1,
			totalSteps: 3,
		});
		component.setExpanded(true);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("1. Inspect files");
		expect(rendered).toContain("2. Implement parser");
		expect(rendered).toContain("3. Resolve API decision");
		expect(rendered).toContain("[in progress]");
		expect(rendered).toContain("[blocked]");
	});
});
