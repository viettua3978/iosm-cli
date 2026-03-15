import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestRunTool } from "../src/core/tools/test-run.js";

function getTextOutput(result: any): string {
	return (
		result.content
			?.filter((item: any) => item.type === "text")
			.map((item: any) => item.text)
			.join("\n") ?? ""
	);
}

describe("test_run tool", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `iosm-test-run-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(testDir, { recursive: true });
		writeFileSync(
			join(testDir, "package.json"),
			JSON.stringify(
				{
					name: "test-run-fixture",
					version: "1.0.0",
					private: true,
					scripts: {
						test: "node -e \"console.log('tests ok')\"",
						"test:fail": "node -e \"process.exit(1)\"",
						"test:error": "node -e \"process.exit(2)\"",
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

	it("runs npm script tests and reports passed status", async () => {
		const tool = createTestRunTool(testDir);
		const result = await tool.execute("test-run-1", { runner: "npm" });
		const output = getTextOutput(result);

		expect(output).toContain("test_run status: passed");
		expect(output).toContain("runner: npm");
		expect(output).toContain("tests ok");
		expect(result.details?.status).toBe("passed");
		expect(result.details?.resolvedRunner).toBe("npm");
		expect(result.details?.exitCode).toBe(0);
	});

	it("does not throw for ordinary failing test exit code and reports failed", async () => {
		const tool = createTestRunTool(testDir);
		const result = await tool.execute("test-run-2", {
			runner: "npm",
			script: "test:fail",
		});

		expect(result.details?.status).toBe("failed");
		expect(result.details?.exitCode).toBe(1);
		expect(getTextOutput(result)).toContain("test_run status: failed");
	});

	it("maps non-standard non-zero exits to error status without throwing", async () => {
		const tool = createTestRunTool(testDir);
		const result = await tool.execute("test-run-3", {
			runner: "npm",
			script: "test:error",
		});

		expect(result.details?.status).toBe("error");
		expect(result.details?.exitCode).toBe(2);
		expect(getTextOutput(result)).toContain("test_run status: error");
	});

	it("auto-detects npm script runner when package.json has test script", async () => {
		const tool = createTestRunTool(testDir);
		const result = await tool.execute("test-run-4", { runner: "auto" });

		expect(result.details?.resolvedRunner).toBe("npm");
		expect(result.details?.status).toBe("passed");
	});

	it("throws on missing script for script-based runners", async () => {
		const tool = createTestRunTool(testDir);
		await expect(
			tool.execute("test-run-5", {
				runner: "npm",
				script: "missing:script",
			}),
		).rejects.toThrow(/not defined in package\.json/i);
	});
});

