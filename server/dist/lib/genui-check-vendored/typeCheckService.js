// Vendored from MindLab-Research/macaron-genui-demo lib/genui-cli/src/typeCheckService.ts
// (upstream's getErrorDiagnostics dropped — superseded by the syntactic+semantic pass in genui-check.ts).
// TS LanguageService scaffolding over one virtual App.tsx; runs diagnostics against the vendored
// $macaron/ui source via compilerOptions.paths.
import path from "node:path";
export const DEFAULT_APP_FILENAME = "App.tsx";
export const DEFAULT_MAX_REPORTED = 16;
export const diagnosticMessage = (ts, diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
export const createTypeCheckService = (ts, { root, filename, compilerOptions, ambient }) => {
    const appFile = path.join(root, ".genui-check", filename);
    const ambientFile = path.join(root, ".genui-check", "genui-ambient.d.ts");
    const defaultLibFile = ts.getDefaultLibFilePath(compilerOptions);
    let service;
    const serviceState = { ts, appFile, appSource: "", appVersion: 0, get service() { return service; } };
    // Cache snapshots for immutable files (version "0" = unchanged). Without this, TS's program sync
    // re-reads all 821 lib/vendor files from disk on every diagnose (~10ms + 4.9MB/call GC churn).
    const snapshotCache = new Map();
    const host = {
        getCompilationSettings: () => compilerOptions,
        getCurrentDirectory: () => root,
        getDefaultLibFileName: () => defaultLibFile,
        getScriptFileNames: () => (ambient === undefined ? [appFile] : [appFile, ambientFile]),
        getScriptSnapshot: (fileName) => {
            const resolved = path.resolve(fileName);
            if (resolved === appFile)
                return ts.ScriptSnapshot.fromString(serviceState.appSource);
            if (resolved === ambientFile)
                return ambient === undefined ? undefined : ts.ScriptSnapshot.fromString(ambient);
            let cached = snapshotCache.get(resolved);
            if (!cached) {
                const text = ts.sys.readFile(fileName);
                if (text !== undefined) {
                    cached = ts.ScriptSnapshot.fromString(text);
                    snapshotCache.set(resolved, cached);
                }
            }
            return cached;
        },
        getScriptVersion: (fileName) => (path.resolve(fileName) === appFile ? String(serviceState.appVersion) : "0"),
        fileExists: ts.sys.fileExists, readFile: ts.sys.readFile, readDirectory: ts.sys.readDirectory,
        directoryExists: ts.sys.directoryExists, getDirectories: ts.sys.getDirectories, realpath: ts.sys.realpath,
        useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    };
    service = ts.createLanguageService(host);
    return serviceState;
};
//# sourceMappingURL=typeCheckService.js.map