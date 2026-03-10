import type { IosmMetricSnapshot } from "./agent-verification.js";
import type { IosmConfig } from "./config.js";
import type { IosmPriorityChecklistItem } from "./guide.js";
import { IOSM_METRICS } from "./metrics.js";
import type { IosmDecision } from "./types.js";
import { IOSM_PHASES } from "./types.js";

export interface IosmAutomationOverrides {
	targetIndex?: number;
	maxIterations?: number;
}

export interface IosmAutomationSettings {
	targetIndex: number;
	maxIterations: number;
}

export interface IosmAutomationPromptInput {
	rootDir: string;
	cycleId?: string;
	targetIndex: number;
	iteration: number;
	maxIterations: number;
	snapshot: IosmMetricSnapshot;
	goals: string[];
	priorities: IosmPriorityChecklistItem[];
	currentDecision?: IosmDecision;
	criticalityProfile?: IosmConfig["iosm"]["metadata"]["criticality_profile"];
	approvalRequirements?: string[];
}

export interface IosmAutomationProgress {
	targetSatisfied: boolean;
	stabilized: boolean;
	failed: boolean;
}

function formatValue(value: number | null | undefined): string {
	return value === null || value === undefined ? "n/a" : value.toFixed(3);
}

export function resolveIosmAutomationSettings(
	config: Pick<IosmConfig, "iosm">,
	overrides: IosmAutomationOverrides = {},
): IosmAutomationSettings {
	const targetIndex = overrides.targetIndex ?? config.iosm.cycle_policy.stabilization.target_index;
	const maxIterations =
		overrides.maxIterations ??
		Math.max(1, config.iosm.cycle_policy.max_iterations_per_phase * IOSM_PHASES.length);

	return {
		targetIndex,
		maxIterations,
	};
}

export function hasReachedIosmTarget(
	snapshot: Pick<IosmMetricSnapshot, "iosm_index">,
	targetIndex: number,
): boolean {
	return snapshot.iosm_index !== null && snapshot.iosm_index >= targetIndex;
}

export function evaluateIosmAutomationProgress(input: {
	snapshot: Pick<IosmMetricSnapshot, "iosm_index">;
	targetIndex: number;
	cycleDecision?: IosmDecision;
	explicitTarget: boolean;
}): IosmAutomationProgress {
	return {
		targetSatisfied: input.explicitTarget && hasReachedIosmTarget(input.snapshot, input.targetIndex),
		stabilized: input.cycleDecision === "STOP",
		failed: input.cycleDecision === "FAIL",
	};
}

export function buildIosmAutomationPrompt(input: IosmAutomationPromptInput): string {
	const metricLine = IOSM_METRICS.map((metric) => `${metric}=${formatValue(input.snapshot.metrics[metric])}`).join(", ");
	const priorities =
		input.priorities.length > 0
			? input.priorities
					.map((item, index) => `${index + 1}. ${item.title} (${formatValue(item.value)}): ${item.action}`)
					.join("\n")
			: "1. No explicit priorities captured; use the weakest evidence-backed bottleneck.";
	const goals = input.goals.length > 0 ? input.goals.map((goal) => `- ${goal}`).join("\n") : "- No goals recorded.";
	const approvalRequirements =
		input.approvalRequirements && input.approvalRequirements.length > 0
			? input.approvalRequirements.map((item) => `- ${item}`).join("\n")
			: "- none declared";

	return [
		"You are in an IOSM automation loop.",
		"",
		`Repository root: ${input.rootDir}`,
		`Active cycle: ${input.cycleId ?? "unknown"}`,
		`Iteration: ${input.iteration}/${input.maxIterations}`,
		`Target IOSM index: ${input.targetIndex.toFixed(3)}`,
		`Current IOSM index: ${formatValue(input.snapshot.iosm_index)}`,
		`Current decision confidence: ${formatValue(input.snapshot.decision_confidence)}`,
		`Current cycle decision: ${input.currentDecision ?? "unknown"}`,
		`Criticality profile: ${input.criticalityProfile ?? "unknown"}`,
		`Current metrics: ${metricLine}`,
		"",
		"Priority bottlenecks:",
		priorities,
		"",
		"Current goals:",
		goals,
		"",
		"Human approval required for:",
		approvalRequirements,
		"",
		"Execution contract:",
		"1. Make one coherent improvement pass that should raise the IOSM index.",
		"2. You may change product code, tests, and project docs when they materially improve the system.",
		"3. Do not run /init and do not regenerate IOSM scaffolding; the outer loop will refresh and re-score after your pass.",
		"4. Keep repository exploration bounded and efficient. Prefer find/grep/read before broad bash scans.",
		"5. If a material product or architecture ambiguity affects the outcome, call ask_user with concise options and allow a custom answer before proceeding.",
		"6. If the intended change may fall into a human-approval category, call ask_user and obtain explicit approval before making that change.",
		"7. Keep IOSM automation governance auditable: update automation actor provenance, diff scope, and linked evidence when your pass changes those records.",
		"8. Run focused validation for the touched area before finishing the pass.",
		"9. Update IOSM artifacts only when they are stale because of the changes you made.",
		"10. Do not claim a new IOSM index in the answer; the outer loop will verify it.",
		"",
		"Final response format:",
		"- Short summary of changes and why they should improve IOSM.",
		"- Validation run.",
		"- Remaining bottleneck.",
	].join("\n");
}
