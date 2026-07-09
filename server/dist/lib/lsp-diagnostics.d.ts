import type { Diagnostic } from '@macaron/shared';
export declare function getFileDiagnostics(absPath: string, rootDir?: string): Diagnostic[];
export declare function reportForAgent(file: string, diagnostics: Diagnostic[]): string;
//# sourceMappingURL=lsp-diagnostics.d.ts.map