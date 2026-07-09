// Server-side GenUI diagnostics for render_ui. TS semantic diagnostics over Claude's TSX, with
// $macaron/ui resolved to the REAL vendored source via compilerOptions.paths — so facade misuse
// (bad props, missing exports) surfaces with the actual valid types, not degraded to `any`. The
// LanguageService scaffolding + bag formatting come from @genui/diagnostics (the same modules the
// upstream genui-cli standalone check/lint path uses), so host and CLI format identically.
import { existsSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { createCheckResult } from "@genui/diagnostics";
import { createTypeCheckService, DEFAULT_APP_FILENAME, DEFAULT_MAX_REPORTED, diagnosticMessage } from "@genui/diagnostics/type-check";
import { WEB_ROOT } from "../config.js";
// Facade -> vendored source on disk, relative to WEB_ROOT (the tsconfig dir). Only specifiers the
// browser resolves to OUR vendored source belong here; bare npm packages (lucide-react, motion)
// are deliberately omitted so TS resolves them through web/node_modules with their real types —
// mapping lucide-react here would shadow node_modules and make the facade (export * from
// "lucide-react") import itself, collapsing every icon export. $macaron/ui/katex is NOT mapped:
// the vendored source exists but the browser has no katex shim, so the check must reject it.
// `framer-motion` -> motion/react: the browser shim serves framer-motion and motion from one API
// (motion v12 is framer-motion renamed), but only `motion` is in web/node_modules, so alias
// framer-motion onto motion/react's types. (motion's .d.ts re-exports framer-motion, so
// AnimatePresence etc. degrade the same way they do for a native `motion/react` import — matching
// the browser shim's behavior rather than emitting a false TS2307.)
// `@/` entries exist for source.tsx's OWN internal imports (@/components/ui/*, @/lib/*) — the
// browser's BASE_IMPORTS has no @/ entries (and esm.sh can't resolve @/), so user TSX should not
// import @/ directly; the tool description already forbids bare/relative imports.
const FACADE_PATHS = {
    "$macaron/ui": ["./src/macaron-vendor/macaron/source.tsx"],
    "$macaron/ui/charts": ["./src/macaron-vendor/genui/charts.tsx"],
    "framer-motion": ["./node_modules/motion/react"],
    "@/components/ui/*": ["./src/macaron-vendor/components/ui/*"],
    "@/lib/*": ["./src/macaron-vendor/lib/*"],
    "@/*": ["./src/macaron-vendor/*"],
};
const compilerOptions = {
    noEmit: true, strict: true, skipLibCheck: true,
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX, jsxImportSource: "react",
    esModuleInterop: true, types: ["react", "react-dom"], paths: FACADE_PATHS,
};
// The tool description permits esm.sh/http URL imports for tiny React-free helpers, and the
// browser fetches them natively — but moduleResolution: Bundler can't resolve URL specifiers.
// Ambient-declare them as `any` so the check doesn't TS2307 code the browser renders fine.
// $macaron/chat is a runtime shim (.mjs, no .tsx source to map via FACADE_PATHS), so declare
// its types ambiently — user TSX importing sendUserMessage gets real signature checking
// instead of a TS2307.
const AMBIENT_DECLARATIONS = `declare module "https://*";\ndeclare module "http://*";\n` +
    `declare module "$macaron/chat" {\n  export function sendUserMessage(prompt: string): void;\n}\n`;
const toDiag = (d) => {
    const message = diagnosticMessage(ts, d);
    if (!d.file || d.start === undefined)
        return { message };
    const s = d.file.getLineAndCharacterOfPosition(d.start);
    return { message, startLineNumber: s.line + 1, startColumn: s.character + 1 };
};
// LanguageService is expensive to build; one shared service handles every render_ui call. The
// `serviceUnavailable` latch marks "diagnostics permanently off" (e.g. the published CLI ships no
// web/src, so the vendored facades can't resolve) — in that state checkGenUI no-ops to an ack
// rather than surfacing phantom errors or crashing.
let service;
let serviceUnavailable = false;
// Syntactic (unclosed JSX, stray tokens — the `lint` pass) + semantic (types, missing exports —
// the `check` pass) error diagnostics, folded into one bag. Empty code is a runtime diagnostic,
// not a TS one. `ok:false` diagnostics go into the render_ui tool_result for in-turn self-repair.
// Never throws: a TS check failure must not turn a render the user is already viewing into a
// tool_use_error — degrade to an ack instead.
export const checkGenUI = (code) => {
    if (!code.trim())
        return createCheckResult({ runtime: [{ message: "render_ui received empty TSX code." }] });
    if (serviceUnavailable)
        return { ok: true };
    try {
        if (!service) {
            // Published `mcc` ships only web/dist (no web/src), so the facades can't resolve — bail to
            // an ack. The dev/source checkout always has web/src/macaron-vendor.
            if (!existsSync(path.join(WEB_ROOT, "src", "macaron-vendor"))) {
                serviceUnavailable = true;
                return { ok: true };
            }
            service = createTypeCheckService(ts, { root: WEB_ROOT, filename: DEFAULT_APP_FILENAME, compilerOptions, ambient: AMBIENT_DECLARATIONS });
        }
        const svc = service;
        svc.appSource = code;
        svc.appVersion += 1;
        const all = [...svc.service.getSyntacticDiagnostics(svc.appFile), ...svc.service.getSemanticDiagnostics(svc.appFile)];
        const typescript = all.filter((d) => d.category === ts.DiagnosticCategory.Error).slice(0, DEFAULT_MAX_REPORTED).map(toDiag);
        return createCheckResult({ typescript });
    }
    catch (err) {
        serviceUnavailable = true;
        service = undefined;
        return { ok: true };
    }
};
//# sourceMappingURL=genui-check.js.map