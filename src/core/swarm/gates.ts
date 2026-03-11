import type { EngineeringContract } from "../contract.js";
import { isTouchInScope } from "./locks.js";
import type { SwarmGateResult, SwarmRunGateResult, SwarmTaskPlan, SwarmTaskRuntimeState } from "./types.js";

export function evaluateTaskGates(task: SwarmTaskPlan, contract: EngineeringContract): SwarmGateResult {
	const warnings: string[] = [];
	const failures: string[] = [];
	const checks: string[] = [];

	const scopeExclude = contract.scope_exclude ?? [];
	const scopeInclude = contract.scope_include ?? [];

	if (scopeExclude.length > 0) {
		checks.push(`scope_exclude=${scopeExclude.length}`);
		for (const touch of task.touches) {
			if (scopeExclude.some((scope) => isTouchInScope(touch, scope))) {
				failures.push(`Touch "${touch}" is excluded by contract scope_exclude.`);
			}
		}
	}

	if (scopeInclude.length > 0) {
		checks.push(`scope_include=${scopeInclude.length}`);
		const allOutside =
			task.touches.length > 0 &&
			task.touches.every((touch) => !scopeInclude.some((scope) => isTouchInScope(touch, scope)));
		if (allOutside) {
			warnings.push("All touches are outside scope_include. Verify contract boundaries.");
		}
	}

	if ((contract.constraints ?? []).length > 0) {
		checks.push(`constraints=${contract.constraints?.length ?? 0}`);
	}
	if ((contract.quality_gates ?? []).length > 0) {
		checks.push(`quality_gates=${contract.quality_gates?.length ?? 0}`);
	}
	if ((contract.definition_of_done ?? []).length > 0) {
		checks.push(`definition_of_done=${contract.definition_of_done?.length ?? 0}`);
	}

	return {
		taskId: task.id,
		pass: failures.length === 0,
		warnings,
		failures,
		checks,
	};
}

export function evaluateRunGates(input: {
	taskStates: Record<string, SwarmTaskRuntimeState>;
	taskGateResults: SwarmGateResult[];
	contract: EngineeringContract;
}): SwarmRunGateResult {
	const warnings: string[] = [];
	const failures: string[] = [];

	const tasks = Object.values(input.taskStates);
	const nonDone = tasks.filter((task) => task.status !== "done");
	if (nonDone.length > 0) {
		failures.push(`${nonDone.length} task(s) are not done.`);
	}

	const failedTaskGates = input.taskGateResults.filter((result) => !result.pass);
	if (failedTaskGates.length > 0) {
		failures.push(`${failedTaskGates.length} task gate(s) failed.`);
	}

	if ((input.contract.quality_gates ?? []).length > 0) {
		warnings.push("Run-gates rely on task-level checks and manual contract quality_gates confirmation.");
	}
	if ((input.contract.definition_of_done ?? []).length > 0) {
		warnings.push("Definition of Done items should be reviewed in final integration report.");
	}

	return {
		pass: failures.length === 0,
		warnings,
		failures,
	};
}
