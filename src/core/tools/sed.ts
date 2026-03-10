import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Static } from "@sinclair/typebox";
import { createExternalCliTool, externalCliSchema } from "./external-cli.js";

export type SedToolInput = Static<typeof externalCliSchema>;

export function createSedTool(cwd: string): AgentTool<typeof externalCliSchema> {
	return createExternalCliTool(cwd, {
		name: "sed",
		label: "sed",
		description:
			"Run sed for stream editing/extraction. In-place flags are blocked; use edit/write tools for persistent file changes.",
		commandCandidates: ["sed"],
		missingInstallHint: "Install GNU sed if unavailable (brew install gnu-sed).",
		forbiddenArgs: ["-i", "--in-place"],
		forbiddenArgPrefixes: ["-i"],
	});
}

export const sedTool = createSedTool(process.cwd());
