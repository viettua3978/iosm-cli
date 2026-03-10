/**
 * Built-in Qwen CLI provider integration.
 *
 * Implements OAuth device authorization (PKCE) against chat.qwen.ai
 * and exposes OpenAI-compatible Qwen coding models in the model registry.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@mariozechner/pi-ai";
import type { ProviderConfigInput } from "./model-registry.js";

export const QWEN_CLI_PROVIDER_ID = "qwen-cli";

const QWEN_DEVICE_CODE_ENDPOINT = "https://chat.qwen.ai/api/v1/oauth2/device/code";
const QWEN_TOKEN_ENDPOINT = "https://chat.qwen.ai/api/v1/oauth2/token";
const QWEN_CLIENT_ID = "f0304373b74a44d2b584a3fb70ca9e56";
const QWEN_SCOPE = "openid profile email model.completion";
const QWEN_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const QWEN_DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const QWEN_DEFAULT_POLL_INTERVAL_MS = 2000;

type DeviceCodeResponse = {
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete?: string;
	expires_in: number;
	interval?: number;
	error?: string;
	error_description?: string;
};

type TokenResponse = {
	access_token?: string;
	refresh_token?: string;
	token_type?: string;
	expires_in?: number;
	resource_url?: string;
	error?: string;
	error_description?: string;
};

function objectToUrlEncoded(data: Record<string, string>): string {
	return Object.entries(data)
		.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
		.join("&");
}

function generatePKCEPair(): { verifier: string; challenge: string } {
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	return { verifier, challenge };
}

function isAbortError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return error.name === "AbortError" || error.message === "Login cancelled";
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new Error("Login cancelled");
	}
}

async function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Login cancelled"));
			return;
		}

		const timeout = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);

		const onAbort = () => {
			clearTimeout(timeout);
			cleanup();
			reject(new Error("Login cancelled"));
		};

		const cleanup = () => {
			signal?.removeEventListener("abort", onAbort);
		};

		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function parseJsonResponse<T>(text: string): T | undefined {
	if (!text) return undefined;
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

function errorDetails(error?: string, description?: string): string {
	if (error && description) return `${error}: ${description}`;
	if (error) return error;
	return description || "unknown error";
}

async function startDeviceFlow(signal?: AbortSignal): Promise<{ deviceCode: DeviceCodeResponse; verifier: string }> {
	throwIfAborted(signal);
	const { verifier, challenge } = generatePKCEPair();

	const response = await fetch(QWEN_DEVICE_CODE_ENDPOINT, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
			"x-request-id": randomUUID(),
		},
		body: objectToUrlEncoded({
			client_id: QWEN_CLIENT_ID,
			scope: QWEN_SCOPE,
			code_challenge: challenge,
			code_challenge_method: "S256",
		}),
		signal,
	});

	const responseText = await response.text();
	const data = parseJsonResponse<DeviceCodeResponse>(responseText);

	if (!response.ok) {
		throw new Error(
			`Qwen device authorization failed (${response.status} ${response.statusText}): ${errorDetails(
				data?.error,
				data?.error_description || responseText,
			)}`,
		);
	}

	if (!data?.device_code || !data.user_code || !data.verification_uri || !data.expires_in) {
		throw new Error("Qwen device authorization failed: invalid response from server");
	}

	return { deviceCode: data, verifier };
}

async function pollForToken(
	deviceCode: string,
	verifier: string,
	intervalSeconds: number | undefined,
	expiresIn: number,
	signal?: AbortSignal,
): Promise<TokenResponse> {
	let intervalMs =
		typeof intervalSeconds === "number" && Number.isFinite(intervalSeconds) && intervalSeconds > 0
			? Math.max(1000, Math.floor(intervalSeconds * 1000))
			: QWEN_DEFAULT_POLL_INTERVAL_MS;
	const deadline = Date.now() + expiresIn * 1000;

	while (Date.now() < deadline) {
		throwIfAborted(signal);

		let response: Response;
		try {
			response = await fetch(QWEN_TOKEN_ENDPOINT, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					Accept: "application/json",
				},
				body: objectToUrlEncoded({
					grant_type: QWEN_GRANT_TYPE,
					client_id: QWEN_CLIENT_ID,
					device_code: deviceCode,
					code_verifier: verifier,
				}),
				signal,
			});
		} catch (error) {
			if (isAbortError(error)) {
				throw new Error("Login cancelled");
			}
			throw error;
		}

		const responseText = await response.text();
		const data = parseJsonResponse<TokenResponse>(responseText);
		const error = data?.error;
		const description = data?.error_description;

		if (response.ok && data?.access_token) {
			return data;
		}

		// OAuth RFC 8628 polling states
		if (error === "authorization_pending") {
			await abortableSleep(intervalMs, signal);
			continue;
		}

		if (error === "slow_down" || response.status === 429) {
			intervalMs = Math.min(intervalMs + 5000, 10000);
			await abortableSleep(intervalMs, signal);
			continue;
		}

		if (error === "access_denied") {
			throw new Error("Qwen authorization denied by user");
		}

		if (error === "expired_token") {
			throw new Error("Qwen device code expired. Please run /login again");
		}

		if (!response.ok) {
			throw new Error(
				`Qwen token request failed (${response.status} ${response.statusText}): ${errorDetails(
					error,
					description || responseText,
				)}`,
			);
		}

		throw new Error(`Qwen token request failed: ${errorDetails(error, description || responseText)}`);
	}

	throw new Error("Qwen authentication timed out. Please run /login again");
}

async function loginQwen(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	callbacks.onProgress?.("Requesting Qwen device authorization...");

	const { deviceCode, verifier } = await startDeviceFlow(callbacks.signal);
	const authUrl = deviceCode.verification_uri_complete || deviceCode.verification_uri;
	const instructions = deviceCode.verification_uri_complete
		? "Open this URL and approve access in your browser"
		: `Open this URL and enter code: ${deviceCode.user_code}`;

	callbacks.onAuth({ url: authUrl, instructions });
	callbacks.onProgress?.("Waiting for Qwen authorization...");

	const token = await pollForToken(
		deviceCode.device_code,
		verifier,
		deviceCode.interval,
		deviceCode.expires_in,
		callbacks.signal,
	);

	if (!token.access_token || !token.expires_in) {
		throw new Error("Qwen login failed: missing access token in server response");
	}

	return {
		refresh: token.refresh_token || "",
		access: token.access_token,
		expires: Date.now() + token.expires_in * 1000 - 5 * 60 * 1000,
		enterpriseUrl: token.resource_url,
	};
}

async function refreshQwenToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	if (!credentials.refresh) {
		throw new Error("Qwen credentials missing refresh token. Please run /login again");
	}

	const response = await fetch(QWEN_TOKEN_ENDPOINT, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body: objectToUrlEncoded({
			grant_type: "refresh_token",
			refresh_token: credentials.refresh,
			client_id: QWEN_CLIENT_ID,
		}),
	});

	const responseText = await response.text();
	const data = parseJsonResponse<TokenResponse>(responseText);

	if (!response.ok) {
		throw new Error(
			`Qwen token refresh failed (${response.status} ${response.statusText}): ${errorDetails(
				data?.error,
				data?.error_description || responseText,
			)}`,
		);
	}

	if (!data?.access_token || !data.expires_in) {
		throw new Error("Qwen token refresh failed: missing access token in response");
	}

	return {
		...credentials,
		refresh: data.refresh_token || credentials.refresh,
		access: data.access_token,
		expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
		enterpriseUrl: data.resource_url ?? credentials.enterpriseUrl,
	};
}

function getQwenBaseUrl(resourceUrl: unknown): string {
	if (typeof resourceUrl !== "string" || !resourceUrl.trim()) {
		return QWEN_DEFAULT_BASE_URL;
	}

	const normalizedInput = resourceUrl.trim().startsWith("http") ? resourceUrl.trim() : `https://${resourceUrl.trim()}`;
	let normalizedUrl = normalizedInput.replace(/\/+$/, "");
	if (!normalizedUrl.endsWith("/v1")) {
		normalizedUrl += "/v1";
	}
	return normalizedUrl;
}

export function createQwenCliProviderConfig(): ProviderConfigInput {
	return {
		baseUrl: QWEN_DEFAULT_BASE_URL,
		api: "openai-completions",
		models: [
			{
				id: "qwen3-coder-plus",
				name: "Qwen3 Coder Plus",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1000000,
				maxTokens: 65536,
			},
			{
				id: "qwen3-coder-flash",
				name: "Qwen3 Coder Flash",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1000000,
				maxTokens: 65536,
			},
			{
				id: "qwen3-vl-plus",
				name: "Qwen3 VL Plus",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 262144,
				maxTokens: 32768,
				compat: { supportsDeveloperRole: false, thinkingFormat: "qwen" },
			},
		],
		oauth: {
			name: "Qwen CLI (Free OAuth)",
			login: loginQwen,
			refreshToken: refreshQwenToken,
			getApiKey: (credentials) => String(credentials.access || ""),
			modifyModels: (models, credentials) => {
				const baseUrl = getQwenBaseUrl(credentials.enterpriseUrl);
				return models.map((model) => (model.provider === QWEN_CLI_PROVIDER_ID ? { ...model, baseUrl } : model));
			},
		},
	};
}
