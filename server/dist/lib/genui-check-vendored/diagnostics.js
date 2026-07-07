const formatDiagnostic = (diagnostic) => {
    const loc = diagnostic.startLineNumber ? ` (line ${diagnostic.startLineNumber}${diagnostic.startColumn ? `:${diagnostic.startColumn}` : ""})` : "";
    const tag = diagnostic.severity === "warning" ? " [warning]" : "";
    return `  - ${diagnostic.message}${loc}${tag}`;
};
export const formatDiagnosticsBag = (bag) => Object.entries(bag)
    .filter(([, items]) => items.length)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([owner, items]) => [`[${owner}]`, ...items.map(formatDiagnostic)].join("\n"))
    .join("\n");
export const hasErrorDiagnostic = (bag) => bag !== undefined && Object.values(bag).some((items) => items.some((diagnostic) => diagnostic.severity !== "warning"));
export const createCheckResult = (bag) => {
    const diagnostics = formatDiagnosticsBag(bag);
    return { ok: !hasErrorDiagnostic(bag), ...(diagnostics ? { diagnostics } : {}) };
};
//# sourceMappingURL=diagnostics.js.map