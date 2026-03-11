export type SwarmRetryBucket = "permission" | "dependency_import" | "test" | "timeout" | "unknown";

export interface SwarmRetryPolicy {
	maxByBucket: Record<SwarmRetryBucket, number>;
}

export const DEFAULT_RETRY_POLICY: SwarmRetryPolicy = {
	maxByBucket: {
		permission: 1,
		dependency_import: 2,
		test: 2,
		timeout: 2,
		unknown: 1,
	},
};

export function classifyRetryBucket(errorMessage: string): SwarmRetryBucket {
	const msg = errorMessage.toLowerCase();
	if (/(permission|denied|not allowed|forbidden|eacces|eprem)/.test(msg)) return "permission";
	if (/(module not found|cannot find module|importerror|dependency|package)/.test(msg)) return "dependency_import";
	if (/(test failed|assert|expect\(|failing test|spec failed)/.test(msg)) return "test";
	if (/(timeout|timed out|deadline exceeded)/.test(msg)) return "timeout";
	return "unknown";
}

export function shouldRetry(input: {
	errorMessage: string;
	currentRetries: number;
	policy?: SwarmRetryPolicy;
}): { retry: boolean; bucket: SwarmRetryBucket; max: number } {
	const bucket = classifyRetryBucket(input.errorMessage);
	const policy = input.policy ?? DEFAULT_RETRY_POLICY;
	const max = policy.maxByBucket[bucket] ?? 0;
	return {
		retry: input.currentRetries < max,
		bucket,
		max,
	};
}
