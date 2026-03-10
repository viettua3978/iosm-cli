export interface ToolPermissionRequest {
	toolName: string;
	cwd: string;
	input: Record<string, unknown>;
	summary: string;
}

export type ToolPermissionGuard = (request: ToolPermissionRequest) => Promise<boolean> | boolean;

