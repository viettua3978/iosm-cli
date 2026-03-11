import { homedir } from "node:os";
import { Box, Spacer, Text } from "@mariozechner/pi-tui";
import { theme } from "../theme/theme.js";

export type SubagentPhaseState = "queued" | "starting" | "running" | "responding";
export type SubagentDelegateStatus = "pending" | "running" | "done" | "failed";

export interface SubagentDelegateItem {
	index: number;
	description: string;
	profile: string;
	status: SubagentDelegateStatus;
}

export interface SubagentInfo {
	/** Human-readable description of the subagent's task, e.g. "Exploring TypeScript files" */
	description: string;
	/** Profile name, e.g. "explore" | "plan" | "fix" */
	profile: string;
	/** Current lifecycle state of the subagent */
	status: "running" | "done" | "error";
	/** Byte length of the subagent's output, populated when status is "done" */
	outputLength?: number;
	/** Wall-clock elapsed time in milliseconds, populated when status is "done" */
	durationMs?: number;
	/** Error message, populated when status is "error" */
	errorMessage?: string;
	/** Current phase summary for in-progress work */
	phase?: string;
	/** Current phase state in the execution timeline */
	phaseState?: SubagentPhaseState;
	/** Effective working directory for the subagent */
	cwd?: string;
	/** Optional custom agent label */
	agent?: string;
	/** Optional lock domain key */
	lockKey?: string;
	/** Isolation mode for this run */
	isolation?: "none" | "worktree";
	/** Current active subagent tool (e.g. read, bash, write) */
	activeTool?: string;
	/** Number of subagent tool calls started */
	toolCallsStarted?: number;
	/** Number of subagent tool calls completed */
	toolCallsCompleted?: number;
	/** Number of assistant messages produced inside subagent */
	assistantMessages?: number;
	/** Queue delay before execution started (ms) */
	waitMs?: number;
	/** Number of delegated child subtasks launched by this subagent */
	delegatedTasks?: number;
	/** Number of delegated child subtasks finished successfully */
	delegatedSucceeded?: number;
	/** Number of delegated child subtasks that failed */
	delegatedFailed?: number;
	/** Currently active delegated subtask index (1-based) */
	delegateIndex?: number;
	/** Total delegated subtasks in the current batch */
	delegateTotal?: number;
	/** Currently active delegated subtask description */
	delegateDescription?: string;
	/** Currently active delegated subtask profile */
	delegateProfile?: string;
	/** Delegate task mini-list with per-item status */
	delegateItems?: SubagentDelegateItem[];
}

type DelegateSummary = {
	total: number;
	done: number;
	failed: number;
	running: number;
	pending: number;
};

/**
 * Format a byte count as a compact human-readable string.
 * Mirrors the formatting conventions used elsewhere in the footer (k/M suffixes).
 */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Format a millisecond duration as a compact human-readable string.
 * Keeps the unit explicit so users can immediately scan the value at a glance.
 */
function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = ((ms % 60_000) / 1000).toFixed(0);
	return `${minutes}m ${seconds}s`;
}

function formatElapsedClock(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const pad2 = (value: number): string => value.toString().padStart(2, "0");
	if (hours > 0) {
		return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
	}
	return `${pad2(minutes)}:${pad2(seconds)}`;
}

