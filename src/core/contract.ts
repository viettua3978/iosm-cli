import AjvModule from "ajv";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const Ajv = (AjvModule as any).default || AjvModule;
const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });

export type ContractScope = "project" | "session";

export interface EngineeringContract {
	goal?: string;
	scope_include?: string[];
	scope_exclude?: string[];
	constraints?: string[];
	quality_gates?: string[];
	definition_of_done?: string[];
	assumptions?: string[];
	non_goals?: string[];
	risks?: string[];
	deliverables?: string[];
	success_metrics?: string[];
	stakeholders?: string[];
	owner?: string;
	timebox?: string;
	notes?: string;
}

export interface ContractState {
	projectPath: string;
	hasProjectFile: boolean;
	project: EngineeringContract;
	sessionOverlay: EngineeringContract;
	effective: EngineeringContract;
}

export class ContractValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ContractValidationError";
	}
}

export class ContractParseError extends Error {
	readonly filePath: string;

	constructor(filePath: string, message: string) {
		super(message);
		this.name = "ContractParseError";
		this.filePath = filePath;
	}
}

type ContractSchemaPayload = {
	goal?: string;
	scope_include?: string[];
	scope_exclude?: string[];
	constraints?: string[];
	quality_gates?: string[];
	definition_of_done?: string[];
	assumptions?: string[];
	non_goals?: string[];
	risks?: string[];
	deliverables?: string[];
	success_metrics?: string[];
	stakeholders?: string[];
	owner?: string;
	timebox?: string;
	notes?: string;
};

const CONTRACT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		goal: { type: "string" },
		scope_include: {
			type: "array",
			items: { type: "string" },
		},
		scope_exclude: {
			type: "array",
			items: { type: "string" },
		},
		constraints: {
			type: "array",
			items: { type: "string" },
		},
		quality_gates: {
			type: "array",
			items: { type: "string" },
		},
		definition_of_done: {
			type: "array",
			items: { type: "string" },
		},
		assumptions: {
			type: "array",
			items: { type: "string" },
		},
		non_goals: {
			type: "array",
			items: { type: "string" },
		},
		risks: {
			type: "array",
			items: { type: "string" },
		},
		deliverables: {
			type: "array",
			items: { type: "string" },
		},
		success_metrics: {
			type: "array",
			items: { type: "string" },
		},
		stakeholders: {
			type: "array",
			items: { type: "string" },
		},
		owner: { type: "string" },
		timebox: { type: "string" },
		notes: { type: "string" },
	},
	required: [],
} as const;

const validateContract = ajv.compile(CONTRACT_SCHEMA as any) as {
	(payload: unknown): boolean;
	errors?: Array<{ instancePath?: string; message?: string }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function normalizeString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const normalized = value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
	return normalized.length > 0 ? normalized : undefined;
}

function cloneContract(contract: EngineeringContract): EngineeringContract {
	return {
		...(contract.goal ? { goal: contract.goal } : {}),
		...(contract.scope_include ? { scope_include: [...contract.scope_include] } : {}),
		...(contract.scope_exclude ? { scope_exclude: [...contract.scope_exclude] } : {}),
		...(contract.constraints ? { constraints: [...contract.constraints] } : {}),
		...(contract.quality_gates ? { quality_gates: [...contract.quality_gates] } : {}),
		...(contract.definition_of_done ? { definition_of_done: [...contract.definition_of_done] } : {}),
		...(contract.assumptions ? { assumptions: [...contract.assumptions] } : {}),
		...(contract.non_goals ? { non_goals: [...contract.non_goals] } : {}),
		...(contract.risks ? { risks: [...contract.risks] } : {}),
		...(contract.deliverables ? { deliverables: [...contract.deliverables] } : {}),
		...(contract.success_metrics ? { success_metrics: [...contract.success_metrics] } : {}),
		...(contract.stakeholders ? { stakeholders: [...contract.stakeholders] } : {}),
		...(contract.owner ? { owner: contract.owner } : {}),
		...(contract.timebox ? { timebox: contract.timebox } : {}),
		...(contract.notes ? { notes: contract.notes } : {}),
	};
}

function formatValidationError(payload: unknown): string {
	const errors = validateContract.errors ?? [];
	if (errors.length === 0) {
		return `Invalid contract payload: ${JSON.stringify(payload)}`;
	}
	const details = errors
		.map((error: { instancePath?: string; message?: string }) => {
			const path = error.instancePath || "/";
			return `${path} ${error.message ?? "is invalid"}`;
		})
		.join("; ");
	return `Invalid contract payload: ${details}`;
}

