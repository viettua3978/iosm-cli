export type SemanticCliCommand =
	| { kind: "help" }
	| { kind: "status" }
	| { kind: "index" }
	| { kind: "rebuild" }
	| { kind: "query"; query: string; topK?: number };

export type ParseSemanticCliResult =
	| { ok: true; value: SemanticCliCommand }
	| { ok: false; error: string };

function parseTopKOption(args: string[]): { rest: string[]; topK?: number; error?: string } {
	const rest: string[] = [];
	let topK: number | undefined;

	for (let index = 0; index < args.length; index++) {
		const token = args[index] ?? "";
		if (token === "--top-k" || token === "--topk") {
			const raw = args[index + 1];
			if (!raw) {
				return { rest, error: "Missing value for --top-k." };
			}
			const parsed = Number.parseInt(raw, 10);
			if (!Number.isFinite(parsed) || `${parsed}` !== raw || parsed < 1 || parsed > 20) {
				return { rest, error: "--top-k must be an integer between 1 and 20." };
			}
			topK = parsed;
			index += 1;
			continue;
		}
		rest.push(token);
	}

	return { rest, topK };
}

export function parseSemanticCliCommand(args: string[]): ParseSemanticCliResult {
	const subcommand = (args[0] ?? "help").toLowerCase();
	const rest = args.slice(1);

	if (subcommand === "help" || subcommand === "-h" || subcommand === "--help") {
		return { ok: true, value: { kind: "help" } };
	}

	if (subcommand === "status") {
		if (rest.length > 0) {
			return { ok: false, error: `Unexpected arguments for status: ${rest.join(" ")}` };
		}
		return { ok: true, value: { kind: "status" } };
	}

	if (subcommand === "index") {
		if (rest.length > 0) {
			return { ok: false, error: `Unexpected arguments for index: ${rest.join(" ")}` };
		}
		return { ok: true, value: { kind: "index" } };
	}

	if (subcommand === "rebuild") {
		if (rest.length > 0) {
			return { ok: false, error: `Unexpected arguments for rebuild: ${rest.join(" ")}` };
		}
		return { ok: true, value: { kind: "rebuild" } };
	}

	if (subcommand === "query") {
		const parsed = parseTopKOption(rest);
		if (parsed.error) {
			return { ok: false, error: parsed.error };
		}
		const query = parsed.rest.join(" ").trim();
		if (!query) {
			return {
				ok: false,
				error: 'Missing query text. Usage: iosm semantic query "<text>" [--top-k N]',
			};
		}
		return {
			ok: true,
			value: { kind: "query", query, topK: parsed.topK },
		};
	}

	return {
		ok: false,
		error: `Unknown semantic subcommand "${subcommand}". Use "iosm semantic help".`,
	};
}

export function getSemanticCommandHelp(prefix: string): string {
	const cmd = prefix.trim();
	return [
		"Usage:",
		`  ${cmd} help`,
		`  ${cmd} status`,
		`  ${cmd} index`,
		`  ${cmd} rebuild`,
		`  ${cmd} query "<text>" [--top-k N]`,
		"",
		"Examples:",
		`  ${cmd} status`,
		`  ${cmd} index`,
		`  ${cmd} query "where auth token is validated" --top-k 8`,
		`  ${cmd} rebuild`,
	].join("\n");
}
