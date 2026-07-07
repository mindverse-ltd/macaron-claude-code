import type { ApprovalMode, ModelReasoningEffort, SandboxMode } from '@openai/codex-sdk';
export declare const CODEX_SYSTEM_PROVIDER_ID = "system";
/** Provider-level config — auth + which endpoint to hit. */
export type CodexCustomProvider = {
    id: string;
    /** Human-facing name for the WebUI's ProviderPicker. */
    name: string;
    /** Anthropic-style OpenAI-compatible endpoint (`.../v1` or root). */
    baseUrl: string;
    /** Bearer token for the endpoint. */
    apiKey: string;
    /** Model id sent to the endpoint. */
    model: string;
    /** `wire_api` — `responses` for GPT-5-family / `chat` for legacy. */
    wireApi: 'responses' | 'chat';
    /** Provider name recorded in ~/.codex/sessions rollouts. */
    modelProvider: string;
    /** Reasoning effort — passed to ThreadOptions and mirrored as config. */
    reasoningEffort: ModelReasoningEffort;
    /** Model context window — passed through to codex CLI config. */
    contextWindow: number;
    /** Auto-compact trigger — passed through to codex CLI config. */
    autoCompactTokenLimit: number;
    /** Disable OpenAI-style response storage. */
    disableResponseStorage: boolean;
    /** Enable Codex's web_search tool. */
    webSearchEnabled: boolean;
};
/** Runtime knobs applied REGARDLESS of which provider is active — sandbox
 * / approval need to work even for the pass-through `system` provider,
 * where we can't (and shouldn't) rewrite the user's ~/.codex/config.toml. */
export type CodexRuntimeOptions = {
    sandboxMode: SandboxMode;
    approvalPolicy: ApprovalMode;
};
export type CodexSettings = {
    activeProviderId: string;
    customProviders: CodexCustomProvider[];
    runtime: CodexRuntimeOptions;
};
export declare function warmCodexConfigCache(): Promise<void>;
export declare function getCodexConfig(): CodexSettings;
/** Active provider or null when the built-in `system` is selected. */
export declare function getActiveCodexProvider(): CodexCustomProvider | null;
export declare function setActiveCodexProvider(id: string): Promise<CodexSettings>;
export declare function createCodexProvider(patch: Partial<CodexCustomProvider>): Promise<CodexCustomProvider>;
export declare function updateCodexProvider(id: string, patch: Partial<CodexCustomProvider>): Promise<CodexCustomProvider>;
export declare function deleteCodexProvider(id: string): Promise<CodexSettings>;
export declare function updateCodexRuntime(patch: Partial<CodexRuntimeOptions>): Promise<CodexRuntimeOptions>;
export type PublicCodexProvider = Omit<CodexCustomProvider, 'apiKey'> & {
    configured: boolean;
};
export type PublicCodexBuiltin = {
    id: 'system';
    name: string;
    description: string;
    /** Best-effort sniff of ~/.codex/config.toml so the UI can show what
     * "system default" points at. null = file missing/unparseable. */
    detectedEndpoint: string | null;
    detectedModel: string | null;
};
export type PublicCodexSettings = {
    activeProviderId: string;
    builtins: PublicCodexBuiltin[];
    customProviders: PublicCodexProvider[];
    runtime: CodexRuntimeOptions;
};
export declare function readPublicCodexSettings(): Promise<PublicCodexSettings>;
//# sourceMappingURL=codex-config.d.ts.map