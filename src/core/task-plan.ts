import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";

export const TASK_PLAN_CUSTOM_TYPE = "task-plan";

export type TaskPlanComplexity = "complex";

export type TaskPlanStepStatus = "pending" | "in_progress" | "done" | "blocked";

export interface TaskPlanStep {
	title: string;
	status: TaskPlanStepStatus;
}

export interface TaskPlanSnapshot {
	complexity: TaskPlanComplexity;
	steps: TaskPlanStep[];
	currentStepIndex: number | null;
	completedSteps: number;
	totalSteps: number;
}

interface ExtractFromTextResult {
	cleanedText: string;
	planSnapshots: TaskPlanSnapshot[];
	changed: boolean;
}

interface ParsePlanBodyResult {
	steps: TaskPlanStep[];
	currentStepIndex: number | null;
}

interface ExtractFromAssistantResult {
	sanitizedMessage: AssistantMessage;
	planSnapshot: TaskPlanSnapshot | undefined;
	changed: boolean;
}

const TASK_PLAN_BLOCK_PATTERN =
	/<task_plan(?:\s+complexity="([^"]+)")?\s*>([\s\S]*?)<\/task_plan>|<task_plan_update(?:\s+complexity="([^"]+)")?\s*>([\s\S]*?)<\/task_plan_update>/gi;

function normalizeStatus(raw: string): TaskPlanStepStatus | undefined {
	const token = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
	switch (token) {
		case "pending":
		case "todo":
		case "to_do":
		case "open":
			return "pending";
		case "in_progress":
		case "active":
		case "current":
		case "doing":
			return "in_progress";
		case "done":
		case "complete":
		case "completed":
			return "done";
		case "blocked":
		case "waiting":
		case "on_hold":
		case "paused":
			return "blocked";
		default:
			return undefined;
	}
}

function parsePlanBody(body: string): ParsePlanBodyResult {
	const steps: TaskPlanStep[] = [];

	for (const line of body.split(/\r?\n/g)) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		const withStatus = trimmed.match(/^(?:[-*+]|\d+\.)?\s*\[([a-zA-Z _-]+)\]\s*(.+)$/);
		if (withStatus) {
			const status = normalizeStatus(withStatus[1]);
			const title = withStatus[2].trim();
			if (!status || title.length === 0) continue;
			steps.push({ status, title });
			continue;
		}

		const fallbackTitle = trimmed.replace(/^(?:[-*+]|\d+\.)\s*/, "").trim();
		if (!fallbackTitle) continue;
		steps.push({ status: "pending", title: fallbackTitle });
	}

	let currentStepIndex = steps.findIndex((step) => step.status === "in_progress");
	if (currentStepIndex === -1) {
		currentStepIndex = steps.findIndex((step) => step.status === "pending");
	}

	return {
		steps,
		currentStepIndex: currentStepIndex === -1 ? null : currentStepIndex,
	};
}

function parseSnapshot(blockBody: string, complexityRaw: string | undefined): TaskPlanSnapshot | undefined {
	const complexity = complexityRaw?.trim().toLowerCase();
	if (complexity === "simple") {
		return undefined;
	}

	const parsed = parsePlanBody(blockBody);
	if (parsed.steps.length === 0) {
		return undefined;
	}

	const completedSteps = parsed.steps.filter((step) => step.status === "done").length;
	return {
		complexity: "complex",
		steps: parsed.steps,
		currentStepIndex: parsed.currentStepIndex,
		completedSteps,
		totalSteps: parsed.steps.length,
	};
}

export function extractTaskPlanFromText(text: string): ExtractFromTextResult {
	const snapshots: TaskPlanSnapshot[] = [];

	const strippedText = text.replace(
		TASK_PLAN_BLOCK_PATTERN,
		(_match, planComplexity: string | undefined, planBody: string | undefined, updateComplexity, updateBody) => {
			const body = (planBody ?? updateBody ?? "").trim();
			const complexity = planComplexity ?? updateComplexity;
			const snapshot = parseSnapshot(body, complexity);
			if (snapshot) {
				snapshots.push(snapshot);
			}
			return "";
		},
	);

	const compacted = strippedText.replace(/\n{3,}/g, "\n\n");
	const cleanedText = compacted.trim().length > 0 ? compacted : "";

	return {
		cleanedText,
		planSnapshots: snapshots,
		changed: cleanedText !== text,
	};
}

export function extractTaskPlanFromAssistantMessage(message: AssistantMessage): ExtractFromAssistantResult {
	let changed = false;
	let latestSnapshot: TaskPlanSnapshot | undefined;

	const sanitizedContent = message.content.map((part) => {
		if (part.type !== "text") {
			return part;
		}

		const extracted = extractTaskPlanFromText(part.text);
		if (extracted.planSnapshots.length > 0) {
			latestSnapshot = extracted.planSnapshots[extracted.planSnapshots.length - 1];
		}
		if (!extracted.changed) {
			return part;
		}

		changed = true;
		return {
			...part,
			text: extracted.cleanedText,
		} satisfies TextContent;
	});

	return {
		sanitizedMessage: changed ? { ...message, content: sanitizedContent } : message,
		planSnapshot: latestSnapshot,
		changed,
	};
}

export function taskPlanSignature(snapshot: TaskPlanSnapshot): string {
	return snapshot.steps.map((step) => `${step.status}:${step.title}`).join("||");
}

export function formatTaskPlanMessageContent(snapshot: TaskPlanSnapshot): string {
	const lines: string[] = [];
	lines.push(`Execution plan (${snapshot.completedSteps}/${snapshot.totalSteps} complete)`);

	if (snapshot.currentStepIndex !== null) {
		lines.push(`Current: ${snapshot.steps[snapshot.currentStepIndex].title}`);
	}

	for (const [index, step] of snapshot.steps.entries()) {
		lines.push(`${index + 1}. [${step.status}] ${step.title}`);
	}

	return lines.join("\n");
}

export function isTaskPlanSnapshot(value: unknown): value is TaskPlanSnapshot {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const candidate = value as Partial<TaskPlanSnapshot>;
	if (candidate.complexity !== "complex") {
		return false;
	}
	if (!Array.isArray(candidate.steps) || typeof candidate.totalSteps !== "number") {
		return false;
	}

	return candidate.steps.every((step) => {
		const typedStep = step as Partial<TaskPlanStep>;
		return (
			typeof typedStep.title === "string" &&
			(typedStep.status === "pending" ||
				typedStep.status === "in_progress" ||
				typedStep.status === "done" ||
				typedStep.status === "blocked")
		);
	});
}
