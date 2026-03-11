export type FailureCause =
	| "token_limit"
	| "logic_error"
	| "aborted"
	| "timeout"
	| "dependency_env"
	| "empty_output"
	| "unknown";

const tokenLimitPattern =
	/(token limit|max(?:imum)? tokens?|too many tokens?|context length|context window|prompt is too long|input too long|length exceeded)/i;
const logicPattern =
	/(logic|invariant|assert(?:ion)?|expect\(|failed assumption|incorrect result|wrong output|invalid state|regression|failed dependency)/i;
const abortPattern = /(operation aborted|aborted|signal aborted)/i;
const timeoutPattern = /(timeout|timed out|deadline exceeded|took too long|hang(?:ing)?)/i;
const dependencyPattern =
	/(module not found|cannot find module|dependency|package|importerror|missing dependency|command not found|enoent|env(?:ironment)?)/i;
const emptyOutputPattern = /(empty output|no output|returned empty)/i;

export function classifyFailureCause(errorMessage: string): FailureCause {
	const message = errorMessage.trim();
	if (!message) return "unknown";
	if (emptyOutputPattern.test(message)) return "empty_output";
	if (tokenLimitPattern.test(message)) return "token_limit";
	if (abortPattern.test(message)) return "aborted";
	if (timeoutPattern.test(message)) return "timeout";
	if (dependencyPattern.test(message)) return "dependency_env";
	if (logicPattern.test(message)) return "logic_error";
	return "unknown";
}

export function isRetrospectiveRetryable(cause: FailureCause): boolean {
	return cause !== "empty_output" && cause !== "aborted";
}

function guidanceForCause(cause: FailureCause): string[] {
	switch (cause) {
		case "token_limit":
			return [
				"- Narrow scope to only the minimum files/commands needed.",
				"- Produce concise output (bullet points + critical diffs only).",
				"- Avoid broad scans and repeated large reads.",
			];
		case "logic_error":
			return [
				"- Diagnose why the prior approach failed before changing code.",
				"- Use an alternative strategy, not a repeat of the same path.",
				"- Prefer smallest verifiable step and validate assumptions explicitly.",
			];
		case "aborted":
			return [
				"- Stop retries for this task execution; cancellation came from an external signal.",
				"- Report cancellation context (where it happened and what was in progress).",
				"- Resume only via an explicit new task/run request.",
			];
		case "timeout":
			return [
				"- Split work into smaller bounded steps.",
				"- Reduce expensive commands and long-running checks.",
				"- Prioritize fast targeted verification first.",
			];
		case "dependency_env":
			return [
				"- Verify environment/dependency preconditions first.",
				"- Prefer deterministic remediation steps and minimal commands.",
				"- If blocked by environment, report exact missing prerequisite.",
			];
		case "empty_output":
			return [
				"- Ensure the response includes a concrete result summary.",
				"- If still impossible, return a clear blocked reason.",
			];
		default:
			return [
				"- Re-evaluate assumptions and reduce scope.",
				"- Try a different implementation approach.",
				"- Produce a concise, verifiable outcome.",
			];
	}
}

export function buildRetrospectiveDirective(input: {
	cause: FailureCause;
	errorMessage: string;
	attempt: number;
	target: "root" | "delegate";
}): string {
	const guidance = guidanceForCause(input.cause).join("\n");
	return [
		"[RETROSPECTIVE_RETRY]",
		`target: ${input.target}`,
		`attempt: ${input.attempt}`,
		`cause: ${input.cause}`,
		`previous_error: ${input.errorMessage.replace(/\s+/g, " ").trim()}`,
		"retry_policy:",
		guidance,
		"[/RETROSPECTIVE_RETRY]",
	].join("\n");
}

export function formatFailureCauseCounts(counts: Partial<Record<FailureCause, number>>): string {
	const ordered: FailureCause[] = [
		"token_limit",
		"logic_error",
		"aborted",
		"timeout",
		"dependency_env",
		"empty_output",
		"unknown",
	];
	const parts = ordered
		.map((cause) => ({ cause, count: counts[cause] ?? 0 }))
		.filter((item) => item.count > 0)
		.map((item) => `${item.cause}=${item.count}`);
	return parts.join(", ");
}

export function dominantFailureCause(
	counts: Partial<Record<FailureCause, number>>,
): FailureCause | undefined {
	const entries = Object.entries(counts) as Array<[FailureCause, number | undefined]>;
	let best: FailureCause | undefined;
	let bestCount = 0;
	for (const [cause, count] of entries) {
		const normalized = count ?? 0;
		if (normalized > bestCount) {
			best = cause;
			bestCount = normalized;
		}
	}
	return best;
}
