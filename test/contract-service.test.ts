import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContractService, ContractValidationError } from "../src/core/contract.js";

describe("contract service", () => {
	let tempDir: string;
	let projectDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `iosm-contract-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		projectDir = join(tempDir, "project");
		mkdirSync(projectDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("merges project contract with session overlay", () => {
		const service = new ContractService({ cwd: projectDir });
		service.saveProjectContract({
			goal: "Stabilize auth boundary",
			quality_gates: ["tests >= 80%"],
			constraints: ["no schema breaking changes"],
		});
		service.setSessionOverlay({
			goal: "Stabilize auth + session module",
			notes: "Focus current sprint",
		});

		const state = service.getState();
		expect(state.hasProjectFile).toBe(true);
		expect(state.project.goal).toBe("Stabilize auth boundary");
		expect(state.sessionOverlay.goal).toBe("Stabilize auth + session module");
		expect(state.effective.goal).toBe("Stabilize auth + session module");
		expect(state.effective.constraints).toEqual(["no schema breaking changes"]);
		expect(state.effective.notes).toBe("Focus current sprint");
	});

	it("validates payload with JSON schema", () => {
		const service = new ContractService({ cwd: projectDir });
		expect(() =>
			service.setSessionOverlay({
				goal: "ok",
				unexpected: true,
			} as unknown),
		).toThrow(ContractValidationError);
	});

	it("writes and clears project contract file", () => {
		const service = new ContractService({ cwd: projectDir });
		const saved = service.saveProjectContract({
			goal: "Reduce coupling",
			quality_gates: ["no TODOs"],
		});
		expect(saved.goal).toBe("Reduce coupling");
		expect(existsSync(service.getProjectPath())).toBe(true);
		const raw = readFileSync(service.getProjectPath(), "utf8");
		expect(raw).toContain("Reduce coupling");
		expect(service.clearProjectContract()).toBe(true);
		expect(existsSync(service.getProjectPath())).toBe(false);
	});
});
