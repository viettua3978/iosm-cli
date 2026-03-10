import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Static } from "@sinclair/typebox";
import { createExternalCliTool, externalCliSchema } from "./external-cli.js";

export type JqToolInput = Static<typeof externalCliSchema>;

export function createJqTool(cwd: string): AgentTool<typeof externalCliSchema> {
	return createExternalCliTool(cwd, {
		name: "jq",
		label: "jq",
		description: "Run jq for JSON querying/transformation. Pass CLI arguments directly, optionally with stdin.",
		commandCandidates: ["jq"],
		missingInstallHint: "Install jq (brew install jq).",
	});
}

export const jqTool = createJqTool(process.cwd());
