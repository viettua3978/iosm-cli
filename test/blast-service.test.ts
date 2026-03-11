import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlastService } from "../src/core/blast.js";

describe("blast service", () => {
	let tempDir: string;
	let projectDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `iosm-blast-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		projectDir = join(tempDir, "project");
		mkdirSync(join(projectDir, "src"), { recursive: true });
		writeFileSync(
			join(projectDir, "src", "auth.ts"),
			[
				"export function validate(token: string) {",
				"  // TODO remove debug",
				"  console.log(token);",
				"  return eval(token);",
				"}",
				"",
			].join("\n"),
			"utf8",
		);
		writeFileSync(
			join(projectDir, "src", "types.ts"),
			[
				"export type RawValue = any;",
				"// @ts-ignore temporary suppression",
				"export const value: any = 1;",
				"",
			].join("\n"),
			"utf8",
		);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("runs quick audit and persists artifacts by default", async () => {
		const service = new BlastService({ cwd: projectDir });
		const result = await service.run({ profile: "quick" });

		expect(result.profile).toBe("quick");
		expect(result.scannedFiles).toBeGreaterThan(0);
		expect(result.findings.length).toBeGreaterThan(0);
		expect(result.autosaved).toBe(true);
		expect(result.reportPath).toContain(".iosm/audits/");
		expect(result.findingsPath).toContain(".iosm/audits/");

		const last = service.getLastRun();
		expect(last?.runId).toBe(result.runId);
		expect(last?.reportPath).toBe(result.reportPath);
		expect(last?.findingsPath).toBe(result.findingsPath);
	});

	it("applies contract gate heuristics", async () => {
		const service = new BlastService({ cwd: projectDir });
		const result = await service.run({
			profile: "quick",
			autosave: false,
			contract: {
				quality_gates: ["tests required", "no TODO"],
			},
		});

		expect(result.autosaved).toBe(false);
		expect(result.findings.some((finding) => finding.id === "contract:tests-missing")).toBe(true);
		expect(result.findings.some((finding) => finding.id === "contract:todo-mismatch")).toBe(true);
	});
});
