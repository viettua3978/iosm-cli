import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDbRunTool, type DbToolsRuntimeConfig } from "../src/core/tools/db-run.js";

function getTextOutput(result: any): string {
	return (
		result.content
			?.filter((item: any) => item.type === "text")
			.map((item: any) => item.text)
			.join("\n") ?? ""
	);
}

function createRuntimeConfig(testDir: string): DbToolsRuntimeConfig {
	return {
		defaultConnection: "main",
		connections: {
			main: {
				adapter: "postgres",
				dsnEnv: "APP_DB_DSN",
				clientArgs: ["--set", "ON_ERROR_STOP=1"],
				migrate: {
					script: "db:migrate",
					cwd: "migrations",
					args: ["--from-profile"],
				},
			},
			mongo: {
				adapter: "mongodb",
				dsnEnv: "APP_MONGO_DSN",
			},
			sqlite: {
				adapter: "sqlite",
				sqlitePath: join(testDir, "data", "app.db"),
			},
		},
	};
}

describe("db_run tool", () => {
	let testDir: string;
	let previousDbDsn: string | undefined;
	let previousMongoDsn: string | undefined;

	beforeEach(() => {
		testDir = join(tmpdir(), `iosm-db-run-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(testDir, { recursive: true });
		mkdirSync(join(testDir, "migrations"), { recursive: true });
		mkdirSync(join(testDir, "data"), { recursive: true });

		writeFileSync(
			join(testDir, "package.json"),
			JSON.stringify(
				{
					name: "db-run-fixture",
					version: "1.0.0",
					private: true,
					scripts: {
						"db:migrate": "node -e \"console.log('migrate root')\"",
					},
				},
				null,
				2,
			),
		);

		writeFileSync(
			join(testDir, "migrations", "package.json"),
			JSON.stringify(
				{
					name: "db-run-migrations",
					version: "1.0.0",
					private: true,
					scripts: {
						"db:migrate": "node -e \"console.log('migrate default')\"",
						"custom:migrate": "node -e \"console.log('migrate custom')\"",
					},
				},
				null,
				2,
			),
		);

		previousDbDsn = process.env.APP_DB_DSN;
		previousMongoDsn = process.env.APP_MONGO_DSN;
		process.env.APP_DB_DSN = "postgres://db_user:super_secret@localhost:5432/appdb?sslmode=require";
		process.env.APP_MONGO_DSN = "mongodb://mongo_user:mongo_secret@localhost:27017/app";
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
		if (previousDbDsn === undefined) {
			delete process.env.APP_DB_DSN;
		} else {
			process.env.APP_DB_DSN = previousDbDsn;
		}
		if (previousMongoDsn === undefined) {
			delete process.env.APP_MONGO_DSN;
		} else {
			process.env.APP_MONGO_DSN = previousMongoDsn;
		}
	});

	it("resolves default connection profile and executes postgres query", async () => {
		const runCommand = vi.fn().mockResolvedValue({
			stdout: "SELECT 1",
			stderr: "",
			exitCode: 0,
			captureTruncated: false,
			durationMs: 14,
		});
		const tool = createDbRunTool(testDir, {
			resolveRuntimeConfig: () => createRuntimeConfig(testDir),
			operations: {
				runCommand,
				commandExists: () => true,
			},
		});

		const result = await tool.execute("db-run-1", {
			action: "query",
			statement: "SELECT 1",
		});

		expect(runCommand).toHaveBeenCalledTimes(1);
		expect(runCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				command: "psql",
				cwd: testDir,
				args: expect.arrayContaining(["-c", "SELECT 1"]),
			}),
		);
		expect(result.details?.status).toBe("passed");
		expect(result.details?.adapter).toBe("postgres");
		expect(result.details?.connection).toBe("main");
		expect(result.details?.writeRequested).toBe(false);
		expect(result.details?.writeAllowed).toBe(false);
		expect(getTextOutput(result)).toContain("db_run status: passed");
	});

	it("enforces read-first safety by blocking mutating query statements", async () => {
		const tool = createDbRunTool(testDir, {
			resolveRuntimeConfig: () => createRuntimeConfig(testDir),
			operations: {
				runCommand: vi.fn(),
				commandExists: () => true,
			},
		});

		await expect(
			tool.execute("db-run-2", {
				action: "query",
				statement: "DELETE FROM users WHERE id = 1",
			}),
		).rejects.toThrow(/Mutating statement detected for action=query/i);
	});

	it("requires allow_write=true for exec and migrate actions", async () => {
		const tool = createDbRunTool(testDir, {
			resolveRuntimeConfig: () => createRuntimeConfig(testDir),
			operations: {
				runCommand: vi.fn(),
				commandExists: () => true,
			},
		});

		await expect(
			tool.execute("db-run-3", {
				action: "exec",
				statement: "UPDATE users SET role = 'admin'",
			}),
		).rejects.toThrow(/allow_write=true/i);

		await expect(
			tool.execute("db-run-4", {
				action: "migrate",
			}),
		).rejects.toThrow(/allow_write=true/i);
	});

	it("returns failed status on exit code 1 without throwing", async () => {
		const runCommand = vi.fn().mockResolvedValue({
			stdout: "",
			stderr: "violates constraint",
			exitCode: 1,
			captureTruncated: false,
			durationMs: 21,
		});
		const tool = createDbRunTool(testDir, {
			resolveRuntimeConfig: () => createRuntimeConfig(testDir),
			operations: {
				runCommand,
				commandExists: () => true,
			},
		});

		const result = await tool.execute("db-run-5", {
			action: "exec",
			allow_write: true,
			statement: "UPDATE users SET role = 'admin'",
		});

		expect(result.details?.status).toBe("failed");
		expect(result.details?.exitCode).toBe(1);
		expect(getTextOutput(result)).toContain("db_run status: failed");
	});

	it("supports migrate_runner=auto and migrate_runner=script with profile/script resolution", async () => {
		const runCommand = vi
			.fn()
			.mockResolvedValueOnce({
				stdout: "default migrate ok",
				stderr: "",
				exitCode: 0,
				captureTruncated: false,
				durationMs: 10,
			})
			.mockResolvedValueOnce({
				stdout: "custom migrate ok",
				stderr: "",
				exitCode: 0,
				captureTruncated: false,
				durationMs: 11,
			});
		const tool = createDbRunTool(testDir, {
			resolveRuntimeConfig: () => createRuntimeConfig(testDir),
			operations: {
				runCommand,
				commandExists: () => true,
			},
		});

		const autoResult = await tool.execute("db-run-6", {
			action: "migrate",
			allow_write: true,
			migrate_runner: "auto",
			args: ["--from-input-auto"],
		});
		expect(autoResult.details?.status).toBe("passed");
		expect(runCommand).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				command: "npm",
				cwd: join(testDir, "migrations"),
				args: ["run", "db:migrate", "--", "--from-profile", "--from-input-auto"],
			}),
		);

		const scriptResult = await tool.execute("db-run-7", {
			action: "migrate",
			allow_write: true,
			migrate_runner: "script",
			script: "custom:migrate",
			args: ["--from-input-script"],
		});
		expect(scriptResult.details?.status).toBe("passed");
		expect(runCommand).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				command: "npm",
				cwd: join(testDir, "migrations"),
				args: ["run", "custom:migrate", "--", "--from-profile", "--from-input-script"],
			}),
		);
	});

	it("redacts DSN secrets in details for network adapters", async () => {
		const runCommand = vi.fn().mockResolvedValue({
			stdout: "{ ok: 1 }",
			stderr: "",
			exitCode: 0,
			captureTruncated: false,
			durationMs: 7,
		});
		const tool = createDbRunTool(testDir, {
			resolveRuntimeConfig: () => createRuntimeConfig(testDir),
			operations: {
				runCommand,
				commandExists: () => true,
			},
		});

		const result = await tool.execute("db-run-8", {
			action: "query",
			connection: "mongo",
			statement: "db.stats()",
		});
		const redactedArgs = result.details?.resolvedArgs.join(" ") ?? "";

		expect(result.details?.adapter).toBe("mongodb");
		expect(redactedArgs).toContain("[REDACTED]");
		expect(redactedArgs).not.toContain(process.env.APP_MONGO_DSN!);
		expect(redactedArgs).not.toContain("mongo_secret");
	});

	it("fails validation when adapter override mismatches connection profile adapter", async () => {
		const tool = createDbRunTool(testDir, {
			resolveRuntimeConfig: () => createRuntimeConfig(testDir),
			operations: {
				runCommand: vi.fn(),
				commandExists: () => true,
			},
		});

		await expect(
			tool.execute("db-run-9", {
				action: "query",
				adapter: "mysql",
				statement: "SELECT 1",
			}),
		).rejects.toThrow(/does not match connection/i);
	});

	it("shows setup guidance when no connection/default connection is configured", async () => {
		const tool = createDbRunTool(testDir, {
			resolveRuntimeConfig: () => ({ connections: {} }),
			operations: {
				runCommand: vi.fn(),
				commandExists: () => true,
			},
		});

		await expect(
			tool.execute("db-run-10", {
				action: "query",
				adapter: "sqlite",
				statement: "SELECT 1",
			}),
		).rejects.toThrow(/\.iosm\/settings\.json/i);
		await expect(
			tool.execute("db-run-10b", {
				action: "query",
				adapter: "sqlite",
				statement: "SELECT 1",
			}),
		).rejects.toThrow(/sqlitePath/i);
	});

	it("explains that connection must be a profile name when a sqlite path is passed", async () => {
		const tool = createDbRunTool(testDir, {
			resolveRuntimeConfig: () => ({ connections: {} }),
			operations: {
				runCommand: vi.fn(),
				commandExists: () => true,
			},
		});

		await expect(
			tool.execute("db-run-11", {
				action: "query",
				adapter: "sqlite",
				connection: "./test_database.sqlite",
				statement: "SELECT 1",
			}),
		).rejects.toThrow(/expects a profile name, not a file path/i);
	});
});
