import { describe, expect, it } from "vitest";
import { parseMcpAddCommand, parseMcpTargetCommand } from "../src/core/mcp/cli.js";

describe("mcp cli parser", () => {
	it("parses stdio add command with repeated args", () => {
		const parsed = parseMcpAddCommand([
			"filesystem",
			"--scope",
			"project",
			"--transport",
			"stdio",
			"--command",
			"npx",
			"--arg",
			"-y",
			"--arg",
			"@modelcontextprotocol/server-filesystem",
			"--arg",
			".",
			"--disable",
		]);

		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.name).toBe("filesystem");
		expect(parsed.value.scope).toBe("project");
		expect(parsed.value.config.transport).toBe("stdio");
		expect(parsed.value.config.command).toBe("npx");
		expect(parsed.value.config.args).toEqual(["-y", "@modelcontextprotocol/server-filesystem", "."]);
		expect(parsed.value.config.enabled).toBe(false);
	});

	it("parses http add command with headers and env", () => {
		const parsed = parseMcpAddCommand([
			"github",
			"--scope",
			"user",
			"--transport",
			"http",
			"--url",
			"https://mcp.example.com",
			"--header",
			"Authorization=Bearer ${TOKEN}",
			"--env",
			"DEBUG=1",
		]);

		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.scope).toBe("user");
		expect(parsed.value.config.transport).toBe("http");
		expect(parsed.value.config.url).toBe("https://mcp.example.com");
		expect(parsed.value.config.headers).toEqual({ Authorization: "Bearer ${TOKEN}" });
		expect(parsed.value.config.env).toEqual({ DEBUG: "1" });
	});

	it("parses target commands with scope", () => {
		const parsed = parseMcpTargetCommand(["filesystem", "--scope", "project"]);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value).toEqual({ name: "filesystem", scope: "project" });
	});

	it("rejects invalid server names", () => {
		const parsed = parseMcpAddCommand(["invalid name", "--command", "echo"]);
		expect(parsed.ok).toBe(false);
		if (parsed.ok || "help" in parsed) return;
		expect(parsed.error).toContain("Invalid server name");
	});
});
