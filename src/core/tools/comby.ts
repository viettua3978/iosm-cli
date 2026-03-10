import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Static } from "@sinclair/typebox";
import { createExternalCliTool, externalCliSchema } from "./external-cli.js";

export type CombyToolInput = Static<typeof externalCliSchema>;

export function createCombyTool(cwd: string): AgentTool<typeof externalCliSchema> {
	return createExternalCliTool(cwd, {
		name: "comby",
		label: "comby",
		description:
			"Run comby for structural search/rewrite previews. Prefer explicit matcher when language is known (for example: [\"pattern\", \"rewrite\", \"-matcher\", \".python\", \"src\"]). In-place flags are blocked; use edit/write tools for actual file mutations.",
		commandCandidates: ["comby"],
		missingInstallHint: "Install comby (brew install comby).",
		forbiddenArgs: ["-i", "--in-place", "-in-place"],
		forbiddenArgPrefixes: ["-i="],
	});
}

export const combyTool = createCombyTool(process.cwd());
