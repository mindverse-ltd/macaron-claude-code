import { type PermissionMode } from '@anthropic-ai/claude-agent-sdk';
export type AttachedImage = {
    mimeType: string;
    dataUrl: string;
};
export type RunnerEvent = {
    kind: 'session';
    sessionId: string;
} | {
    kind: 'delta';
    text: string;
} | {
    kind: 'tool_use';
    id: string;
    name: string;
    input: unknown;
} | {
    kind: 'tool_input_delta';
    id: string;
    name: string;
    partial_json: string;
    accumulated: string;
} | {
    kind: 'tool_input_done';
    id: string;
    name: string;
    final_json: string;
} | {
    kind: 'tool_result';
    tool_use_id: string;
    text: string;
    isError: boolean;
} | {
    kind: 'usage';
    outputTokens: number;
    thinkingTokens?: number;
} | {
    kind: 'message';
    subtype: string;
} | {
    kind: 'permission_request';
    id: string;
    toolName: string;
    input: unknown;
    suggestion?: {
        label: string;
    };
} | {
    kind: 'permission_resolved';
    id: string;
    decision: 'allow' | 'deny';
} | {
    kind: 'error';
    error: string;
} | {
    kind: 'done';
    exitCode: number;
};
export type RunOptions = {
    prompt: string;
    cwd: string;
    /** Resume an existing sessionId. Omit for a new session. */
    resume?: string;
    abortController?: AbortController;
    permissionMode?: PermissionMode;
    model?: string;
    images?: AttachedImage[];
    /**
     * Env vars to pass to the Claude Code SDK subprocess. Setting
     * ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN here reroutes the SDK to a
     * different Anthropic-compatible endpoint (e.g. Macaron). When null, the
     * subprocess inherits process.env unchanged (default Anthropic path).
     */
    envOverrides?: Record<string, string> | null;
};
export declare function runClaude(opts: RunOptions): AsyncGenerator<RunnerEvent>;
export type FollowupOptions = {
    resume: string;
    cwd: string;
    model?: string;
    envOverrides?: Record<string, string> | null;
};
export declare function runFollowup(opts: FollowupOptions): AsyncGenerator<string>;
//# sourceMappingURL=claude-runner.d.ts.map