function shortenPath(path: string): string {
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function formatToolProgress(started?: number, completed?: number): string | undefined {
	if (typeof started !== "number" || started < 0) return undefined;
	if (typeof completed === "number" && completed >= 0) {
		return `tools ${completed}/${started}`;
	}
	return `tools ${started}`;
}

function formatSubagentBadge(agent?: string): string {
	if (typeof agent !== "string") return "[subagent]";
	const normalized = agent.trim();
	if (!normalized) return "[subagent]";
	return `[subagent:${normalized}]`;
}

function renderPhaseTimeline(phaseState: SubagentPhaseState): string {
	const phases: SubagentPhaseState[] = ["queued", "starting", "running", "responding"];
	const currentIndex = phases.indexOf(phaseState);
	if (currentIndex < 0) return "";

	const segments = phases.map((phase, index) => {
		const marker = index < currentIndex ? "[x]" : index === currentIndex ? "[>]" : "[ ]";
		const text = `${marker} ${phase}`;
		if (index < currentIndex) return theme.fg("success", text);
		if (index === currentIndex) return theme.fg("accent", text);
		return theme.fg("muted", text);
	});
	return `${theme.fg("muted", "flow")} ${segments.join(theme.fg("dim", " -> "))}`;
}

function summarizeDelegates(info: SubagentInfo): DelegateSummary | undefined {
	if (Array.isArray(info.delegateItems) && info.delegateItems.length > 0) {
		let done = 0;
		let failed = 0;
		let running = 0;
		let pending = 0;
		for (const item of info.delegateItems) {
			switch (item.status) {
				case "done":
					done += 1;
					break;
				case "failed":
					failed += 1;
					break;
				case "running":
					running += 1;
					break;
				default:
					pending += 1;
					break;
			}
		}
		return { total: info.delegateItems.length, done, failed, running, pending };
	}
	if (typeof info.delegatedTasks === "number" && info.delegatedTasks > 0) {
		const total = info.delegatedTasks;
		const done = typeof info.delegatedSucceeded === "number" ? Math.max(0, info.delegatedSucceeded) : 0;
		const failed = typeof info.delegatedFailed === "number" ? Math.max(0, info.delegatedFailed) : 0;
		const running = Math.max(0, total - done - failed);
		const pending = 0;
		return { total, done, failed, running, pending };
	}
	return undefined;
}

function formatDelegateSummary(summary: DelegateSummary): string {
	const parts: string[] = [`delegates ${summary.done}/${summary.total} done`];
	if (summary.failed > 0) {
		parts.push(`${summary.failed} failed`);
	}
	if (summary.running > 0) {
		parts.push(`${summary.running} running`);
	}
	return parts.join(", ");
}

function selectDelegateItemsForDisplay(items: SubagentDelegateItem[]): {
	visibleItems: SubagentDelegateItem[];
	compacted: boolean;
	hiddenDonePending: number;
	overflow: number;
} {
	const compactThreshold = 6;
	const maxRows = 5;
	if (items.length > compactThreshold) {
		const critical = items.filter((item) => item.status === "running" || item.status === "failed");
		const visibleItems = critical.slice(0, maxRows);
		return {
			visibleItems,
			compacted: true,
			hiddenDonePending: Math.max(0, items.length - critical.length),
			overflow: Math.max(0, critical.length - visibleItems.length),
		};
	}
	const visibleItems = items.slice(0, maxRows);
	return {
		visibleItems,
		compacted: false,
		hiddenDonePending: 0,
		overflow: Math.max(0, items.length - visibleItems.length),
	};
}

/**
 * Component that surfaces a running or completed subagent (task tool invocation).
 *
 * Visual structure
 * ----------------
 * Line 1 (header):  [subagent] <profile> · <description>
 * Line 2 (status):
 *   running  →  ... <phase>
 *              @ <cwd> · tool <active> · tools <done>/<started>
 *              delegates <done>/<total> done, <failed> failed
 *              delegate <i>/<n> · <description> · (<profile>)
 *              delegates list with status markers (compact mode on large runs)
 *              flow [x] queued -> [>] running -> [ ] responding
 *   done     →  + <outputSize> output, <duration>, tools <done>/<started>, queue <wait>
 *   error    →  x <errorMessage or "error">
 *
 * Theming follows the customMessage palette so the block sits visually alongside
 * other agent-injected messages (task plan, skill invocation, custom messages).
 */
export class SubagentMessageComponent extends Box {
	constructor(info: SubagentInfo) {
		super(1, 1, (text) => theme.bg("customMessageBg", text));
		this.renderContent(info);
	}

	/**
	 * Replace the rendered content with updated subagent info.
	 * Call this whenever status, outputLength, durationMs, or errorMessage changes.
	 */
	update(info: SubagentInfo): void {
		this.clear();
		this.renderContent(info);
	}

	override invalidate(): void {
		super.invalidate();
	}

	private renderContent(info: SubagentInfo): void {
		// --- Header line ---
		// [subagent] or [subagent:<agent>] <profile> · <description>
		const label = theme.fg("customMessageLabel", `\x1b[1m${formatSubagentBadge(info.agent)}\x1b[22m`);
		const profileBadge = theme.fg("accent", info.profile);
		const dot = theme.fg("dim", " \u00B7 "); // middle dot separator
		const description = theme.fg("customMessageText", info.description);
		this.addChild(new Text(`${label} ${profileBadge}${dot}${description}`, 0, 0));

		this.addChild(new Spacer(1));

		// --- Status line ---
		switch (info.status) {
				case "running": {
				// Ellipsis prefix signals in-progress work without a spinner dependency
				const indicator = theme.fg("accent", "...");
				const phase = info.phase?.trim() ? info.phase.trim() : "running";
				const statusText = theme.fg("muted", ` ${phase}`);
				this.addChild(new Text(`${indicator}${statusText}`, 0, 0));

				const metadata: string[] = [];
				if (info.cwd) {
					metadata.push(theme.fg("muted", `@ ${shortenPath(info.cwd)}`));
				}
				if (info.activeTool) {
					metadata.push(theme.fg("customMessageText", `tool ${info.activeTool}`));
				}
				const toolProgress = formatToolProgress(info.toolCallsStarted, info.toolCallsCompleted);
				if (toolProgress) {
					metadata.push(theme.fg("muted", toolProgress));
				}
				if (typeof info.assistantMessages === "number" && info.assistantMessages > 0) {
					metadata.push(theme.fg("muted", `msgs ${info.assistantMessages}`));
				}
				if (info.agent) {
					metadata.push(theme.fg("muted", `agent ${info.agent}`));
				}
				if (typeof info.durationMs === "number" && info.durationMs >= 0) {
					metadata.push(theme.fg("muted", `elapsed ${formatElapsedClock(info.durationMs)}`));
				}
				if (info.isolation && info.isolation !== "none") {
					metadata.push(theme.fg("muted", `iso ${info.isolation}`));
				}
					if (info.lockKey) {
						metadata.push(theme.fg("muted", `lock ${info.lockKey}`));
					}
					if (metadata.length > 0) {
						this.addChild(new Text(metadata.join(theme.fg("dim", " \u00B7 ")), 0, 0));
					}
					const delegateSummary = summarizeDelegates(info);
					if (delegateSummary) {
						this.addChild(new Text(theme.fg("accent", formatDelegateSummary(delegateSummary)), 0, 0));
					}
					if (typeof info.delegateIndex === "number" && info.delegateIndex > 0) {
						const delegateTotal =
							typeof info.delegateTotal === "number" && info.delegateTotal > 0
								? info.delegateTotal
								: info.delegateIndex;
						const delegateParts: string[] = [theme.fg("accent", `delegate ${info.delegateIndex}/${delegateTotal}`)];
						if (typeof info.delegateDescription === "string" && info.delegateDescription.trim().length > 0) {
							delegateParts.push(theme.fg("customMessageText", info.delegateDescription.trim()));
						}
						if (typeof info.delegateProfile === "string" && info.delegateProfile.trim().length > 0) {
							delegateParts.push(theme.fg("muted", `(${info.delegateProfile.trim()})`));
						}
						this.addChild(new Text(delegateParts.join(theme.fg("dim", " \u00B7 ")), 0, 0));
					}
					if (Array.isArray(info.delegateItems) && info.delegateItems.length > 0) {
						const selected = selectDelegateItemsForDisplay(info.delegateItems);
						const headerParts = [theme.fg("muted", "delegates")];
						if (selected.compacted) {
							headerParts.push(theme.fg("accent", "compact"));
							if (selected.hiddenDonePending > 0) {
								headerParts.push(theme.fg("muted", `hidden ${selected.hiddenDonePending} done/pending`));
							}
						}
						this.addChild(new Text(headerParts.join(theme.fg("dim", " \u00B7 ")), 0, 0));
						if (selected.visibleItems.length === 0 && selected.compacted) {
							this.addChild(new Text(theme.fg("muted", "no running/failed delegates"), 0, 0));
						}
						for (const item of selected.visibleItems) {
							const marker = (() => {
								switch (item.status) {
									case "done":
										return theme.fg("success", "[x]");
									case "running":
										return theme.fg("accent", "[>]");
									case "failed":
										return theme.fg("warning", "[!]");
									default:
										return theme.fg("muted", "[ ]");
								}
							})();
							const label = `${item.index}. ${item.description} (${item.profile})`;
							const textColor =
								item.status === "done"
									? "muted"
									: item.status === "running"
										? "customMessageText"
										: item.status === "failed"
											? "warning"
											: "muted";
							this.addChild(new Text(`${marker} ${theme.fg(textColor, label)}`, 0, 0));
						}
						if (selected.overflow > 0) {
							this.addChild(new Text(theme.fg("muted", `... +${selected.overflow} more`), 0, 0));
						}
					}
					if (info.phaseState) {
						this.addChild(new Text(renderPhaseTimeline(info.phaseState), 0, 0));
					}
					break;
				}

			case "done": {
				const checkmark = theme.fg("success", "+");
				const parts: string[] = [];
				if (info.outputLength !== undefined) {
					parts.push(theme.fg("customMessageText", formatBytes(info.outputLength)) + theme.fg("muted", " output"));
				}
				if (info.durationMs !== undefined) {
					parts.push(theme.fg("muted", formatDuration(info.durationMs)));
				}
				const toolProgress = formatToolProgress(info.toolCallsStarted, info.toolCallsCompleted);
				if (toolProgress) {
					parts.push(theme.fg("muted", toolProgress));
				}
					const delegateSummary = summarizeDelegates(info);
					if (delegateSummary) {
						parts.push(theme.fg("muted", `delegates ${delegateSummary.done}/${delegateSummary.total} done`));
						if (delegateSummary.failed > 0) {
							parts.push(theme.fg("warning", `${delegateSummary.failed} failed`));
						}
					}
				if (typeof info.waitMs === "number" && info.waitMs > 0) {
					parts.push(theme.fg("muted", `queue ${formatDuration(info.waitMs)}`));
				}
				const detail = parts.length > 0 ? " " + parts.join(theme.fg("dim", ", ")) : "";
				this.addChild(new Text(`${checkmark}${detail}`, 0, 0));
				break;
			}

			case "error": {
				const cross = theme.fg("error", "x");
				const message = info.errorMessage ? info.errorMessage : "error";
				const errorText = theme.fg("error", ` ${message}`);
				this.addChild(new Text(`${cross}${errorText}`, 0, 0));
				break;
			}
		}
	}
}
