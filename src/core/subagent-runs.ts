import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "../utils/frontmatter.js";

export interface SubagentRunRecord {
	runId: string;
	path: string;
	createdAt?: string;
	profile?: string;
	description?: string;
	cwd?: string;
	agent?: string;
	lockKey?: string;
	sessionId?: string;
	prompt?: string;
	output?: string;
}

type SubagentRunFrontmatter = {
	run_id?: unknown;
	profile?: unknown;
	description?: unknown;
	cwd?: unknown;
	agent?: unknown;
	lock_key?: unknown;
	session_id?: unknown;
	created_at?: unknown;
};

function getRunsDir(cwd: string): string {
	return join(cwd, ".iosm", "subagents", "runs");
}

function parseRunFile(path: string): SubagentRunRecord | undefined {
	let content: string;
	try {
		content = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}

	const { frontmatter, body } = parseFrontmatter<SubagentRunFrontmatter>(content);
	const runId =
		typeof frontmatter.run_id === "string" && frontmatter.run_id.trim().length > 0
			? frontmatter.run_id.trim()
			: path.split("/").pop()?.replace(/\.md$/i, "");
	if (!runId) return undefined;

	const promptMatch = body.match(/## Prompt\s+([\s\S]*?)\s+## Output\s+([\s\S]*)$/);
	const prompt = promptMatch?.[1]?.trim();
	const output = promptMatch?.[2]?.trim();

	return {
		runId,
		path,
		createdAt: typeof frontmatter.created_at === "string" ? frontmatter.created_at : undefined,
		profile: typeof frontmatter.profile === "string" ? frontmatter.profile : undefined,
		description: typeof frontmatter.description === "string" ? frontmatter.description : undefined,
		cwd: typeof frontmatter.cwd === "string" ? frontmatter.cwd : undefined,
		agent: typeof frontmatter.agent === "string" && frontmatter.agent.trim().length > 0 ? frontmatter.agent : undefined,
		lockKey:
			typeof frontmatter.lock_key === "string" && frontmatter.lock_key.trim().length > 0
				? frontmatter.lock_key
				: undefined,
		sessionId:
			typeof frontmatter.session_id === "string" && frontmatter.session_id.trim().length > 0
				? frontmatter.session_id
				: undefined,
		prompt,
		output,
	};
}

export function listSubagentRuns(cwd: string, limit = 20): SubagentRunRecord[] {
	const dir = getRunsDir(cwd);
	if (!existsSync(dir)) return [];

	const files = readdirSync(dir)
		.filter((name) => name.toLowerCase().endsWith(".md"))
		.map((name) => join(dir, name))
		.sort((a, b) => b.localeCompare(a))
		.slice(0, Math.max(1, limit));

	const runs: SubagentRunRecord[] = [];
	for (const file of files) {
		const parsed = parseRunFile(file);
		if (parsed) runs.push(parsed);
	}
	return runs;
}

export function getSubagentRun(cwd: string, runId: string): SubagentRunRecord | undefined {
	const filePath = join(getRunsDir(cwd), `${runId}.md`);
	if (existsSync(filePath)) {
		return parseRunFile(filePath);
	}

	for (const run of listSubagentRuns(cwd, 200)) {
		if (run.runId === runId) return run;
	}
	return undefined;
}
