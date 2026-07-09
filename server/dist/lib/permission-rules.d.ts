export declare function computeRuleKeys(toolName: string, input: unknown): {
    keys: string[];
    label: string;
};
export declare function warmPermissionRulesCache(): Promise<void>;
export declare function isAllowed(sid: string, cwd: string, keys: string[]): boolean;
export declare function rememberSession(sid: string, keys: string[]): void;
export declare function rememberProject(cwd: string, keys: string[]): Promise<void>;
//# sourceMappingURL=permission-rules.d.ts.map