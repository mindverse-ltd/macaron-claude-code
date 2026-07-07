export declare function getGenuiSystemPrompt(): Promise<string>;
/**
 * Streaming variant: invokes onPartial(code) every time more code is decoded
 * from the streaming tool_call args. Returns the final code on completion.
 * Throws on API errors. The onPartial callback may receive incomplete (but
 * still parseable) TSX — the host renderer handles partial code gracefully.
 */
export declare function streamTsx(prompt: string, onPartial: (code: string) => void, signal?: AbortSignal): Promise<string>;
/**
 * Convenience wrapper around streamTsx for callers that don't need partials.
 */
export declare function generateTsx(prompt: string, signal?: AbortSignal): Promise<string>;
//# sourceMappingURL=macaron-genui.d.ts.map