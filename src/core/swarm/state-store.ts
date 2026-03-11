import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SwarmEvent, SwarmPlan, SwarmRunMeta, SwarmRuntimeState } from "./types.js";

function writeJson(filePath: string, payload: unknown): void {
	writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function readJson<T>(filePath: string): T | undefined {
	if (!existsSync(filePath)) return undefined;
	try {
		return JSON.parse(readFileSync(filePath, "utf8")) as T;
	} catch {
		return undefined;
	}
}

export interface SwarmReportsPayload {
	integrationReport: string;
	gates: Record<string, unknown>;
	sharedContext: string;
}

export class SwarmStateStore {
	private readonly rootDir: string;
	private readonly reportsDir: string;

	constructor(private readonly cwd: string, private readonly runId: string) {
		this.rootDir = join(cwd, ".iosm", "orchestrate", runId);
		this.reportsDir = join(this.rootDir, "reports");
	}

	getRunDir(): string {
		return this.rootDir;
	}

	getStatePath(): string {
		return join(this.rootDir, "state.json");
	}

	private getRunPath(): string {
		return join(this.rootDir, "run.json");
	}

	private getDagPath(): string {
		return join(this.rootDir, "dag.json");
	}

	private getEventsPath(): string {
		return join(this.rootDir, "events.jsonl");
	}

	private getCheckpointPath(): string {
		return join(this.rootDir, "checkpoints", "latest.json");
	}

	init(meta: SwarmRunMeta, plan: SwarmPlan, state: SwarmRuntimeState): void {
		mkdirSync(join(this.rootDir, "checkpoints"), { recursive: true });
		mkdirSync(this.reportsDir, { recursive: true });
		writeJson(this.getRunPath(), meta);
		writeJson(this.getDagPath(), plan);
		this.saveState(state);
		this.saveCheckpoint(state);
	}

	appendEvent(event: SwarmEvent): void {
		mkdirSync(this.rootDir, { recursive: true });
		writeFileSync(this.getEventsPath(), `${JSON.stringify(event)}\n`, {
			encoding: "utf8",
			flag: "a",
		});
	}

	saveState(state: SwarmRuntimeState): void {
		mkdirSync(this.rootDir, { recursive: true });
		writeJson(this.getStatePath(), state);
	}

	saveCheckpoint(state: SwarmRuntimeState): void {
		mkdirSync(join(this.rootDir, "checkpoints"), { recursive: true });
		writeJson(this.getCheckpointPath(), {
			savedAt: new Date().toISOString(),
			state,
		});
	}

	loadMeta(): SwarmRunMeta | undefined {
		return readJson<SwarmRunMeta>(this.getRunPath());
	}

	loadPlan(): SwarmPlan | undefined {
		return readJson<SwarmPlan>(this.getDagPath());
	}

	saveMeta(meta: SwarmRunMeta): void {
		mkdirSync(this.rootDir, { recursive: true });
		writeJson(this.getRunPath(), meta);
	}

	savePlan(plan: SwarmPlan): void {
		mkdirSync(this.rootDir, { recursive: true });
		writeJson(this.getDagPath(), plan);
	}

	loadState(): SwarmRuntimeState | undefined {
		return readJson<SwarmRuntimeState>(this.getStatePath());
	}

	writeReports(payload: SwarmReportsPayload): void {
		mkdirSync(this.reportsDir, { recursive: true });
		writeFileSync(join(this.reportsDir, "integration_report.md"), `${payload.integrationReport.trim()}\n`, "utf8");
		writeJson(join(this.reportsDir, "gates.json"), payload.gates);
		writeFileSync(join(this.reportsDir, "shared_context.md"), `${payload.sharedContext.trim()}\n`, "utf8");
	}

	static listRuns(cwd: string, limit = 20): Array<{ runId: string; runPath: string; statePath: string }> {
		const root = join(cwd, ".iosm", "orchestrate");
		if (!existsSync(root)) return [];
		const names = readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort((a, b) => b.localeCompare(a))
			.slice(0, Math.max(1, limit));
		return names.map((runId) => ({
			runId,
			runPath: join(root, runId, "run.json"),
			statePath: join(root, runId, "state.json"),
		}));
	}
}
