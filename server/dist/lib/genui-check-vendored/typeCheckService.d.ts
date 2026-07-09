import type TypeScript from "typescript";
export type TypeCheckService = {
    ts: typeof TypeScript;
    appFile: string;
    appSource: string;
    appVersion: number;
    service: TypeScript.LanguageService;
};
export declare const DEFAULT_APP_FILENAME = "App.tsx";
export declare const DEFAULT_MAX_REPORTED = 16;
export declare const diagnosticMessage: (ts: typeof TypeScript, diagnostic: TypeScript.Diagnostic) => string;
export declare const createTypeCheckService: (ts: typeof TypeScript, { root, filename, compilerOptions, ambient }: {
    root: string;
    filename: string;
    compilerOptions: TypeScript.CompilerOptions;
    ambient?: string;
}) => TypeCheckService;
//# sourceMappingURL=typeCheckService.d.ts.map