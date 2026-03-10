import { describe, expect, it } from "vitest";
import { getSemanticCommandHelp, parseSemanticCliCommand } from "../src/core/semantic/cli.js";

describe("semantic cli parser", () => {
	it("defaults to help when no subcommand is provided", () => {
		const parsed = parseSemanticCliCommand([]);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.kind).toBe("help");
	});

	it("parses status command", () => {
		const parsed = parseSemanticCliCommand(["status"]);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value).toEqual({ kind: "status" });
	});

	it("parses query with top-k", () => {
		const parsed = parseSemanticCliCommand([
			"query",
			"where",
			"token",
			"is",
			"validated",
			"--top-k",
			"12",
		]);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value).toEqual({
			kind: "query",
			query: "where token is validated",
			topK: 12,
		});
	});

	it("rejects invalid top-k", () => {
		const parsed = parseSemanticCliCommand(["query", "auth", "--top-k", "0"]);
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.error).toContain("--top-k");
	});

	it("includes query and rebuild in help text", () => {
		const help = getSemanticCommandHelp("iosm semantic");
		expect(help).toContain("iosm semantic query");
		expect(help).toContain("iosm semantic rebuild");
	});
});
