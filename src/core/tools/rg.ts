import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Static } from "@sinclair/typebox";
import { createExternalCliTool, externalCliSchema } from "./external-cli.js";

export type RgToolInput = Static<typeof externalCliSchema>;

export function createRgTool(cwd: string): AgentTool<typeof externalCliSchema> {
	return createExternalCliTool(cwd, {
		name: "rg",
		label: "rg",
		description:
			"Run ripgrep directly for advanced regex search. Args are passed directly to rg (no shell interpolation). Prefer explicit path args (for example: [\"-n\",\"--hidden\",\"score\",\".\"]). Exit code 1 (no matches) is treated as success.",
		commandCandidates: ["rg"],
		ensureManagedTool: "rg",
		allowExitCodes: [0, 1],
		emptyOutputMessage: "No matches found",
		missingInstallHint: "Install ripgrep (rg) or allow iosm-cli to download managed binaries.",
	});
}

export const rgTool = createRgTool(process.cwd());
