import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { resolveToCwd } from "./path-utils.js";
import type { ToolPermissionGuard } from "./permissions.js";
import type { TruncationResult } from "./truncate.js";
import {
	commandExists,
	detectPackageManager,
	ensureCommandOrThrow,
	formatVerificationOutput,
	readPackageJson,
	resolvePackageManagerRunInvocation,
	runVerificationCommand,
	type RunVerificationCommandInput,
	type VerificationCommandResult,
} from "./verification-runner.js";

const dbRunSchema = Type.Object({
	action: Type.Optional(
		Type.Union(
			[
				Type.Literal("query"),
				Type.Literal("exec"),
				Type.Literal("schema"),
				Type.Literal("migrate"),
				Type.Literal("explain"),
			],
			{ description: "DB action: query | exec | schema | migrate | explain (default: query)." },
		),
	),
	adapter: Type.Optional(
		Type.Union(
			[
				Type.Literal("auto"),
				Type.Literal("postgres"),
				Type.Literal("mysql"),
				Type.Literal("sqlite"),
				Type.Literal("mongodb"),
				Type.Literal("redis"),
			],
			{ description: "Database adapter: auto | postgres | mysql | sqlite | mongodb | redis" },
		),
	),
	connection: Type.Optional(
		Type.String({
			description: "Named dbTools connection profile. Defaults to dbTools.defaultConnection.",
		}),
	),
	statement: Type.Optional(
		Type.String({
			description: "Query/command statement for query/exec/explain (optional for schema with adapter defaults).",
		}),
	),
	format: Type.Optional(
		Type.Union([Type.Literal("table"), Type.Literal("json"), Type.Literal("raw")], {
			description: "Output format hint: table | json | raw (default: table).",
		}),
	),
	allow_write: Type.Optional(
		Type.Boolean({
			description: "Allow write actions (required for exec/migrate). Defaults to false.",
		}),
	),
	migrate_runner: Type.Optional(
		Type.Union([Type.Literal("auto"), Type.Literal("script")], {
			description: "Migrate mode: auto | script (default: auto).",
		}),
	),
	script: Type.Optional(
		Type.String({
			description: "Package script for migrate_runner=script/auto (default: db:migrate).",
		}),
	),
	args: Type.Optional(
		Type.Array(Type.String(), {
			description: "Additional arguments forwarded to adapter CLI or migration script.",
		}),
	),
	path: Type.Optional(Type.String({ description: "Working directory for db operations (default: current directory)." })),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 300)." })),
});

export type DbRunToolInput = Static<typeof dbRunSchema>;
export type DbRunAction = "query" | "exec" | "schema" | "migrate" | "explain";
export type DbRunAdapter = "auto" | "postgres" | "mysql" | "sqlite" | "mongodb" | "redis";
export type DbRunResolvedAdapter = Exclude<DbRunAdapter, "auto">;
export type DbRunFormat = "table" | "json" | "raw";
export type DbRunMigrateRunner = "auto" | "script";
export type DbRunStatus = "passed" | "failed" | "error";

export interface DbToolsMigrateConfig {
	script?: string;
	cwd?: string;
	args?: string[];
}

export interface DbToolsConnectionConfig {
	adapter?: DbRunResolvedAdapter;
	dsnEnv?: string;
	sqlitePath?: string;
	clientArgs?: string[];
	migrate?: DbToolsMigrateConfig;
}

export interface DbToolsRuntimeConfig {
	defaultConnection?: string;
	connections?: Record<string, DbToolsConnectionConfig>;
}

export interface DbRunToolDetails {
	action: DbRunAction;
	adapter: DbRunResolvedAdapter;
	connection: string;
	resolvedCommand: string;
	resolvedArgs: string[];
	cwd: string;
	exitCode: number;
	status: DbRunStatus;
	durationMs: number;
	rowCount?: number;
	affectedCount?: number;
	writeRequested: boolean;
	writeAllowed: boolean;
	captureTruncated?: boolean;
	truncation?: TruncationResult;
}

