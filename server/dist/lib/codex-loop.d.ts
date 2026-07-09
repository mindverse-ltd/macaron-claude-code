export type CodexLoopConfig = {
    enabled: boolean;
    /** The continue prompt re-injected each iteration. NOT a baked-in string. */
    prompt: string;
    /** Stop after N loop-driven iterations. 0 = unlimited. */
    maxIterations: number;
    /** Stop after this many ms of wall-clock since the loop armed. 0 = no limit. */
    timeoutMs: number;
    /** Stop if the agent's turn output contains any of these substrings. */
    sentinels: string[];
};
export type CodexLoopStatus = 'idle' | 'armed' | 'running' | 'stopped';
export type CodexLoopSnapshot = {
    enabled: boolean;
    status: CodexLoopStatus;
    iterations: number;
    config: CodexLoopConfig;
    stopReason?: string;
};
export type CodexLoopStreamEvent = {
    type: 'loop_status';
    snapshot: CodexLoopSnapshot;
} | {
    type: 'meta';
    sessionId: string;
    cwd?: string;
} | {
    type: 'delta';
    text: string;
} | {
    type: 'tool_use';
    id: string;
    name: string;
    input: unknown;
} | {
    type: 'tool_result';
    tool_use_id: string;
    text: string;
    isError: boolean;
} | {
    type: 'usage';
    outputTokens: number;
    thinkingTokens?: number;
} | {
    type: 'event';
    subtype: string;
} | {
    type: 'error';
    error: string;
} | {
    type: 'done';
    exitCode: number;
};
export declare function defaultLoopConfig(): CodexLoopConfig;
export declare function warmCodexLoopCache(): Promise<void>;
export declare function getLoopConfig(sid: string): CodexLoopConfig;
export declare function getLoopSnapshot(sid: string): CodexLoopSnapshot;
export declare function subscribeLoop(sid: string, cb: (ev: CodexLoopStreamEvent) => void): () => void;
export declare function noteCodexTurnComplete(sid: string, cwd: string, agentText: string): void;
export declare function setLoopConfig(sid: string, patch: Partial<CodexLoopConfig>, cwd: string): CodexLoopSnapshot;
//# sourceMappingURL=codex-loop.d.ts.map