export function normalizeEngineeringContract(payload: unknown): EngineeringContract {
	if (!isRecord(payload)) {
		throw new ContractValidationError("Contract payload must be a JSON object.");
	}
	if (!validateContract(payload)) {
		throw new ContractValidationError(formatValidationError(payload));
	}

	const goal = normalizeString(payload.goal);
	const scopeInclude = normalizeStringArray(payload.scope_include);
	const scopeExclude = normalizeStringArray(payload.scope_exclude);
	const constraints = normalizeStringArray(payload.constraints);
	const qualityGates = normalizeStringArray(payload.quality_gates);
	const definitionOfDone = normalizeStringArray(payload.definition_of_done);
	const assumptions = normalizeStringArray(payload.assumptions);
	const nonGoals = normalizeStringArray(payload.non_goals);
	const risks = normalizeStringArray(payload.risks);
	const deliverables = normalizeStringArray(payload.deliverables);
	const successMetrics = normalizeStringArray(payload.success_metrics);
	const stakeholders = normalizeStringArray(payload.stakeholders);
	const owner = normalizeString(payload.owner);
	const timebox = normalizeString(payload.timebox);
	const notes = normalizeString(payload.notes);

	return {
		...(goal ? { goal } : {}),
		...(scopeInclude ? { scope_include: scopeInclude } : {}),
		...(scopeExclude ? { scope_exclude: scopeExclude } : {}),
		...(constraints ? { constraints } : {}),
		...(qualityGates ? { quality_gates: qualityGates } : {}),
		...(definitionOfDone ? { definition_of_done: definitionOfDone } : {}),
		...(assumptions ? { assumptions } : {}),
		...(nonGoals ? { non_goals: nonGoals } : {}),
		...(risks ? { risks } : {}),
		...(deliverables ? { deliverables } : {}),
		...(successMetrics ? { success_metrics: successMetrics } : {}),
		...(stakeholders ? { stakeholders } : {}),
		...(owner ? { owner } : {}),
		...(timebox ? { timebox } : {}),
		...(notes ? { notes } : {}),
	};
}

export function deepMergeContracts(base: EngineeringContract, override: EngineeringContract): EngineeringContract {
	const merged: EngineeringContract = cloneContract(base);
	for (const [key, value] of Object.entries(override) as Array<[keyof EngineeringContract, unknown]>) {
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			(merged as Record<string, unknown>)[key] = [...value];
			continue;
		}
		(merged as Record<string, unknown>)[key] = value;
	}
	return normalizeEngineeringContract(merged);
}

function readContractFile(filePath: string): EngineeringContract {
	if (!existsSync(filePath)) {
		return {};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(filePath, "utf8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new ContractParseError(filePath, `Failed to parse contract JSON: ${message}`);
	}

	try {
		return normalizeEngineeringContract(parsed);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new ContractParseError(filePath, message);
	}
}

function writeContractFile(filePath: string, contract: EngineeringContract): void {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(contract, null, 2)}\n`, "utf8");
}

export interface ContractServiceOptions {
	cwd: string;
}

export class ContractService {
	private readonly cwd: string;
	private sessionOverlay: EngineeringContract = {};

	constructor(options: ContractServiceOptions) {
		this.cwd = options.cwd;
	}

	getProjectPath(): string {
		return join(this.cwd, ".iosm", "contract.json");
	}

	getSessionOverlay(): EngineeringContract {
		return cloneContract(this.sessionOverlay);
	}

	setSessionOverlay(payload: unknown): EngineeringContract {
		const normalized = normalizeEngineeringContract(payload);
		this.sessionOverlay = normalized;
		return cloneContract(normalized);
	}

	clearSessionOverlay(): void {
		this.sessionOverlay = {};
	}

	loadProjectContract(): EngineeringContract {
		return readContractFile(this.getProjectPath());
	}

	saveProjectContract(payload: unknown): EngineeringContract {
		const normalized = normalizeEngineeringContract(payload);
		writeContractFile(this.getProjectPath(), normalized);
		return cloneContract(normalized);
	}

	clearProjectContract(): boolean {
		const projectPath = this.getProjectPath();
		if (!existsSync(projectPath)) return false;
		rmSync(projectPath, { force: true });
		return true;
	}

	save(scope: ContractScope, payload: unknown): EngineeringContract {
		if (scope === "project") {
			return this.saveProjectContract(payload);
		}
		return this.setSessionOverlay(payload);
	}

	clear(scope: ContractScope): boolean {
		if (scope === "project") {
			return this.clearProjectContract();
		}
		this.clearSessionOverlay();
		return true;
	}

	getState(): ContractState {
		const projectPath = this.getProjectPath();
		const hasProjectFile = existsSync(projectPath);
		const project = this.loadProjectContract();
		const sessionOverlay = this.getSessionOverlay();
		const effective = deepMergeContracts(project, sessionOverlay);
		return {
			projectPath,
			hasProjectFile,
			project,
			sessionOverlay,
			effective,
		};
	}

	buildPromptContext(maxItemsPerList = 4): string | undefined {
		const state = this.getState();
		const contract = state.effective;
		if (Object.keys(contract).length === 0) {
			return undefined;
		}

		const lines: string[] = ["Active engineering contract (effective):"];
		if (contract.goal) lines.push(`- goal: ${contract.goal}`);

		const pushList = (label: string, values: string[] | undefined): void => {
			if (!values || values.length === 0) return;
			const preview = values.slice(0, Math.max(1, maxItemsPerList));
			const suffix = values.length > preview.length ? ` (+${values.length - preview.length} more)` : "";
			lines.push(`- ${label}: ${preview.join("; ")}${suffix}`);
		};

		pushList("scope_include", contract.scope_include);
		pushList("scope_exclude", contract.scope_exclude);
		pushList("constraints", contract.constraints);
		pushList("quality_gates", contract.quality_gates);
		pushList("definition_of_done", contract.definition_of_done);
		pushList("assumptions", contract.assumptions);
		pushList("non_goals", contract.non_goals);
		pushList("risks", contract.risks);
		pushList("deliverables", contract.deliverables);
		pushList("success_metrics", contract.success_metrics);
		pushList("stakeholders", contract.stakeholders);
		if (contract.owner) lines.push(`- owner: ${contract.owner}`);
		if (contract.timebox) lines.push(`- timebox: ${contract.timebox}`);
		if (contract.notes) lines.push(`- notes: ${contract.notes}`);
		lines.push("Treat this contract as execution constraints unless user explicitly overrides it.");
		return lines.join("\n");
	}
}
