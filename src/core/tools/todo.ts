import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";

// ============================================================================
// Types
// ============================================================================

export type TodoTaskStatus = "pending" | "in_progress" | "completed";

export interface TodoTask {
	id: string;
	subject: string;
	description?: string;
	status: TodoTaskStatus;
	/** Present continuous form shown while in_progress, e.g. "Fixing auth bug" */
	activeForm?: string;
}

type TodoTaskUpdateStatus = TodoTaskStatus | "deleted";

interface TodoTaskUpdateInput {
	id?: string;
	subject?: string;
	description?: string;
	status?: TodoTaskUpdateStatus;
	activeForm?: string;
}

// ============================================================================
// Path helper
// ============================================================================

/**
 * Returns the path to the session task file for a given working directory.
 * Uses a hash of the cwd so each project has its own task list.
 */
export function getTaskFilePath(cwd: string): string {
	const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	return join(homedir(), ".iosm", "agent", "tasks", `${hash}.json`);
}

// ============================================================================
// Internal helpers
// ============================================================================

function readTasks(filePath: string): TodoTask[] {
	if (!existsSync(filePath)) return [];
	try {
		const raw = readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) return parsed as TodoTask[];
		return [];
	} catch {
		return [];
	}
}

function writeTasks(filePath: string, tasks: TodoTask[]): void {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, JSON.stringify(tasks, null, 2), "utf8");
}

function countByStatus(tasks: TodoTask[]): Record<TodoTaskStatus, number> {
	const counts: Record<TodoTaskStatus, number> = { pending: 0, in_progress: 0, completed: 0 };
	for (const t of tasks) {
		if (t.status in counts) counts[t.status as TodoTaskStatus]++;
	}
	return counts;
}

// ============================================================================
// Schemas
// ============================================================================

const todoTaskUpdateSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Unique task identifier (e.g. '1', 'setup-db')" })),
	subject: Type.Optional(
		Type.String({
			description: "Brief imperative title (e.g. 'Fix auth bug', 'Add tests')",
		}),
	),
	description: Type.Optional(
		Type.String({ description: "Detailed description of what needs to be done" }),
	),
	status: Type.Optional(
		Type.Union(
			[
				Type.Literal("pending"),
				Type.Literal("in_progress"),
				Type.Literal("completed"),
				Type.Literal("deleted"),
			],
			{ description: "Task status. Use 'deleted' to remove a task." },
		),
	),
	activeForm: Type.Optional(
		Type.String({
			description:
				"Present continuous form shown while in_progress (e.g. 'Fixing auth bug')",
		}),
	),
});

const todoWriteSchema = Type.Object({
	tasks: Type.Optional(
		Type.Union(
			[
				Type.Array(todoTaskUpdateSchema, {
					description:
						"Tasks to create or update. Merged with existing list by id. Missing id/subject fields are derived automatically.",
				}),
				Type.String({
					description:
						"Markdown checklist string (for example '- [in_progress] Audit auth'). Parsed into task objects automatically.",
				}),
			],
			{
				description:
					"Task updates as either an array of task objects or a markdown checklist string.",
			},
		),
	),
});

export type TodoWriteInput = Static<typeof todoWriteSchema>;

const todoReadSchema = Type.Object({});
export type TodoReadInput = Static<typeof todoReadSchema>;

function slugifyTaskId(text: string, fallback: string): string {
	const slug = text
		.trim()
		.toLowerCase()
		.replace(/['"`]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || fallback;
}

function normalizeTodoStatus(raw: string | undefined): TodoTaskUpdateStatus {
	if (!raw) return "pending";
	const normalized = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
	if (
		normalized === "done" ||
		normalized === "complete" ||
		normalized === "completed" ||
		normalized === "x" ||
		normalized === "checked"
	) {
		return "completed";
	}
	if (
		normalized === "in_progress" ||
		normalized === "inprogress" ||
		normalized === "doing" ||
		normalized === "active" ||
		normalized === "~"
	) {
		return "in_progress";
	}
	if (normalized === "deleted" || normalized === "delete" || normalized === "removed") {
		return "deleted";
	}
	return "pending";
}

function nextUniqueId(baseId: string, usedIds: Set<string>): string {
	let candidate = baseId;
	let suffix = 2;
	while (usedIds.has(candidate)) {
		candidate = `${baseId}-${suffix}`;
		suffix += 1;
	}
	usedIds.add(candidate);
	return candidate;
}

function parseMarkdownTaskUpdates(markdown: string): TodoTaskUpdateInput[] {
	const lines = markdown
		.split(/\r?\n/g)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const parsed: TodoTaskUpdateInput[] = [];
	for (const line of lines) {
		const checklistMatch =
			line.match(/^(?:[-*]|\d+[.)])\s*\[([^\]]+)\]\s+(.+)$/) ?? line.match(/^\[([^\]]+)\]\s+(.+)$/);
		if (checklistMatch) {
			parsed.push({
				status: normalizeTodoStatus(checklistMatch[1]),
				subject: checklistMatch[2]?.trim(),
				description: checklistMatch[2]?.trim(),
			});
			continue;
		}

		const bulletMatch = line.match(/^(?:[-*]|\d+[.)])\s+(.+)$/);
		if (bulletMatch) {
			parsed.push({
				status: "pending",
				subject: bulletMatch[1]?.trim(),
				description: bulletMatch[1]?.trim(),
			});
		}
	}
	return parsed;
}

