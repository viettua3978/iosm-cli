import { describe, expect, it } from "vitest";
import { parseUltrathinkCommand } from "../src/core/ultrathink.js";

describe("parseUltrathinkCommand", () => {
	it("returns undefined for non-ultrathink inputs", () => {
		expect(parseUltrathinkCommand("hello")).toBeUndefined();
		expect(parseUltrathinkCommand("/model")).toBeUndefined();
	});

	it("parses /ultrathink with defaults", () => {
		const parsed = parseUltrathinkCommand("/ultrathink");
		expect(parsed).toEqual({
			kind: "command",
			command: { iterations: 5, query: undefined },
		});
	});

	it("parses explicit query", () => {
		const parsed = parseUltrathinkCommand("/ultrathink investigate flaky auth tests");
		expect(parsed).toEqual({
			kind: "command",
			command: { iterations: 5, query: "investigate flaky auth tests" },
		});
	});

	it("parses -q and --iterations variants", () => {
		expect(parseUltrathinkCommand("/ultrathink -q 7 auth regression")).toEqual({
			kind: "command",
			command: { iterations: 7, query: "auth regression" },
		});
		expect(parseUltrathinkCommand('/ultrathink --iterations 9 "audit storage layer"')).toEqual({
			kind: "command",
			command: { iterations: 9, query: "audit storage layer" },
		});
		expect(parseUltrathinkCommand("/ultrathink -q=4")).toEqual({
			kind: "command",
			command: { iterations: 4, query: undefined },
		});
		expect(parseUltrathinkCommand("/ultrathink --iterations=6")).toEqual({
			kind: "command",
			command: { iterations: 6, query: undefined },
		});
	});

	it("supports -- separator when query starts with '-'", () => {
		const parsed = parseUltrathinkCommand("/ultrathink -q 3 -- --check --deep");
		expect(parsed).toEqual({
			kind: "command",
			command: { iterations: 3, query: "--check --deep" },
		});
	});

	it("reports missing iteration value", () => {
		const parsed = parseUltrathinkCommand("/ultrathink -q");
		expect(parsed?.kind).toBe("error");
		if (parsed?.kind === "error") {
			expect(parsed.error).toContain("Missing value");
			expect(parsed.usage).toContain("/ultrathink");
		}
	});

	it("reports invalid iteration values", () => {
		const invalidValues = ["/ultrathink -q 0", "/ultrathink -q 13", "/ultrathink -q abc"];
		for (const command of invalidValues) {
			const parsed = parseUltrathinkCommand(command);
			expect(parsed?.kind).toBe("error");
			if (parsed?.kind === "error") {
				expect(parsed.error).toContain("Invalid iteration count");
			}
		}
	});

	it("reports unknown flags", () => {
		const parsed = parseUltrathinkCommand("/ultrathink --unknown foo");
		expect(parsed?.kind).toBe("error");
		if (parsed?.kind === "error") {
			expect(parsed.error).toContain("Unknown option");
		}
	});
});
