import { describe, expect, it } from "vitest";
import { createAstGrepTool } from "../src/core/tools/ast-grep.js";
import { createYqTool } from "../src/core/tools/yq.js";

describe("external CLI mutation guards", () => {
	it("blocks yq mutation flags in read-oriented workflows", async () => {
		const tool = createYqTool(process.cwd());
		const blockedArgs = [
			["-i", ".a = 1", "config.yml"],
			["--inplace", ".a = 1", "config.yml"],
			["--in-place", ".a = 1", "config.yml"],
			["-i=.bak", ".a = 1", "config.yml"],
			["--split-exp", "out-${index}.yml", "config.yml"],
		];

		for (const args of blockedArgs) {
			await expect(tool.execute("yq_guard", { args })).rejects.toThrow(/not allowed/i);
		}
	});

	it("blocks ast-grep mutation flags while keeping scan/query usage", async () => {
		const tool = createAstGrepTool(process.cwd());
		const blockedArgs = [
			["run", "--pattern", "foo($A)", "--lang", "javascript", "-U", "src"],
			["run", "--pattern", "foo($A)", "--lang", "javascript", "--update-all", "src"],
			["run", "--pattern", "foo($A)", "--lang", "javascript", "--update-all=true", "src"],
			["scan", "--interactive", "."],
		];

		for (const args of blockedArgs) {
			await expect(tool.execute("ast_guard", { args })).rejects.toThrow(/not allowed/i);
		}
	});
});