interface ResolvedConnectionProfile {
	name: string;
	adapter: DbRunResolvedAdapter;
	dsnEnv?: string;
	sqlitePath?: string;
	clientArgs: string[];
	migrate: {
		script?: string;
		cwd?: string;
		args: string[];
	};
}

interface ResolvedDbCommand {
	command: string;
	args: string[];
	env?: NodeJS.ProcessEnv;
	stdin?: string;
	secretValues: string[];
}

interface DbRunOperations {
	runCommand: (input: RunVerificationCommandInput) => Promise<VerificationCommandResult>;
	commandExists: (command: string) => boolean;
}

export interface DbRunToolOptions {
	permissionGuard?: ToolPermissionGuard;
	resolveRuntimeConfig?: () => Partial<DbToolsRuntimeConfig> | DbToolsRuntimeConfig;
	operations?: Partial<DbRunOperations>;
}

export const DEFAULT_DB_RUN_TIMEOUT_SECONDS = 300;

const defaultOps: DbRunOperations = {
	runCommand: runVerificationCommand,
	commandExists,
};

function normalizeTimeoutSeconds(raw: number | undefined): number {
	if (raw === undefined) return DEFAULT_DB_RUN_TIMEOUT_SECONDS;
	const value = Math.floor(raw);
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error("timeout must be a positive number.");
	}
	return value;
}

function normalizeStringArray(raw: string[] | undefined): string[] {
	return (raw ?? []).map((item) => String(item));
}

function normalizeAction(raw: DbRunAction | undefined): DbRunAction {
	return raw ?? "query";
}

function normalizeFormat(raw: DbRunFormat | undefined): DbRunFormat {
	return raw ?? "table";
}

function normalizeScriptName(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	const script = raw.trim();
	if (!script) {
		throw new Error("script must not be empty.");
	}
	return script;
}

function normalizeConnectionName(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	const value = raw.trim();
	if (!value) {
		throw new Error("connection must not be empty.");
	}
	return value;
}

function normalizeRuntimeConfig(raw: Partial<DbToolsRuntimeConfig> | DbToolsRuntimeConfig | undefined): {
	defaultConnection?: string;
	connections: Record<string, ResolvedConnectionProfile>;
} {
	const connections: Record<string, ResolvedConnectionProfile> = {};
	for (const [name, connection] of Object.entries(raw?.connections ?? {})) {
		const normalizedName = name.trim();
		if (!normalizedName) continue;
		const adapter = connection?.adapter;
		if (
			adapter !== "postgres" &&
			adapter !== "mysql" &&
			adapter !== "sqlite" &&
			adapter !== "mongodb" &&
			adapter !== "redis"
		) {
			continue;
		}

		connections[normalizedName] = {
			name: normalizedName,
			adapter,
			dsnEnv: connection?.dsnEnv?.trim() || undefined,
			sqlitePath: connection?.sqlitePath?.trim() || undefined,
			clientArgs: normalizeStringArray(connection?.clientArgs),
			migrate: {
				script: connection?.migrate?.script?.trim() || undefined,
				cwd: connection?.migrate?.cwd?.trim() || undefined,
				args: normalizeStringArray(connection?.migrate?.args),
			},
		};
	}

	const defaultConnection = raw?.defaultConnection?.trim() || undefined;
	return { defaultConnection, connections };
}

function isLikelyPathLikeConnection(value: string): boolean {
	const normalized = value.trim();
	if (!normalized) return false;
	if (normalized.includes("/") || normalized.includes("\\") || normalized.startsWith(".") || normalized.startsWith("~")) {
		return true;
	}
	return /\.(sqlite|sqlite3|db)$/i.test(normalized) || normalized.includes(":memory:");
}

