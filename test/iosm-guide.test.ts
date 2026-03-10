import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildIosmPriorityChecklist, writeIosmGuideDocument } from "../src/iosm/guide.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0, tempDirs.length)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("iosm guide", () => {
	it("builds priorities from weakest metrics first", () => {
		const checklist = buildIosmPriorityChecklist(
			{
				semantic: 0.8,
				logic: 0.41,
				performance: 0.5,
				simplicity: 0.91,
				modularity: 0.63,
				flow: 0.2,
			},
			3,
		);

		expect(checklist.length).toBe(3);
		expect(checklist[0].metric).toBe("flow");
		expect(checklist[1].metric).toBe("logic");
		expect(checklist[2].metric).toBe("performance");
	});

	it("writes IOSM.md playbook with links and checklist", () => {
		const dir = mkdtempSync(join(tmpdir(), "iosm-guide-"));
		tempDirs.push(dir);

		const write = writeIosmGuideDocument(
			{
				rootDir: dir,
				cycleId: "iosm-2026-03-06-001",
				assessmentSource: "verified",
				metrics: {
					semantic: 0.7,
					logic: 0.4,
					performance: 0.5,
					simplicity: 0.8,
					modularity: 0.72,
					flow: 0.3,
				},
				iosmIndex: 0.57,
				decisionConfidence: 0.66,
				goals: ["Improve test coverage", "Enable CI"],
				filesAnalyzed: 25,
				sourceFileCount: 16,
				testFileCount: 0,
				docFileCount: 2,
				tracePath: "/tmp/trace.jsonl",
			},
			true,
		);

		expect(write.written).toBe(true);
		const content = readFileSync(write.path, "utf8");
		expect(content).toContain("# IOSM.md");
		expect(content).toContain("## Priority Actions");
		expect(content).toContain("## IOSM Workspace");
		expect(content).toContain("iosm-2026-03-06-001");
		expect(content).toContain("re-read this file");
	});
});
