import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type TeamTaskStatus = "pending" | "running" | "done" | "error" | "cancelled";

export interface TeamTaskRecord {
	id: string;
	agentIndex: number;
	profile: string;
	cwd: string;
	lockKey?: string;
	dependsOn: string[];
	status: TeamTaskStatus;
}

export interface TeamRunRecord {
	runId: string;
	createdAt: string;
	mode: "parallel" | "sequential";
	agents: number;
	maxParallel?: number;
	task: string;
	tasks: TeamTaskRecord[];
}

function getTeamsDir(cwd: string): string {
	return join(cwd, ".iosm", "subagents", "teams");
}

function getTeamRunPath(cwd: string, runId: string): string {
	return join(getTeamsDir(cwd), `${runId}.json`);
}

export function createTeamRun(input: {
	cwd: string;
	mode: "parallel" | "sequential";
	agents: number;
	maxParallel?: number;
	task: string;
	assignments: Array<{ profile: string; cwd: string; lockKey?: string; dependsOn: number[] }>;
}): TeamRunRecord {
	const runId = `team_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
	const tasks: TeamTaskRecord[] = input.assignments.map((assignment, index) => {
		const id = `task_${index + 1}`;
		const dependsOn = assignment.dependsOn.map((dep) => `task_${dep}`);
		return {
			id,
			agentIndex: index + 1,
			profile: assignment.profile,
			cwd: assignment.cwd,
			lockKey: assignment.lockKey,
			dependsOn,
			status: "pending",
		};
	});
	const record: TeamRunRecord = {
		runId,
		createdAt: new Date().toISOString(),
		mode: input.mode,
		agents: input.agents,
		maxParallel: input.maxParallel,
		task: input.task,
		tasks,
	};
	mkdirSync(getTeamsDir(input.cwd), { recursive: true });
	writeFileSync(getTeamRunPath(input.cwd, runId), JSON.stringify(record, null, 2), "utf8");
	return record;
}

export function getTeamRun(cwd: string, runId: string): TeamRunRecord | undefined {
	const path = getTeamRunPath(cwd, runId);
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as TeamRunRecord;
	} catch {
		return undefined;
	}
}

export function listTeamRuns(cwd: string, limit = 20): TeamRunRecord[] {
	const dir = getTeamsDir(cwd);
	if (!existsSync(dir)) return [];
	const names = readdirSync(dir)
		.filter((name) => name.toLowerCase().endsWith(".json"))
		.sort()
		.reverse()
		.slice(0, Math.max(1, limit));
	const runs: TeamRunRecord[] = [];
	for (const name of names) {
		try {
			const parsed = JSON.parse(readFileSync(join(dir, name), "utf8")) as TeamRunRecord;
			runs.push(parsed);
		} catch {
			// ignore malformed files
		}
	}
	return runs;
}

export function updateTeamTaskStatus(input: {
	cwd: string;
	runId: string;
	taskId: string;
	status: TeamTaskStatus;
}): TeamRunRecord | undefined {
	const existing = getTeamRun(input.cwd, input.runId);
	if (!existing) return undefined;

	const nextTasks = existing.tasks.map((task) =>
		task.id === input.taskId ? { ...task, status: input.status } : task,
	);
	if (!nextTasks.some((task) => task.id === input.taskId)) {
		return undefined;
	}

	const next: TeamRunRecord = {
		...existing,
		tasks: nextTasks,
	};
	try {
		mkdirSync(getTeamsDir(input.cwd), { recursive: true });
		writeFileSync(getTeamRunPath(input.cwd, input.runId), JSON.stringify(next, null, 2), "utf8");
		return next;
	} catch {
		return undefined;
	}
}
