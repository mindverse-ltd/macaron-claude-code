// Vendored from MindLab-Research/macaron-genui-demo lib/genui-cli/src/diagnostics.ts.
// Pure (no node/ts/vite) so the server can import it directly. Formatted output is fed back
// to the model as the render_ui tool_result, identical to how the upstream host feeds it.
export type GenUIDiagnostic = { message: string; severity?: "error" | "warning"; startLineNumber?: number; startColumn?: number };
export type GenUIDiagnosticBag = Record<string, GenUIDiagnostic[]>;

const formatDiagnostic = (diagnostic: GenUIDiagnostic) => {
  const loc = diagnostic.startLineNumber ? ` (line ${diagnostic.startLineNumber}${diagnostic.startColumn ? `:${diagnostic.startColumn}` : ""})` : "";
  const tag = diagnostic.severity === "warning" ? " [warning]" : "";
  return `  - ${diagnostic.message}${loc}${tag}`;
};
export const formatDiagnosticsBag = (bag: GenUIDiagnosticBag) =>
  Object.entries(bag)
    .filter(([, items]) => items.length)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([owner, items]) => [`[${owner}]`, ...items.map(formatDiagnostic)].join("\n"))
    .join("\n");
export const hasErrorDiagnostic = (bag?: GenUIDiagnosticBag) => bag !== undefined && Object.values(bag).some((items) => items.some((diagnostic) => diagnostic.severity !== "warning"));
export type GenUICheckResult = { ok: boolean; diagnostics?: string };
export const createCheckResult = (bag: GenUIDiagnosticBag): GenUICheckResult => {
  const diagnostics = formatDiagnosticsBag(bag);
  return { ok: !hasErrorDiagnostic(bag), ...(diagnostics ? { diagnostics } : {}) };
};