function normalizeTaskUpdates(input: TodoWriteInput["tasks"]): Array<{
	id: string;
	subject: string;
	description?: string;
	status: TodoTaskUpdateStatus;
	activeForm?: string;
}> {
	if (input === undefined) return [];
	const rawTasks = typeof input === "string" ? parseMarkdownTaskUpdates(input) : input;
	const usedDerivedIds = new Set<string>();
	const normalized: Array<{
		id: string;
		subject: string;
		description?: string;
		status: TodoTaskUpdateStatus;
		activeForm?: string;
	}> = [];
	for (let index = 0; index < rawTasks.length; index += 1) {
		const item = rawTasks[index];
		if (!item) continue;
		const subject = item.subject?.trim() || item.description?.trim() || item.id?.trim() || `Task ${index + 1}`;
		if (!subject) continue;
		const explicitId = item.id?.trim();
		const derivedBaseId = slugifyTaskId(subject, `task-${index + 1}`);
		const id = explicitId || nextUniqueId(derivedBaseId, usedDerivedIds);
		normalized.push({
			id,
			subject,
			description: item.description?.trim() || undefined,
			status: normalizeTodoStatus(item.status),
			activeForm: item.activeForm?.trim() || undefined,
		});
	}
	return normalized;
}

// ============================================================================
// Factories (capture cwd in closure — matches codebase tool pattern)
// ============================================================================

export function createTodoWriteTool(cwd: string): AgentTool<typeof todoWriteSchema> {
	return {
		name: "todo_write",
		label: "todo_write",
		description:
			"Create or update the session task list. Use to track progress on multi-step work. Tasks persist across turns. Mark tasks in_progress before starting, completed when done. Accepts either an array of task objects or a markdown checklist string.",
		parameters: todoWriteSchema,
		execute: async (_toolCallId: string, params: unknown, _signal?: AbortSignal) => {
			const input = params as TodoWriteInput;
			const filePath = getTaskFilePath(cwd);
			const existing = readTasks(filePath);
			const normalizedTasks = normalizeTaskUpdates(input.tasks);

			if (normalizedTasks.length === 0) {
				const counts = countByStatus(existing);
				return {
					content: [
						{
							type: "text" as const,
							text: "No task updates provided. Pass tasks as an array or markdown checklist string.",
						},
					],
					details: { tasks: existing, counts },
				};
			}

			// Merge: patch by id
			const taskMap = new Map<string, TodoTask>(existing.map((t) => [t.id, t]));

			for (const incoming of normalizedTasks) {
				if (incoming.status === "deleted") {
					taskMap.delete(incoming.id);
				} else {
					const current = taskMap.get(incoming.id);
					taskMap.set(incoming.id, {
						...current,
						id: incoming.id,
						subject: incoming.subject,
						description: incoming.description ?? current?.description,
						status: incoming.status as TodoTaskStatus,
						activeForm: incoming.activeForm ?? current?.activeForm,
					});
				}
			}

			const updated = Array.from(taskMap.values());
			writeTasks(filePath, updated);

			const counts = countByStatus(updated);
			const parts: string[] = [];
			if (counts.in_progress > 0) parts.push(`${counts.in_progress} in_progress`);
			if (counts.pending > 0) parts.push(`${counts.pending} pending`);
			if (counts.completed > 0) parts.push(`${counts.completed} completed`);

			const summary = parts.length > 0 ? parts.join(", ") : "no active tasks";
			return {
				content: [
					{
						type: "text" as const,
						text: `Task list updated (${updated.length} total: ${summary})`,
					},
				],
				details: { tasks: updated, counts },
			};
		},
	};
}

export function createTodoReadTool(cwd: string): AgentTool<typeof todoReadSchema> {
	return {
		name: "todo_read",
		label: "todo_read",
		description: "Read the current session task list. Returns all tasks with their status.",
		parameters: todoReadSchema,
		execute: async (_toolCallId: string, _params: unknown, _signal?: AbortSignal) => {
			const filePath = getTaskFilePath(cwd);
			const tasks = readTasks(filePath);

			if (tasks.length === 0) {
				return {
					content: [{ type: "text" as const, text: "No tasks yet." }],
					details: { tasks: [] },
				};
			}

			const statusIcon: Record<string, string> = {
				pending: "[ ]",
				in_progress: "[~]",
				completed: "[x]",
			};

			const counts = countByStatus(tasks);
			const header = `Tasks (${tasks.length} total: ${counts.in_progress} in_progress, ${counts.pending} pending, ${counts.completed} completed)`;

			const lines = tasks.map((t) => {
				const icon = statusIcon[t.status] ?? "[ ]";
				const active =
					t.status === "in_progress" && t.activeForm ? ` — ${t.activeForm}` : "";
				return `${icon} [${t.id}] ${t.subject}${active}`;
			});

			return {
				content: [{ type: "text" as const, text: [header, ...lines].join("\n") }],
				details: { tasks, counts },
			};
		},
	};
}

// Pre-built instances using process.cwd() — for allTools registry
export const todoWriteTool = createTodoWriteTool(process.cwd());
export const todoReadTool = createTodoReadTool(process.cwd());
