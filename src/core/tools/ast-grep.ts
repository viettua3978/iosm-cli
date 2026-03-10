import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Static } from "@sinclair/typebox";
import { createExternalCliTool, externalCliSchema } from "./external-cli.js";

export type AstGrepToolInput = Static<typeof externalCliSchema>;

export function createAstGrepTool(cwd: string): AgentTool<typeof externalCliSchema> {
	return createExternalCliTool(cwd, {
		name: "ast_grep",
		label: "ast-grep",
		description:
			"Run ast-grep (sg) for syntax-aware code queries. Pass CLI arguments directly (for example: [\"scan\",\"--pattern\",\"console.log($A)\",\"src\"]).",
		commandCandidates: ["ast-grep", "sg"],
		missingInstallHint: "Install ast-grep (brew install ast-grep or npm i -g @ast-grep/cli).",
	});
}

export const astGrepTool = createAstGrepTool(process.cwd());
