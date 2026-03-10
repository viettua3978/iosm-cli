import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildIosmContextBlock, findIosmGuidePath, loadIosmContext, loadIosmContextFromPath } from "../src/iosm/context-loader.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0, tempDirs.length)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("iosm context loader", () => {
	it("wraps IOSM content in a structured context block", () => {
		const block = buildIosmContextBlock("# IOSM.md\n\nPrioritize logic.");

		expect(block).toContain("<iosm-context>");
		expect(block).toContain("Prioritize logic.");
		expect(block).toContain("</iosm-context>");
	});

	it("loads IOSM.md from a path and preserves the wrapped content", () => {
		const dir = mkdtempSync(join(tmpdir(), "iosm-context-"));
		tempDirs.push(dir);
		mkdirSync(join(dir, "nested"), { recursive: true });
		const guidePath = join(dir, "nested", "IOSM.md");
		writeFileSync(guidePath, "# IOSM.md\n\nKeep cycle artifacts aligned.", "utf8");

		const context = loadIosmContextFromPath(guidePath);

		expect(context).toContain("<iosm-context>");
		expect(context).toContain("Keep cycle artifacts aligned.");
	});

	it("finds the nearest IOSM.md up the directory tree", () => {
		const dir = mkdtempSync(join(tmpdir(), "iosm-context-"));
		tempDirs.push(dir);
		mkdirSync(join(dir, "workspace", "src", "feature"), { recursive: true });
		const workspaceDir = join(dir, "workspace");
		const nestedDir = join(workspaceDir, "src", "feature");
		const guidePath = join(workspaceDir, "IOSM.md");
		writeFileSync(guidePath, "# IOSM.md\n\nClimb directories.", "utf8");

		expect(findIosmGuidePath(nestedDir)).toBe(guidePath);
		expect(loadIosmContext(nestedDir)).toContain("Climb directories.");
	});
});
