export type GenUIDiagnostic = {
    message: string;
    severity?: "error" | "warning";
    startLineNumber?: number;
    startColumn?: number;
};
export type GenUIDiagnosticBag = Record<string, GenUIDiagnostic[]>;
export declare const formatDiagnosticsBag: (bag: GenUIDiagnosticBag) => string;
export declare const hasErrorDiagnostic: (bag?: GenUIDiagnosticBag) => boolean;
export type GenUICheckResult = {
    ok: boolean;
    diagnostics?: string;
};
export declare const createCheckResult: (bag: GenUIDiagnosticBag) => GenUICheckResult;
//# sourceMappingURL=diagnostics.d.ts.map