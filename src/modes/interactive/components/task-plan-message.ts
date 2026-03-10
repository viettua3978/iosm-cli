import { Box, Spacer, Text } from "@mariozechner/pi-tui";
import type { TaskPlanSnapshot } from "../../../core/task-plan.js";
import { theme } from "../theme/theme.js";
import { editorKey } from "./keybinding-hints.js";

export class TaskPlanMessageComponent extends Box {
	private expanded = false;
	private snapshot: TaskPlanSnapshot;

	constructor(snapshot: TaskPlanSnapshot) {
		super(1, 1, (text) => theme.bg("customMessageBg", text));
		this.snapshot = snapshot;
		this.renderContent();
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded !== expanded) {
			this.expanded = expanded;
			this.renderContent();
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.renderContent();
	}

	private statusLabel(status: TaskPlanSnapshot["steps"][number]["status"]): string {
		switch (status) {
			case "done":
				return theme.fg("success", "[done]");
			case "in_progress":
				return theme.fg("accent", "[in progress]");
			case "blocked":
				return theme.fg("warning", "[blocked]");
			case "pending":
			default:
				return theme.fg("muted", "[pending]");
		}
	}

	private renderContent(): void {
		this.clear();

		this.addChild(new Text(theme.fg("customMessageLabel", "\x1b[1m[plan]\x1b[22m"), 0, 0));
		this.addChild(new Spacer(1));

		const summary = `Complex task plan: ${this.snapshot.completedSteps}/${this.snapshot.totalSteps} done`;
		this.addChild(new Text(theme.fg("customMessageText", summary), 0, 0));

		if (this.snapshot.currentStepIndex !== null) {
			const current = this.snapshot.steps[this.snapshot.currentStepIndex]?.title;
			if (current) {
				this.addChild(new Text(theme.fg("accent", `Current: ${current}`), 0, 0));
			}
		}

		if (!this.expanded) {
			this.addChild(
				new Text(
					theme.fg("customMessageText", "Steps hidden (") +
						theme.fg("dim", editorKey("expandTools")) +
						theme.fg("customMessageText", " to expand)"),
					0,
					0,
				),
			);
			return;
		}

		this.addChild(new Spacer(1));
		for (const [index, step] of this.snapshot.steps.entries()) {
			const isCurrent = this.snapshot.currentStepIndex === index;
			const marker = isCurrent ? theme.fg("accent", "-> ") : "   ";
			const line =
				marker + this.statusLabel(step.status) + theme.fg("customMessageText", ` ${index + 1}. ${step.title}`);
			this.addChild(new Text(line, 0, 0));
		}
	}
}
