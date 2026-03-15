import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLintRunTool } from "../src/core/tools/lint-run.js";

function getTextOutput(result: any): string {
	return (
		result.content
			?.filter((item: any) => item.type === "text")
			.map((item: any) => item.text)
			.join("\n") ?? ""
	);
}

describe("lint_run tool", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `iosm-lint-run-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(testDir, { recursive: true });
		writeFileSync(
			join(testDir, "package.json"),
			JSON.stringify(
				{
					name: "lint-run-fixture",
					version: "1.0.0",
					private: true,
					scripts: {
						lint: "node -e \"console.log('lint ok')\"",
						"lint:fix": "node -e \"console.log('lint fixed')\"",
						"lint:fail": "node -e \"process.exit(1)\"",
					},
				},
				null,
				2,
			),
		);
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("runs npm lint script and reports passed status", async () => {
		const tool = createLintRunTool(testDir);
		const result = await tool.execute("lint-run-1", { runner: "npm" });
		const output = getTextOutput(result);

		expect(output).toContain("lint_run status: passed");
		expect(output).toContain("runner: npm");
		expect(output).toContain("mode: check");
		expect(output).toContain("lint ok");
		expect(result.details?.status).toBe("passed");
	});

	it("uses lint:fix script by default when mode=fix for script-based runner", async () => {
		const tool = createLintRunTool(testDir);
		const result = await tool.execute("lint-run-2", { runner: "npm", mode: "fix" });
		const output = getTextOutput(result);

		expect(output).toContain("mode: fix");
		expect(output).toContain("lint fixed");
		expect(result.details?.status).toBe("passed");
	});

	it("does not throw on ordinary lint failures and reports failed status", async () => {
		const tool = createLintRunTool(testDir);
		const result = await tool.execute("lint-run-3", { runner: "npm", script: "lint:fail" });

		expect(result.details?.status).toBe("failed");
		expect(result.details?.exitCode).toBe(1);
		expect(getTextOutput(result)).toContain("lint_run status: failed");
	});

	it("blocks fix/write args in check mode", async () => {
		const tool = createLintRunTool(testDir);
		await expect(
			tool.execute("lint-run-4", {
				runner: "npm",
				mode: "check",
				args: ["--fix"],
			}),
		).rejects.toThrow(/incompatible with mode=check/i);
	});

	it("auto-detects npm lint script when available", async () => {
		const tool = createLintRunTool(testDir);
		const result = await tool.execute("lint-run-5", { runner: "auto" });

		expect(result.details?.resolvedRunner).toBe("npm");
		expect(result.details?.status).toBe("passed");
	});
});