function buildDbToolsSetupHint(sqlitePathHint: string): string {
	return [
		'Configure a named profile in ".iosm/settings.json", for example:',
		"{",
		'  "dbTools": {',
		'    "defaultConnection": "main",',
		'    "connections": {',
		`      "main": { "adapter": "sqlite", "sqlitePath": "${sqlitePathHint}" }`,
		"    }",
		"  }",
		"}",
		'Then call db_run with connection="main" (or omit connection when defaultConnection is set).',
		"If you edited settings.json outside the current session, run /reload or restart the session before retrying.",
	].join("\n");
}

function resolveConnectionProfile(input: {
	runtimeConfig: { defaultConnection?: string; connections: Record<string, ResolvedConnectionProfile> };
	connection?: string;
	adapter: DbRunAdapter;
}): ResolvedConnectionProfile {
	const effectiveConnection = normalizeConnectionName(input.connection) ?? input.runtimeConfig.defaultConnection;
	if (!effectiveConnection) {
		throw new Error(
			[
				"No db connection selected. Configure dbTools.defaultConnection or pass connection explicitly.",
				buildDbToolsSetupHint("./test_database.sqlite"),
			].join("\n\n"),
		);
	}
	const profile = input.runtimeConfig.connections[effectiveConnection];
	if (!profile) {
		if (isLikelyPathLikeConnection(effectiveConnection)) {
			throw new Error(
				[
					`Connection profile "${effectiveConnection}" is not defined in settings dbTools.connections.`,
					`The "connection" field expects a profile name, not a file path.`,
					buildDbToolsSetupHint(effectiveConnection),
				].join("\n\n"),
			);
		}
		throw new Error(
			[
				`Connection profile "${effectiveConnection}" is not defined in settings dbTools.connections.`,
				buildDbToolsSetupHint("./test_database.sqlite"),
			].join("\n\n"),
		);
	}

	if (input.adapter !== "auto" && input.adapter !== profile.adapter) {
		throw new Error(
			`Adapter "${input.adapter}" does not match connection "${effectiveConnection}" adapter "${profile.adapter}".`,
		);
	}

	if (profile.adapter === "sqlite") {
		if (!profile.sqlitePath) {
			throw new Error(`Connection "${effectiveConnection}" requires sqlitePath for sqlite adapter.`);
		}
	} else if (!profile.dsnEnv) {
		throw new Error(`Connection "${effectiveConnection}" requires dsnEnv for ${profile.adapter} adapter.`);
	}

	return profile;
}

function ensureWriteAllowed(action: DbRunAction, allowWrite: boolean): void {
	if ((action === "exec" || action === "migrate") && !allowWrite) {
		throw new Error(`Action "${action}" requires allow_write=true.`);
	}
}

function normalizeStatement(statement: string | undefined): string | undefined {
	if (statement === undefined) return undefined;
	const normalized = statement.trim();
	if (!normalized) {
		throw new Error("statement must not be empty when provided.");
	}
	return normalized;
}

function isLikelyMutatingSql(statement: string): boolean {
	return /\b(insert|update|delete|drop|alter|create|truncate|replace|grant|revoke|merge|upsert)\b/i.test(statement);
}

function isLikelyMutatingMongo(statement: string): boolean {
	return /\b(insert|update|delete|drop|create|rename|set|remove|replace|findOneAndUpdate|findAndModify)\b/i.test(statement);
}

function isLikelyMutatingRedis(statement: string): boolean {
	const firstToken = statement.trim().split(/\s+/)[0]?.toUpperCase() ?? "";
	const mutatingCommands = new Set([
		"SET",
		"DEL",
		"HSET",
		"HDEL",
		"LPUSH",
		"RPUSH",
		"SADD",
		"SREM",
		"ZADD",
		"ZREM",
		"INCR",
		"DECR",
		"FLUSHDB",
		"FLUSHALL",
		"EXPIRE",
		"PERSIST",
	]);
	return mutatingCommands.has(firstToken);
}

