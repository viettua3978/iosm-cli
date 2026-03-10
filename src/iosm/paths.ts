import { join, resolve } from "node:path";
import type { IosmPhase } from "./types.js";

/** Pattern for valid cycle IDs — prevents path traversal */
const CYCLE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate a cycle ID for use in path construction.
 * Throws if the ID contains path-traversal characters or is otherwise unsafe.
 */
export function assertValidCycleId(cycleId: string): void {
	if (!cycleId || !CYCLE_ID_PATTERN.test(cycleId)) {
		throw new Error(
			`Invalid cycle ID "${cycleId}". Cycle IDs must contain only alphanumeric characters, hyphens, and underscores.`,
		);
	}
}

/**
 * Validate that a resolved path stays within the expected base directory.
 * Secondary guard against path traversal via symlinks or unusual path inputs.
 */
function assertWithinDir(resolved: string, baseDir: string): void {
	if (!resolved.startsWith(baseDir + "/") && resolved !== baseDir) {
		throw new Error(`Path traversal detected: "${resolved}" is outside "${baseDir}".`);
	}
}

export function getIosmWorkspaceDir(cwd: string = process.cwd()): string {
	return join(cwd, ".iosm");
}

export function getIosmConfigPath(cwd: string = process.cwd()): string {
	return join(cwd, "iosm.yaml");
}

export function getIosmGuidePath(cwd: string = process.cwd()): string {
	return join(cwd, "IOSM.md");
}

export function getIosmBaselinesDir(cwd: string = process.cwd()): string {
	return join(getIosmWorkspaceDir(cwd), "baselines");
}

export function getIosmCyclesDir(cwd: string = process.cwd()): string {
	return join(getIosmWorkspaceDir(cwd), "cycles");
}

export function getIosmCycleDir(cycleId: string, cwd: string = process.cwd()): string {
	assertValidCycleId(cycleId);
	const cyclesDir = getIosmCyclesDir(cwd);
	const resolved = resolve(cyclesDir, cycleId);
	assertWithinDir(resolved, cyclesDir);
	return resolved;
}

export function getIosmBaselineReportPath(cycleId: string, cwd: string = process.cwd()): string {
	return join(getIosmCycleDir(cycleId, cwd), "baseline-report.json");
}

export function getIosmHypothesesPath(cycleId: string, cwd: string = process.cwd()): string {
	return join(getIosmCycleDir(cycleId, cwd), "hypotheses.json");
}

export function getIosmCycleReportPath(cycleId: string, cwd: string = process.cwd()): string {
	return join(getIosmCycleDir(cycleId, cwd), "cycle-report.json");
}

export function getIosmPhaseReportsDir(cycleId: string, cwd: string = process.cwd()): string {
	return join(getIosmCycleDir(cycleId, cwd), "phase-reports");
}

export function getIosmPhaseReportPath(
	cycleId: string,
	phase: IosmPhase,
	cwd: string = process.cwd(),
): string {
	return join(getIosmPhaseReportsDir(cycleId, cwd), `${phase}.json`);
}

export function getIosmMetricsHistoryPath(cwd: string = process.cwd()): string {
	return join(getIosmWorkspaceDir(cwd), "metrics-history.jsonl");
}

export function getIosmWaiverRegisterPath(cwd: string = process.cwd()): string {
	return join(getIosmWorkspaceDir(cwd), "waivers.yaml");
}

export function getIosmInvariantCatalogPath(cwd: string = process.cwd()): string {
	return join(getIosmWorkspaceDir(cwd), "invariants.yaml");
}

export function getIosmContractCatalogPath(cwd: string = process.cwd()): string {
	return join(getIosmWorkspaceDir(cwd), "contracts.yaml");
}

export function getIosmDecisionLogPath(cwd: string = process.cwd()): string {
	return join(getIosmWorkspaceDir(cwd), "decision-log.md");
}

export function getIosmPatternLibraryPath(cwd: string = process.cwd()): string {
	return join(getIosmWorkspaceDir(cwd), "pattern-library.md");
}
