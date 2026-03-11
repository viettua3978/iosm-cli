import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildProjectIndex,
	collectChangedFilesSince,
	queryProjectIndex,
	saveProjectIndex,
	loadProjectIndex,
} from "../src/core/project-index/index.js";

describe("project index", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `iosm-project-index-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(tempDir, "src", "auth"), { recursive: true });
		mkdirSync(join(tempDir, "test"), { recursive: true });
		writeFileSync(
			join(tempDir, "src", "auth", "token.ts"),
			[
				"import { verify } from './verify';",
				"export function validateToken(token: string) {",
				"  return verify(token);",
				"}",
				"",
			].join("\n"),
			"utf8",
		);
		writeFileSync(join(tempDir, "test", "token.test.ts"), "describe('token', () => {});\n", "utf8");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("indexes source files and answers query matches", () => {
		const index = buildProjectIndex(tempDir, { maxFiles: 1000 });
		expect(index.meta.totalFiles).toBeGreaterThan(0);
		expect(index.meta.sourceFiles).toBeGreaterThan(0);

		const result = queryProjectIndex(index, "token validation auth", 5);
		expect(result.matches.length).toBeGreaterThan(0);
		expect(result.matches[0]?.path).toContain("token.ts");
	});

	it("detects changed files against saved index", () => {
		const first = buildProjectIndex(tempDir, { maxFiles: 1000 });
		saveProjectIndex(tempDir, first);
		expect(loadProjectIndex(tempDir)?.entries.length).toBe(first.entries.length);

		const target = join(tempDir, "src", "auth", "token.ts");
		const now = Date.now() / 1000;
		utimesSync(target, now + 60, now + 60);

		const changed = collectChangedFilesSince(first, tempDir);
		expect(changed.some((item) => item.endsWith("src/auth/token.ts"))).toBe(true);
	});
});
