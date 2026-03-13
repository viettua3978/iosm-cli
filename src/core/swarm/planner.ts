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

const CODE_LIKE_EXTENSIONS = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|json|ya?ml|toml|sql|css|scss|html)$/i;
const DOC_EXTENSIONS = /\.(?:md|markdown|txt|rst|adoc)$/i;

function touchPriority(path: string): number {
	const normalized = path.trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
	let score = 0;
	if (/^(?:src|app|packages|lib|server|client|services|api)\//.test(normalized)) score += 4;
	if (/^(?:test|tests|__tests__)\//.test(normalized)) score += 3;
	if (/\.(?:test|spec)\./.test(normalized)) score += 2;
	if (CODE_LIKE_EXTENSIONS.test(normalized)) score += 2;
	if (DOC_EXTENSIONS.test(normalized)) score -= 3;
	if (/^(?:docs|assets)\//.test(normalized)) score -= 2;
	return score;
}

function prioritizeTouches(paths: string[]): string[] {
	const compacted = compact(paths);
	if (compacted.length <= 1) return compacted;
	const ranked = compacted
		.map((path) => ({ path, score: touchPriority(path) }))
		.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
		.map((item) => item.path);
	const hasCodeLike = ranked.some((path) => touchPriority(path) > 0);
	return hasCodeLike ? ranked : compacted;
}

function deriveWorkstreamCount(request: string, touches: string[]): number {
	const normalized = request.toLowerCase();
	const words = request
		.trim()
		.split(/\s+/)
		.filter((token) => token.length > 0).length;
	const conjunctions =
		(normalized.match(/\b(?:and|и|plus|also|then)\b/g)?.length ?? 0) +
		(normalized.match(/[;,/]/g)?.length ?? 0);
	const complexitySignal = /(audit|security|refactor|rewrite|migrat|hardening|parallel|orchestr|multi|complex|reliability|performance)/.test(
		normalized,
	);

	let workstreams = 1;
	if (touches.length >= 6) workstreams = 2;
	if (touches.length >= 10) workstreams = 3;
	if (touches.length >= 14) workstreams = 4;
	if (conjunctions >= 2) workstreams = Math.max(workstreams, 2);
	if (complexitySignal && words >= 2) workstreams = Math.max(workstreams, 2);
	if (complexitySignal && touches.length >= 8) workstreams = Math.max(workstreams, 3);

	// Keep fan-out bounded for predictable scheduler behavior.
	return Math.max(1, Math.min(4, workstreams));
}

function clusterTouchKey(touch: string): string {
	const normalized = touch.trim().replace(/\\/g, "/").replace(/^\.\//, "");
	if (!normalized) return "root";
	const parts = normalized.split("/").filter((part) => part.length > 0);
	if (parts.length === 0) return "root";
	if (parts.length === 1) return parts[0]!;
	return `${parts[0]}/${parts[1]}`;
}

function partitionTouchesForWorkstreams(touches: string[], requestedStreams: number): string[][] {
	const normalizedTouches = compact(touches);
	if (requestedStreams <= 1) return [normalizedTouches];
	const streamCount = Math.max(
		1,
		Math.min(requestedStreams, normalizedTouches.length > 0 ? normalizedTouches.length : requestedStreams),
	);
	if (streamCount <= 1) return [normalizedTouches];

	const groupsByKey = new Map<string, string[]>();
	for (const touch of normalizedTouches) {
		const key = clusterTouchKey(touch);
		const existing = groupsByKey.get(key);
		if (existing) {
			existing.push(touch);
		} else {
			groupsByKey.set(key, [touch]);
		}
	}

	const groups = [...groupsByKey.values()].sort((a, b) => b.length - a.length || a[0]!.localeCompare(b[0]!));
	const streams: string[][] = Array.from({ length: streamCount }, () => []);

	if (groups.length === 0) {
		return streams;
	}

	if (groups.length <= streamCount) {
		groups.forEach((group, index) => {
			streams[index] = compact(group);
		});
	} else {
		groups.forEach((group, index) => {
			const targetIndex =
				index < streamCount
					? index
					: streams.reduce(
							(bestIndex, current, currentIndex) => (current.length < streams[bestIndex]!.length ? currentIndex : bestIndex),
							0,
						);
			streams[targetIndex] = compact([...streams[targetIndex]!, ...group]);
		});
	}

	return streams.map((stream, index) => (stream.length > 0 ? stream : spreadTouches(normalizedTouches, index))).map((stream) => compact(stream));
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
	const touches = prioritizeTouches([...matches.map((entry) => entry.path), ...diffPredictionTouches]).slice(0, 12);
	const scopes = deriveScopes(input.contract, touches.length > 0 ? touches : ["src/**", "test/**"]);
	const workstreamCount = deriveWorkstreamCount(input.request, touches);
	const workstreamTouches = partitionTouchesForWorkstreams(touches, workstreamCount);

	const tasks: SwarmTaskPlan[] = [];
	const analysisTask = buildTask(0, `Map scope and baseline risks for: ${input.request}`, spreadTouches(touches, 0), scopes, [], "low");
	tasks.push(analysisTask);

	const workstreamTaskIds: string[] = [];
	const runWorkstreamsInParallel = workstreamTouches.length > 1;
	const isAuditRequest = /\b(?:audit|review|analy[sz]e|scan|security|assessment)\b/i.test(input.request);
	for (const streamTouches of workstreamTouches) {
		const streamIndex = workstreamTaskIds.length + 1;
		const brief = isAuditRequest
			? `Audit workstream ${streamIndex}/${workstreamTouches.length} for: ${input.request}`
			: `Execute workstream ${streamIndex}/${workstreamTouches.length} for: ${input.request}`;
		const task = buildTask(
			tasks.length,
			brief,
			streamTouches,
			scopes,
			runWorkstreamsInParallel ? [] : [analysisTask.id],
			"high",
		);
		tasks.push(task);
		workstreamTaskIds.push(task.id);
	}
	const verificationDependsOn = compact([
		...(workstreamTaskIds.length > 0 ? workstreamTaskIds : [analysisTask.id]),
		analysisTask.id,
	]);

	const verificationTask = buildTask(
		tasks.length,
		`Verify behavior and quality gates for: ${input.request}`,
		spreadTouches(touches, tasks.length),
		scopes,
		verificationDependsOn,
		"medium",
	);
	tasks.push(verificationTask);

	if ((input.contract.definition_of_done ?? []).length > 0 || (input.contract.quality_gates ?? []).length > 0) {
		tasks.push(
			buildTask(
				tasks.length,
				"Finalize integration report and contract gate checklist.",
				spreadTouches(touches, tasks.length),
				scopes,
				[verificationTask.id],
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
			`workstreams=${workstreamTouches.length}`,
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
	const touches = prioritizeTouches([
		...(optionTouches.length > 0 ? optionTouches : fallbackTouches),
		...diffPredictionTouches,
	]).slice(0, 14);
	const scopes = deriveScopes(input.contract, touches.length > 0 ? touches : ["src/**", "test/**"]);
	const workstreamSignal = [
		input.analysis.request,
		input.option.title,
		input.option.summary,
		...input.option.plan.slice(0, 6),
	].join(" ");
	const workstreamCount = deriveWorkstreamCount(workstreamSignal, touches);
	const touchStreams = partitionTouchesForWorkstreams(touches, workstreamCount);

	const steps =
		input.option.plan.length > 0 ? input.option.plan : [`Implement option ${input.option.id}: ${input.option.title}`];

	const tasks: SwarmTaskPlan[] = [];
	if (steps.length === 1) {
		const targetStreams = Math.max(1, Math.min(4, touchStreams.length));
		if (targetStreams <= 1) {
			tasks.push(buildTask(0, steps[0]!, spreadTouches(touches, 0), scopes, [], "high"));
		} else {
			tasks.push(
				buildTask(
					0,
					`Prepare execution baseline for option ${input.option.id}: ${input.option.title}`,
					spreadTouches(touches, 0),
					scopes,
					[],
					"medium",
				),
			);
			const setupTaskId = tasks[0]!.id;
			const streamTaskIds: string[] = [];
			for (let streamIndex = 0; streamIndex < targetStreams; streamIndex += 1) {
				const streamTouches = touchStreams[streamIndex] ?? spreadTouches(touches, streamIndex + 1);
				const streamTask = buildTask(
					tasks.length,
					`Implementation slice ${streamIndex + 1}/${targetStreams} for option ${input.option.id}: ${input.option.title}`,
					streamTouches,
					scopes,
					[setupTaskId],
					"high",
				);
				tasks.push(streamTask);
				streamTaskIds.push(streamTask.id);
			}
			tasks.push(
				buildTask(
					tasks.length,
					steps[0]!,
					spreadTouches(touches, tasks.length),
					scopes,
					streamTaskIds,
					"medium",
				),
			);
		}
	} else if (steps.length === 2) {
		const targetStreams = Math.max(1, Math.min(4, touchStreams.length));
		tasks.push(buildTask(0, steps[0]!, spreadTouches(touches, 0), scopes, [], "medium"));
		if (targetStreams <= 1) {
			tasks.push(buildTask(1, steps[1]!, spreadTouches(touches, 1), scopes, [tasks[0]!.id], "high"));
		} else {
			const setupTaskId = tasks[0]!.id;
			const streamTaskIds: string[] = [];
			for (let streamIndex = 0; streamIndex < targetStreams; streamIndex += 1) {
				const streamTouches = touchStreams[streamIndex] ?? spreadTouches(touches, streamIndex + 1);
				const streamTask = buildTask(
					tasks.length,
					`Implementation slice ${streamIndex + 1}/${targetStreams} for option ${input.option.id}: ${input.option.title}`,
					streamTouches,
					scopes,
					[setupTaskId],
					"high",
				);
				tasks.push(streamTask);
				streamTaskIds.push(streamTask.id);
			}
			tasks.push(
				buildTask(
					tasks.length,
					steps[1]!,
					spreadTouches(touches, tasks.length),
					scopes,
					streamTaskIds,
					"medium",
				),
			);
		}
	} else {
		// For richer singular options, preserve an initial setup step, run middle slices in parallel,
		// then converge into a final synthesis/verification step.
		tasks.push(buildTask(0, steps[0]!, spreadTouches(touches, 0), scopes, [], "medium"));
		const setupTaskId = tasks[0]!.id;
		const middleSteps = steps.slice(1, -1);
		const middleTaskIds: string[] = [];
		for (const step of middleSteps) {
			const task = buildTask(tasks.length, step, spreadTouches(touches, tasks.length), scopes, [setupTaskId], "high");
			tasks.push(task);
			middleTaskIds.push(task.id);
		}
		const targetParallelSlices = Math.max(middleSteps.length, Math.max(1, Math.min(4, touchStreams.length)));
		for (let streamIndex = middleSteps.length; streamIndex < targetParallelSlices; streamIndex += 1) {
			const streamTouches = touchStreams[streamIndex] ?? spreadTouches(touches, streamIndex + 1);
			const task = buildTask(
				tasks.length,
				`Parallel slice ${streamIndex + 1}/${targetParallelSlices} for option ${input.option.id}: ${input.option.title}`,
				streamTouches,
				scopes,
				[setupTaskId],
				"high",
			);
			tasks.push(task);
			middleTaskIds.push(task.id);
		}
		const finalStepDependsOn = middleTaskIds.length > 0 ? middleTaskIds : [setupTaskId];
		tasks.push(
			buildTask(
				tasks.length,
				steps[steps.length - 1]!,
				spreadTouches(touches, tasks.length),
				scopes,
				finalStepDependsOn,
				"medium",
			),
		);
	}

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
			`workstreams=${touchStreams.length}`,
		],
	};
}
