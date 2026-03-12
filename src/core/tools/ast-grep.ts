import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Static } from "@sinclair/typebox";
import { createExternalCliTool, externalCliSchema } from "./external-cli.js";

export type AstGrepToolInput = Static<typeof externalCliSchema>;

export function createAstGrepTool(cwd: string): AgentTool<typeof externalCliSchema> {
	return createExternalCliTool(cwd, {
		name: "ast_grep",
		label: "ast-grep",
		description:
			"Run ast-grep (sg) for syntax-aware code queries. Pass CLI args directly. Preferred form: [\"run\",\"--pattern\",\"console.log($A)\",\"--lang\",\"javascript\",\"src\"]. If version syntax differs, retry with scan/-p equivalents.",
		commandCandidates: ["ast-grep", "sg"],
		missingInstallHint: "Install ast-grep (brew install ast-grep or npm i -g @ast-grep/cli).",
		forbiddenArgs: ["-i", "--interactive", "-U", "--update-all"],
		forbiddenArgPrefixes: ["--update-all="],
	});
}

export const astGrepTool = createAstGrepTool(process.cwd());
