// General-purpose TS/JS diagnostics for files the agent edits via the built-in
// Edit/Write/MultiEdit tools — the generalization of genui-check.ts (which is
// pinned to render_ui's TSX + the $macaron/ui facade config). Here we resolve
// the edited file's nearest tsconfig.json and run a LanguageService rooted at
// it, so the project's real compilerOptions/paths/types apply. One cached
// service per tsconfig. Never throws: a check failure degrades to no diagnostics
// rather than turning a successful edit into an error.
import path from 'node:path';
import ts from 'typescript';
import type { Diagnostic } from '@macaron/shared';

const TS_JS_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const MAX_REPORTED = 50;

type Entry = { service: ts.LanguageService; versions: Map<string, number>; roots: Set<string>; cwd: string };
const byConfig = new Map<string, Entry>();

function getEntry(tsconfig: string): Entry {
  const hit = byConfig.get(tsconfig);
  if (hit) return hit;
  const cwd = path.dirname(tsconfig);
  const configFile = ts.readConfigFile(tsconfig, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(configFile.config ?? {}, ts.sys, cwd);
  const versions = new Map<string, number>();
  const roots = new Set<string>(parsed.fileNames);
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => Array.from(roots),
    getScriptVersion: (f) => String(versions.get(f) ?? 0),
    getScriptSnapshot: (f) => { const text = ts.sys.readFile(f); return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text); },
    getCurrentDirectory: () => cwd,
    getCompilationSettings: () => parsed.options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  const entry: Entry = { service: ts.createLanguageService(host, ts.createDocumentRegistry()), versions, roots, cwd };
  byConfig.set(tsconfig, entry);
  return entry;
}

const toDiag = (d: ts.Diagnostic): Diagnostic | null => {
  const severity = d.category === ts.DiagnosticCategory.Error ? 'error' : d.category === ts.DiagnosticCategory.Warning ? 'warning' : null;
  if (!severity) return null;
  const message = ts.flattenDiagnosticMessageText(d.messageText, '\n');
  if (!d.file || d.start === undefined) return { severity, line: 1, col: 1, message };
  const p = d.file.getLineAndCharacterOfPosition(d.start);
  return { severity, line: p.line + 1, col: p.character + 1, message };
};

// Diagnostics for a single edited file. [] when it's not TS/JS, has no reachable
// tsconfig, or a check throws — silence beats phantom errors on a good edit.
export function getFileDiagnostics(absPath: string): Diagnostic[] {
  if (!TS_JS_EXT.has(path.extname(absPath))) return [];
  try {
    const tsconfig = ts.findConfigFile(path.dirname(absPath), ts.sys.fileExists, 'tsconfig.json');
    if (!tsconfig) return [];
    const e = getEntry(tsconfig);
    e.roots.add(absPath);
    e.versions.set(absPath, (e.versions.get(absPath) ?? 0) + 1);
    const all = [...e.service.getSyntacticDiagnostics(absPath), ...e.service.getSemanticDiagnostics(absPath)];
    return all.map(toDiag).filter((d): d is Diagnostic => d !== null).slice(0, MAX_REPORTED);
  } catch {
    return [];
  }
}

// Errors-only block fed back to the agent, matching OpenCode's diagnostic.ts
// format (ERROR [line:col] message, capped). Warnings are surfaced in the UI
// but omitted here so the model isn't nagged about lint-level noise.
export function reportForAgent(file: string, diagnostics: Diagnostic[]): string {
  const errors = diagnostics.filter((d) => d.severity === 'error');
  if (errors.length === 0) return '';
  const CAP = 20;
  const limited = errors.slice(0, CAP);
  const more = errors.length - CAP;
  const suffix = more > 0 ? `\n... and ${more} more` : '';
  const lines = limited.map((d) => `ERROR [${d.line}:${d.col}] ${d.message}`).join('\n');
  return `<diagnostics file="${file}">\n${lines}${suffix}\n</diagnostics>`;
}
