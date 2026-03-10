import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Static } from "@sinclair/typebox";
import { createExternalCliTool, externalCliSchema } from "./external-cli.js";

export type FdToolInput = Static<typeof externalCliSchema>;

export function createFdTool(cwd: string): AgentTool<typeof externalCliSchema> {
	return createExternalCliTool(cwd, {
		name: "fd",
		label: "fd",
		description:
			"Run fd directly for fast file discovery. Args are passed directly to fd (no shell interpolation). Exit code 1 (no results) is treated as success.",
		commandCandidates: ["fd"],
		ensureManagedTool: "fd",
		allowExitCodes: [0, 1],
		emptyOutputMessage: "No files found",
		missingInstallHint: "Install fd or allow iosm-cli to download managed binaries.",
	});
}

export const fdTool = createFdTool(process.cwd());
