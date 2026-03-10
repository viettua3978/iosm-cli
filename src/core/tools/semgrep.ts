import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Static } from "@sinclair/typebox";
import { createExternalCliTool, externalCliSchema } from "./external-cli.js";

export type SemgrepToolInput = Static<typeof externalCliSchema>;

export function createSemgrepTool(cwd: string): AgentTool<typeof externalCliSchema> {
	return createExternalCliTool(cwd, {
		name: "semgrep",
		label: "semgrep",
		description:
			"Run semgrep for structural/static security analysis. Autofix flags are blocked; use edit/write tools for code changes.",
		commandCandidates: ["semgrep"],
		missingInstallHint: "Install semgrep (pipx install semgrep or pip install semgrep).",
		forbiddenArgs: ["--fix", "--autofix"],
	});
}

export const semgrepTool = createSemgrepTool(process.cwd());
