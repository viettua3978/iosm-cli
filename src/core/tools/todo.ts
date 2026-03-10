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

const todoWriteSchema = Type.Object({
	tasks: Type.Array(
		Type.Object({
			id: Type.String({ description: "Unique task identifier (e.g. '1', 'setup-db')" }),
			subject: Type.String({
				description: "Brief imperative title (e.g. 'Fix auth bug', 'Add tests')",
			}),
			description: Type.Optional(
				Type.String({ description: "Detailed description of what needs to be done" }),
			),
			status: Type.Union(
				[
					Type.Literal("pending"),
					Type.Literal("in_progress"),
					Type.Literal("completed"),
					Type.Literal("deleted"),
				],
				{ description: "Task status. Use 'deleted' to remove a task." },
			),
			activeForm: Type.Optional(
				Type.String({
					description:
						"Present continuous form shown while in_progress (e.g. 'Fixing auth bug')",
				}),
			),
		}),
		{ description: "Tasks to create or update. Merged with existing list by id." },
	),
});

export type TodoWriteInput = Static<typeof todoWriteSchema>;

const todoReadSchema = Type.Object({});
export type TodoReadInput = Static<typeof todoReadSchema>;

// ============================================================================
// Factories (capture cwd in closure — matches codebase tool pattern)
// ============================================================================

export function createTodoWriteTool(cwd: string): AgentTool<typeof todoWriteSchema> {
	return {
		name: "todo_write",
		label: "todo_write",
		description:
			"Create or update the session task list. Use to track progress on multi-step work. Tasks persist across turns. Mark tasks in_progress before starting, completed when done.",
		parameters: todoWriteSchema,
		execute: async (_toolCallId: string, params: unknown, _signal?: AbortSignal) => {
			const input = params as TodoWriteInput;
			const filePath = getTaskFilePath(cwd);
			const existing = readTasks(filePath);

			// Merge: patch by id
			const taskMap = new Map<string, TodoTask>(existing.map((t) => [t.id, t]));

			for (const incoming of input.tasks) {
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
