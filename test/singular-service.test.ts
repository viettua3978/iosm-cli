import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SingularService } from "../src/core/singular.js";

describe("singular service", () => {
	let tempDir: string;
	let projectDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `iosm-singular-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		projectDir = join(tempDir, "project");
		mkdirSync(join(projectDir, "src", "account"), { recursive: true });
		mkdirSync(join(projectDir, "test"), { recursive: true });
		writeFileSync(
			join(projectDir, "src", "account", "profile.ts"),
			["export function loadProfile(userId: string) {", "  return { userId };", "}", ""].join("\n"),
			"utf8",
		);
		writeFileSync(
			join(projectDir, "test", "account-profile.test.ts"),
			["import { describe, it, expect } from 'vitest';", "describe('profile', () => { it('ok', () => expect(true).toBe(true)); });", ""].join("\n"),
			"utf8",
		);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("builds feasibility analysis with options and autosaves artifacts", async () => {
		const service = new SingularService({ cwd: projectDir });
		const result = await service.analyze({
			request: "добавить функционал личного кабинета",
			contract: {
				quality_gates: ["tests pass"],
				constraints: ["no breaking API changes"],
			},
		});

		expect(result.request).toContain("личного кабинета");
		expect(result.options).toHaveLength(3);
		expect(result.scannedFiles).toBeGreaterThan(0);
		expect(result.testFiles).toBeGreaterThan(0);
		expect(result.contractSignals.length).toBeGreaterThan(0);

		const last = service.getLastRun();
		expect(last?.runId).toBe(result.runId);
		expect(last?.analysisPath).toContain(".iosm/singular/");
	});
});
