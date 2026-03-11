import type { EngineeringContract } from "../contract.js";
import type { SingularAnalysisResult, SingularOption } from "../singular.js";
import type { ProjectIndex } from "../project-index/types.js";
import { queryProjectIndex } from "../project-index/index.js";
import type { SwarmPlan, SwarmTaskPlan } from "./types.js";

function toTaskId(index: number): string {
	return `task_${index + 1}`;
}

function compact(values: string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function inferConcurrencyClass(brief: string, touches: string[]): SwarmTaskPlan["concurrency_class"] {
	const lower = `${brief} ${touches.join(" ")}`.toLowerCase();
	if (/(test|spec|verification|verify|qa)/.test(lower)) return "verification";
	if (/(doc|readme|changelog)/.test(lower)) return "docs";
	if (/(analysis|audit|map|scope)/.test(lower)) return "analysis";
	if (/(implement|refactor|patch|change|rewrite)/.test(lower)) return "implementation";
	return "default";
}

function deriveScopes(contract: EngineeringContract, touches: string[]): string[] {
	if ((contract.scope_include ?? []).length > 0) {
		return compact(contract.scope_include ?? []);
	}
	const scopes = touches
		.map((touch) => touch.replace(/^\.\//, "").split("/").slice(0, 2).join("/"))
		.filter((value) => value.length > 0)
		.map((value) => `${value}/**`);
	return compact(scopes).slice(0, 8);
}

function spreadTouches(touches: string[], index: number): string[] {
	if (touches.length === 0) return [];
	const start = index % touches.length;
	const result: string[] = [];
	for (let offset = 0; offset < Math.min(3, touches.length); offset += 1) {
		result.push(touches[(start + offset) % touches.length] ?? touches[0]!);
	}
	return compact(result);
}

function deriveDiffPredictionTouches(index: ProjectIndex, querySeeds: string[], limit = 12): string[] {
	const touches: string[] = [];
	for (const seed of querySeeds) {
		if (!seed || seed.trim().length === 0) continue;
		const matches = queryProjectIndex(index, seed, Math.max(4, Math.floor(limit / 2))).matches;
		for (const entry of matches) {
			touches.push(entry.path);
			if (touches.length >= limit) {
				return compact(touches).slice(0, limit);
			}
		}
	}
	return compact(touches).slice(0, limit);
}

function buildTask(
	index: number,
	brief: string,
	touches: string[],
	scopes: string[],
	dependsOn: string[],
	severity: SwarmTaskPlan["severity"] = "medium",
): SwarmTaskPlan {
	const taskTouches = compact(touches).slice(0, 8);
	return {
		id: toTaskId(index),
		brief,
		depends_on: compact(dependsOn),
		scopes: compact(scopes),
		touches: taskTouches,
		concurrency_class: inferConcurrencyClass(brief, taskTouches),
		severity,
		needs_user_input: false,
		model_hint: "default",
		spawn_policy: severity === "high" ? "manual_high_risk" : "allow",
	};
}

export function buildSwarmPlanFromTask(input: {
	request: string;
	contract: EngineeringContract;
	index: ProjectIndex;
}): SwarmPlan {
	const matches = queryProjectIndex(input.index, input.request, 12).matches;
	const diffPredictionTouches = deriveDiffPredictionTouches(input.index, [
		input.request,
		`implement ${input.request}`,
		`refactor ${input.request}`,
		`verify ${input.request}`,
	]);
	const touches = compact([...matches.map((entry) => entry.path), ...diffPredictionTouches]).slice(0, 12);
	const scopes = deriveScopes(input.contract, touches.length > 0 ? touches : ["src/**", "test/**"]);

	const tasks: SwarmTaskPlan[] = [
		buildTask(0, `Map scope and baseline risks for: ${input.request}`, spreadTouches(touches, 0), scopes, [], "low"),
		buildTask(1, `Implement change for: ${input.request}`, spreadTouches(touches, 1), scopes, [toTaskId(0)], "high"),
		buildTask(2, `Verify behavior and quality gates for: ${input.request}`, spreadTouches(touches, 2), scopes, [toTaskId(1)], "medium"),
	];

	if ((input.contract.definition_of_done ?? []).length > 0 || (input.contract.quality_gates ?? []).length > 0) {
		tasks.push(
			buildTask(
				3,
				"Finalize integration report and contract gate checklist.",
				spreadTouches(touches, 3),
				scopes,
				[toTaskId(2)],
				"medium",
			),
		);
	}

	return {
		source: "plain",
		request: input.request,
		tasks,
		notes: [
			"Plan built from plain-language task and Project Index signals.",
			`candidate_files=${touches.length}`,
			`diff_prediction_candidates=${diffPredictionTouches.length}`,
		],
	};
}

export function buildSwarmPlanFromSingular(input: {
	analysis: SingularAnalysisResult;
	option: SingularOption;
	contract: EngineeringContract;
	index: ProjectIndex;
}): SwarmPlan {
	const optionTouches = compact(input.option.suggested_files);
	const fallbackTouches = queryProjectIndex(input.index, `${input.analysis.request} ${input.option.title}`, 12).matches.map(
		(entry) => entry.path,
	);
	const diffPredictionTouches = deriveDiffPredictionTouches(
		input.index,
		[
			input.analysis.request,
			input.option.title,
			input.option.summary,
			...input.option.plan.slice(0, 6),
			...input.option.pros.slice(0, 3),
			...input.option.cons.slice(0, 3),
		],
		14,
	);
	const touches = compact([
		...(optionTouches.length > 0 ? optionTouches : fallbackTouches),
		...diffPredictionTouches,
	]).slice(0, 14);
	const scopes = deriveScopes(input.contract, touches.length > 0 ? touches : ["src/**", "test/**"]);

	const steps = input.option.plan.length > 0
		? input.option.plan
		: [`Implement option ${input.option.id}: ${input.option.title}`];

	const tasks: SwarmTaskPlan[] = steps.map((step, index) =>
		buildTask(
			index,
			step,
			spreadTouches(touches, index),
			scopes,
			index === 0 ? [] : [toTaskId(index - 1)],
			index === 0 ? "medium" : index === steps.length - 1 ? "medium" : "high",
		),
	);

	if (tasks.length === 0) {
		tasks.push(buildTask(0, `Execute selected singular option: ${input.option.title}`, touches, scopes, [], "high"));
	}

	const finalTaskId = toTaskId(tasks.length);
	tasks.push(
		buildTask(
			tasks.length,
			"Run final task gates and prepare integration handoff artifact.",
			spreadTouches(touches, tasks.length),
			scopes,
			[tasks[tasks.length - 1]!.id],
			"medium",
		),
	);

	return {
		source: "singular",
		request: input.analysis.request,
		tasks,
		notes: [
			`singular_run_id=${input.analysis.runId}`,
			`option=${input.option.id}`,
			`option_title=${input.option.title}`,
			`final_task_id=${finalTaskId}`,
			`diff_prediction_candidates=${diffPredictionTouches.length}`,
		],
	};
}
