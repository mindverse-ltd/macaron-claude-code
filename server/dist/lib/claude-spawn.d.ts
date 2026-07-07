export type ClaudeStreamEvent = {
    type?: string;
    subtype?: string | null;
    session_id?: string;
    sessionId?: string;
    message?: {
        session_id?: string;
        content?: Array<{
            type?: string;
            text?: string;
        }>;
        stop_reason?: string;
        model?: string;
    };
    event?: {
        type?: string;
        delta?: {
            type?: string;
            text?: string;
        };
    };
    parent_tool_use_id?: string;
};
export declare function extractDeltaText(ev: ClaudeStreamEvent): string;
export declare function extractSessionId(ev: ClaudeStreamEvent): string | undefined;
//# sourceMappingURL=claude-spawn.d.ts.map