function enforceReadFirstSafety(adapter: DbRunResolvedAdapter, action: DbRunAction, statement: string | undefined): void {
	if (action !== "query" || !statement) return;
	if (adapter === "postgres" || adapter === "mysql" || adapter === "sqlite") {
		if (isLikelyMutatingSql(statement)) {
			throw new Error('Mutating statement detected for action=query. Use action="exec" with allow_write=true.');
		}
		return;
	}
	if (adapter === "mongodb" && isLikelyMutatingMongo(statement)) {
		throw new Error('Mutating statement detected for action=query. Use action="exec" with allow_write=true.');
	}
	if (adapter === "redis" && isLikelyMutatingRedis(statement)) {
		throw new Error('Mutating statement detected for action=query. Use action="exec" with allow_write=true.');
	}
}

function parseDsn(dsn: string, adapter: DbRunResolvedAdapter): URL {
	try {
		const parsed = new URL(dsn);
		const protocol = parsed.protocol.replace(":", "");
		if (adapter === "postgres" && protocol !== "postgres" && protocol !== "postgresql") {
			throw new Error("Expected postgres:// or postgresql:// DSN.");
		}
		if (adapter === "mysql" && protocol !== "mysql" && protocol !== "mariadb") {
			throw new Error("Expected mysql:// or mariadb:// DSN.");
		}
		if (adapter === "mongodb" && protocol !== "mongodb" && protocol !== "mongodb+srv") {
			throw new Error("Expected mongodb:// or mongodb+srv:// DSN.");
		}
		if (adapter === "redis" && protocol !== "redis" && protocol !== "rediss") {
			throw new Error("Expected redis:// or rediss:// DSN.");
		}
		return parsed;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid DSN for ${adapter}: ${message}`);
	}
}

function resolveSqlStatement(adapter: "postgres" | "mysql" | "sqlite", action: DbRunAction, statement: string | undefined): string {
	const schemaDefaults: Record<"postgres" | "mysql" | "sqlite", string> = {
		postgres:
			"SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1,2;",
		mysql:
			"SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY 1,2;",
		sqlite: "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name;",
	};

	if (action === "schema") {
		return statement ?? schemaDefaults[adapter];
	}
	if (!statement) {
		throw new Error(`Action "${action}" requires statement.`);
	}
	if (action === "explain") {
		return /^\s*explain\b/i.test(statement) ? statement : `EXPLAIN ${statement}`;
	}
	return statement;
}

function resolveMongoStatement(action: DbRunAction, statement: string | undefined): string {
	if (action === "schema") {
		return statement ?? "db.getCollectionInfos()";
	}
	if (!statement) {
		throw new Error(`Action "${action}" requires statement.`);
	}
	if (action === "explain") {
		return statement;
	}
	return statement;
}

function resolveRedisStatement(action: DbRunAction, statement: string | undefined): string {
	if (action === "schema") {
		return statement ?? "INFO keyspace";
	}
	if (!statement) {
		throw new Error(`Action "${action}" requires statement.`);
	}
	return statement;
}

function ensureAdapterCommandAvailable(ops: DbRunOperations, command: string, hint: string): void {
	if (ops.commandExists(command)) {
		return;
	}
	throw new Error(hint);
}

function resolveSqlCommand(input: {
	ops: DbRunOperations;
	adapter: "postgres" | "mysql" | "sqlite";
	action: DbRunAction;
	statement?: string;
	format: DbRunFormat;
	executionCwd: string;
	connection: ResolvedConnectionProfile;
}): ResolvedDbCommand {
	const statement = resolveSqlStatement(input.adapter, input.action, input.statement);
	if (input.adapter === "postgres") {
		ensureAdapterCommandAvailable(input.ops, "psql", 'Command "psql" is required for postgres adapter.');
		const dsnValue = process.env[input.connection.dsnEnv!];
		if (!dsnValue) {
			throw new Error(`Environment variable "${input.connection.dsnEnv}" is required for connection "${input.connection.name}".`);
		}
		const parsed = parseDsn(dsnValue, "postgres");
		const env: NodeJS.ProcessEnv = {};
		if (parsed.hostname) env.PGHOST = parsed.hostname;
		if (parsed.port) env.PGPORT = parsed.port;
		if (parsed.username) env.PGUSER = decodeURIComponent(parsed.username);
		if (parsed.password) env.PGPASSWORD = decodeURIComponent(parsed.password);
		const dbName = parsed.pathname.replace(/^\//, "");
		if (dbName) env.PGDATABASE = decodeURIComponent(dbName);
		const sslMode = parsed.searchParams.get("sslmode");
		if (sslMode) env.PGSSLMODE = sslMode;

		const args = [...input.connection.clientArgs];
		if (input.format === "raw" || input.format === "json") {
			args.push("-A", "-t");
		}
		args.push("-c", statement);
		return {
			command: "psql",
			args,
			env,
			secretValues: [dsnValue, decodeURIComponent(parsed.password || "")].filter(Boolean),
		};
	}

	if (input.adapter === "mysql") {
		ensureAdapterCommandAvailable(input.ops, "mysql", 'Command "mysql" is required for mysql adapter.');
		const dsnValue = process.env[input.connection.dsnEnv!];
		if (!dsnValue) {
			throw new Error(`Environment variable "${input.connection.dsnEnv}" is required for connection "${input.connection.name}".`);
		}
		const parsed = parseDsn(dsnValue, "mysql");
		const args = [...input.connection.clientArgs];
		if (parsed.hostname) args.push("--host", parsed.hostname);
		if (parsed.port) args.push("--port", parsed.port);
		if (parsed.username) args.push("--user", decodeURIComponent(parsed.username));
		if (input.format === "raw" || input.format === "json") {
			args.push("--batch", "--raw", "--skip-column-names");
		}
		const dbName = parsed.pathname.replace(/^\//, "");
		if (dbName) args.push(decodeURIComponent(dbName));
		args.push("-e", statement);
		const env: NodeJS.ProcessEnv = {};
		if (parsed.password) {
			env.MYSQL_PWD = decodeURIComponent(parsed.password);
		}
		return {
			command: "mysql",
			args,
			env,
			secretValues: [dsnValue, decodeURIComponent(parsed.password || "")].filter(Boolean),
		};
	}

	ensureAdapterCommandAvailable(input.ops, "sqlite3", 'Command "sqlite3" is required for sqlite adapter.');
	const sqlitePath = resolveToCwd(input.connection.sqlitePath!, input.executionCwd);
	const sqliteDir = join(sqlitePath, "..");
	if (!existsSync(sqliteDir)) {
		throw new Error(`sqlitePath parent directory does not exist: ${sqliteDir}`);
	}
	const args = [...input.connection.clientArgs];
	if (input.format === "raw") {
		args.push("-noheader");
	}
	if (input.format === "json") {
		args.push("-json");
	}
	args.push(sqlitePath, statement);
	return {
		command: "sqlite3",
		args,
		secretValues: [],
	};
}

function resolveMongoCommand(input: {
	ops: DbRunOperations;
	action: DbRunAction;
	statement?: string;
	connection: ResolvedConnectionProfile;
}): ResolvedDbCommand {
	ensureAdapterCommandAvailable(input.ops, "mongosh", 'Command "mongosh" is required for mongodb adapter.');
	const dsnValue = process.env[input.connection.dsnEnv!];
	if (!dsnValue) {
		throw new Error(`Environment variable "${input.connection.dsnEnv}" is required for connection "${input.connection.name}".`);
	}
	parseDsn(dsnValue, "mongodb");
	const statement = resolveMongoStatement(input.action, input.statement);
	const args = [...input.connection.clientArgs, dsnValue, "--quiet", "--eval", statement];
	return {
		command: "mongosh",
		args,
		secretValues: [dsnValue],
	};
}

function resolveRedisCommand(input: {
	ops: DbRunOperations;
	action: DbRunAction;
	statement?: string;
	format: DbRunFormat;
	connection: ResolvedConnectionProfile;
}): ResolvedDbCommand {
	ensureAdapterCommandAvailable(input.ops, "redis-cli", 'Command "redis-cli" is required for redis adapter.');
	const dsnValue = process.env[input.connection.dsnEnv!];
	if (!dsnValue) {
		throw new Error(`Environment variable "${input.connection.dsnEnv}" is required for connection "${input.connection.name}".`);
	}
	const parsed = parseDsn(dsnValue, "redis");
	const statement = resolveRedisStatement(input.action, input.statement);
	const args = [...input.connection.clientArgs];
	if (parsed.protocol === "rediss:") {
		args.push("--tls");
	}
	if (parsed.hostname) args.push("-h", parsed.hostname);
	if (parsed.port) args.push("-p", parsed.port);
	if (parsed.username) args.push("--user", decodeURIComponent(parsed.username));
	const dbName = parsed.pathname.replace(/^\//, "");
	if (dbName) args.push("-n", decodeURIComponent(dbName));
	if (input.format === "raw" || input.format === "json") {
		args.push("--raw");
	}
	const env: NodeJS.ProcessEnv = {};
	if (parsed.password) {
		env.REDISCLI_AUTH = decodeURIComponent(parsed.password);
	}
	return {
		command: "redis-cli",
		args,
		stdin: `${statement}\n`,
		env,
		secretValues: [dsnValue, decodeURIComponent(parsed.password || "")].filter(Boolean),
	};
}

function resolveMigrateCommand(input: {
	action: DbRunAction;
	allowWrite: boolean;
	executionCwd: string;
	migrateRunner: DbRunMigrateRunner;
	connection: ResolvedConnectionProfile;
	script?: string;
	args: string[];
}): { command: ResolvedDbCommand; cwd: string } {
	if (input.action !== "migrate") {
		throw new Error("Internal error: resolveMigrateCommand called for non-migrate action.");
	}
	ensureWriteAllowed("migrate", input.allowWrite);

	const migrateCwd = resolveToCwd(input.connection.migrate.cwd ?? ".", input.executionCwd);
	const packageJson = readPackageJson(migrateCwd);
	if (!packageJson) {
		throw new Error("package.json is required for migrate action.");
	}

	const scriptCandidates: string[] = [];
	if (input.script) scriptCandidates.push(input.script);
	if (input.connection.migrate.script) scriptCandidates.push(input.connection.migrate.script);
	if (input.migrateRunner === "auto") {
		scriptCandidates.push("db:migrate", "migrate");
	}
	if (input.migrateRunner === "script" && scriptCandidates.length === 0) {
		scriptCandidates.push("db:migrate");
	}

	const selectedScript = scriptCandidates.find((candidate) => packageJson.scripts[candidate]);
	if (!selectedScript) {
		throw new Error(
			`No migration script found. Checked: ${scriptCandidates.join(", ")} in ${packageJson.path}.`,
		);
	}

	const packageManager = detectPackageManager(migrateCwd);
	ensureCommandOrThrow(packageManager, `Command "${packageManager}" is required for migrate action.`);
	const invocation = resolvePackageManagerRunInvocation(packageManager, selectedScript, [
		...input.connection.migrate.args,
		...input.args,
	]);
	return {
		cwd: migrateCwd,
		command: {
			command: invocation.command,
			args: invocation.args,
			secretValues: [],
		},
	};
}

function mapDbStatus(exitCode: number): DbRunStatus {
	if (exitCode === 0) return "passed";
	if (exitCode === 1) return "failed";
	return "error";
}

function redactArgs(args: string[], secrets: string[]): string[] {
	const normalizedSecrets = secrets
		.map((secret) => secret.trim())
		.filter((secret) => secret.length > 0)
		.sort((a, b) => b.length - a.length);

	return args.map((arg) => {
		let sanitized = arg;
		for (const secret of normalizedSecrets) {
			if (sanitized.includes(secret)) {
				sanitized = sanitized.replaceAll(secret, "[REDACTED]");
			}
		}
		if (/\b(password|passwd|pwd|token|secret)=/i.test(sanitized)) {
			return sanitized.replace(/=(.+)$/i, "=[REDACTED]");
		}
		return sanitized;
	});
}

function parseCounts(output: string): { rowCount?: number; affectedCount?: number } {
	const selectMatch = output.match(/\bSELECT\s+(\d+)\b/i);
	const updateMatch = output.match(/\b(?:UPDATE|DELETE)\s+(\d+)\b/i);
	const insertMatch = output.match(/\bINSERT\s+\d+\s+(\d+)\b/i);
	const rowsInSetMatch = output.match(/\b(\d+)\s+rows?\s+in set\b/i);
	const mysqlChangedMatch = output.match(/\bRows matched:\s*(\d+)\s+Changed:\s*(\d+)\b/i);

	const rowCount = selectMatch?.[1]
		? Number.parseInt(selectMatch[1], 10)
		: rowsInSetMatch?.[1]
			? Number.parseInt(rowsInSetMatch[1], 10)
			: undefined;
	const affectedCount = updateMatch?.[1]
		? Number.parseInt(updateMatch[1], 10)
		: insertMatch?.[1]
			? Number.parseInt(insertMatch[1], 10)
			: mysqlChangedMatch?.[2]
				? Number.parseInt(mysqlChangedMatch[2], 10)
				: undefined;

	return {
		rowCount: Number.isFinite(rowCount as number) ? rowCount : undefined,
		affectedCount: Number.isFinite(affectedCount as number) ? affectedCount : undefined,
	};
}

function renderSummary(details: DbRunToolDetails, output: string): string {
	const argsText = details.resolvedArgs.length > 0 ? ` ${details.resolvedArgs.join(" ")}` : "";
	const lines = [
		`db_run status: ${details.status}`,
		`action: ${details.action}`,
		`adapter: ${details.adapter}`,
		`connection: ${details.connection}`,
		`command: ${details.resolvedCommand}${argsText}`,
		`cwd: ${details.cwd}`,
		`write_requested: ${details.writeRequested ? "true" : "false"}`,
		`write_allowed: ${details.writeAllowed ? "true" : "false"}`,
		`exit_code: ${details.exitCode}`,
		`duration_ms: ${details.durationMs}`,
	];
	if (details.rowCount !== undefined) {
		lines.push(`row_count: ${details.rowCount}`);
	}
	if (details.affectedCount !== undefined) {
		lines.push(`affected_count: ${details.affectedCount}`);
	}
	lines.push("", output);
	return lines.join("\n");
}

export function createDbRunTool(cwd: string, options?: DbRunToolOptions): AgentTool<typeof dbRunSchema> {
	const permissionGuard = options?.permissionGuard;
	const ops: DbRunOperations = {
		...defaultOps,
		...(options?.operations ?? {}),
	};

	return {
		name: "db_run",
		label: "db_run",
		description:
			"Structured database operations across postgres/mysql/sqlite/mongodb/redis using named settings profiles with read-first safety and normalized status reporting.",
		parameters: dbRunSchema,
		execute: async (_toolCallId: string, input: DbRunToolInput, signal?: AbortSignal) => {
			const action = normalizeAction(input.action);
			const requestedAdapter = input.adapter ?? "auto";
			const format = normalizeFormat(input.format);
			const allowWrite = input.allow_write === true;
			const timeoutSeconds = normalizeTimeoutSeconds(input.timeout);
			const statement = normalizeStatement(input.statement);
			const args = normalizeStringArray(input.args);
			const executionCwd = resolveToCwd(input.path || ".", cwd);
			const migrateRunner: DbRunMigrateRunner = input.migrate_runner ?? "auto";
			const script = normalizeScriptName(input.script);

			const runtimeConfig = normalizeRuntimeConfig(options?.resolveRuntimeConfig?.());
			const connection = resolveConnectionProfile({
				runtimeConfig,
				connection: input.connection,
				adapter: requestedAdapter,
			});
			const resolvedAdapter = requestedAdapter === "auto" ? connection.adapter : requestedAdapter;
			const writeRequested = action === "exec" || action === "migrate";
			ensureWriteAllowed(action, allowWrite);
			enforceReadFirstSafety(resolvedAdapter, action, statement);

			if (permissionGuard) {
				const allowed = await permissionGuard({
					toolName: "db_run",
					cwd: executionCwd,
					input: {
						action,
						adapter: resolvedAdapter,
						connection: connection.name,
						format,
						allowWrite,
						args,
					},
					summary: `${action} on ${connection.name} (${resolvedAdapter})`,
				});
				if (!allowed) {
					throw new Error("Permission denied for db_run operation.");
				}
			}

			let commandCwd = executionCwd;
			let resolvedCommand: ResolvedDbCommand;
			if (action === "migrate") {
				const migrated = resolveMigrateCommand({
					action,
					allowWrite,
					executionCwd,
					migrateRunner,
					connection,
					script,
					args,
				});
				resolvedCommand = migrated.command;
				commandCwd = migrated.cwd;
			} else if (resolvedAdapter === "postgres" || resolvedAdapter === "mysql" || resolvedAdapter === "sqlite") {
				resolvedCommand = resolveSqlCommand({
					ops,
					adapter: resolvedAdapter,
					action,
					statement,
					format,
					executionCwd,
					connection,
				});
				if (args.length > 0) {
					resolvedCommand.args = [...resolvedCommand.args, ...args];
				}
			} else if (resolvedAdapter === "mongodb") {
				resolvedCommand = resolveMongoCommand({
					ops,
					action,
					statement,
					connection,
				});
				if (args.length > 0) {
					resolvedCommand.args = [...resolvedCommand.args, ...args];
				}
			} else {
				resolvedCommand = resolveRedisCommand({
					ops,
					action,
					statement,
					format,
					connection,
				});
				if (args.length > 0) {
					resolvedCommand.args = [...resolvedCommand.args, ...args];
				}
			}

			const result = await ops.runCommand({
				command: resolvedCommand.command,
				args: resolvedCommand.args,
				cwd: commandCwd,
				timeoutMs: timeoutSeconds * 1000,
				signal,
				env: resolvedCommand.env,
				stdin: resolvedCommand.stdin,
			});

			const status = mapDbStatus(result.exitCode);
			const formatted = formatVerificationOutput(
				result.stdout,
				result.stderr,
				result.captureTruncated,
				"No database output",
			);
			const counts = parseCounts(`${result.stdout}\n${result.stderr}`);
			const details: DbRunToolDetails = {
				action,
				adapter: resolvedAdapter,
				connection: connection.name,
				resolvedCommand: resolvedCommand.command,
				resolvedArgs: redactArgs(resolvedCommand.args, resolvedCommand.secretValues),
				cwd: commandCwd,
				exitCode: result.exitCode,
				status,
				durationMs: result.durationMs,
				rowCount: counts.rowCount,
				affectedCount: counts.affectedCount,
				writeRequested,
				writeAllowed: allowWrite,
				captureTruncated: result.captureTruncated || undefined,
				truncation: formatted.truncation,
			};

			return {
				content: [{ type: "text", text: renderSummary(details, formatted.text) }],
				details,
			};
		},
	};
}

export const dbRunTool = createDbRunTool(process.cwd());
