import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Static } from "@sinclair/typebox";
import { createExternalCliTool, externalCliSchema } from "./external-cli.js";

export type YqToolInput = Static<typeof externalCliSchema>;

export function createYqTool(cwd: string): AgentTool<typeof externalCliSchema> {
	return createExternalCliTool(cwd, {
		name: "yq",
		label: "yq",
		description: "Run yq for YAML/JSON/TOML querying/transformation. Pass CLI arguments directly, optionally with stdin.",
		commandCandidates: ["yq"],
		missingInstallHint: "Install yq (brew install yq).",
	});
}

export const yqTool = createYqTool(process.cwd());
