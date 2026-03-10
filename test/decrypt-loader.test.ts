import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DecryptLoader } from "../src/modes/interactive/components/decrypt-loader.js";

describe("DecryptLoader", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test("renders a cipher strip instead of leaking the plaintext message", () => {
		const loader = new DecryptLoader(
			{ requestRender: vi.fn() } as any,
			(text) => text,
			(text) => text,
			"Verifying workspace...",
		);

		const output = stripAnsi(loader.render(120).join("\n"));
		loader.stop();

		expect(output).not.toContain("Verifying");
		expect(output).not.toContain("workspace");
		expect(output).toMatch(/[!@#$%^&*<>{}\[\]|~=+?\/\\▓▒░01]/);
	});

	test("animates as a seamless moving symbol stream", () => {
		const loader = new DecryptLoader(
			{ requestRender: vi.fn() } as any,
			(text) => text,
			(text) => text,
			"Working...",
		);

		const firstFrame = stripAnsi(loader.render(120).join("\n"));
		vi.advanceTimersByTime(70);
		const secondFrame = stripAnsi(loader.render(120).join("\n"));
		loader.stop();

		expect(secondFrame).not.toBe(firstFrame);
		expect(secondFrame).not.toContain("Working");
	});

	test("re-seeds the symbol stream when the message changes without showing the new text", () => {
		const loader = new DecryptLoader(
			{ requestRender: vi.fn() } as any,
			(text) => text,
			(text) => text,
			"Working...",
		);

		const before = stripAnsi(loader.render(120).join("\n"));
		loader.setMessage("Retrying in 4s...");
		const after = stripAnsi(loader.render(120).join("\n"));
		loader.stop();

		expect(after).not.toContain("Retrying");
		expect(after).not.toContain("4s");
		expect(after).not.toBe(before);
	});
});
