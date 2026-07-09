import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// src/index.ts
import { existsSync as existsSync4 } from "node:fs";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";

// src/config.ts
import os from "node:os";
import path from "node:path";
var PORT = parseInt(process.env.MACARON_PORT || "7878", 10);
var HOST = process.env.MACARON_HOST || "127.0.0.1";
var AUTH_TOKEN = process.env.MACARON_AUTH_TOKEN || "";
var MACARON_API_BASE = process.env.MACARON_API_BASE || "";
var MACARON_API_KEY = process.env.MACARON_API_KEY || "";
var MACARON_MODEL = process.env.MACARON_MODEL || "macaron-0.6";
var HOME = os.homedir();
var CLAUDE_PROJECTS = path.join(HOME, ".claude", "projects");
var WEB_ROOT = path.resolve(import.meta.dirname, "..", "..", "web");
var WEB_DIST = path.join(WEB_ROOT, "dist");

// src/lib/auth.ts
import { randomBytes, timingSafeEqual } from "node:crypto";
function isLoopback(ip) {
  if (!ip)
    return false;
  return ip === "127.0.0.1" || ip === "::1" || ip.startsWith("127.") || ip === "::ffff:127.0.0.1" || ip.startsWith("::ffff:127.");
}
function isLoopbackHost(host) {
  return host === "localhost" || host === "::1" || host === "127.0.0.1" || host.startsWith("127.");
}
function tokensMatch(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length)
    return false;
  return timingSafeEqual(ab, bb);
}
function resolveToken(host, configured) {
  if (configured)
    return { token: configured, generated: false };
  if (!isLoopbackHost(host))
    return { token: randomBytes(24).toString("base64url"), generated: true };
  return { token: "", generated: false };
}
function isProtectedPath(url) {
  return url.startsWith("/api/") || url.startsWith("/relay/");
}
function isExemptPath(url) {
  return url === "/api/health" || url.startsWith("/api/auth/");
}
function routePath(req) {
  return req.routeOptions?.url ?? req.url;
}
function extractToken(req) {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer "))
    return header.slice(7);
  const q = req.query?.token;
  return typeof q === "string" ? q : "";
}
function redactTokenInUrl(url) {
  return url.replace(/([?&]token=)[^&#]*/gi, "$1[redacted]");
}
function makeAuthHook(token) {
  return function authHook(req, reply, done) {
    const path2 = routePath(req);
    if (!token || isLoopback(req.ip) || !isProtectedPath(path2) || isExemptPath(path2))
      return done();
    if (tokensMatch(extractToken(req), token))
      return done();
    reply.code(401).send({ error: "authentication required", authRequired: true });
  };
}

// src/lib/settings-store.ts
import { promises as fs, mkdirSync, existsSync, symlinkSync, lstatSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os2 from "node:os";
import path2 from "node:path";
var SYSTEM_PROVIDER_ID = "system";
var LEGACY_ANTHROPIC_ID = "anthropic";
var DEFAULT_MACARON_BASE = "https://b200-glm51-global-0615-exhrgwayh0b2hkac.z03.azurefd.net/v1";
var DEFAULT_MACARON_MODEL = "macaron-0.6";
var DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-7";
var CONFIG_PATH = path2.join(HOME, ".claude", "macaron-config.json");
var cache = null;
function seedMacaronProvider() {
  return {
    id: randomUUID(),
    name: "Macaron",
    endpoint: MACARON_API_BASE || DEFAULT_MACARON_BASE,
    model: DEFAULT_MACARON_MODEL,
    apiKey: MACARON_API_KEY || ""
  };
}
function makeDefaults() {
  return {
    activeProviderId: SYSTEM_PROVIDER_ID,
    customProviders: [seedMacaronProvider()],
    yoloMode: false,
    followupSuggestions: false
  };
}
function normalizeActiveId(id) {
  return id === LEGACY_ANTHROPIC_ID ? SYSTEM_PROVIDER_ID : id;
}
function migrateIfLegacy(raw) {
  const legacy = raw;
  if (legacy && Array.isArray(legacy.customProviders)) {
    return {
      activeProviderId: normalizeActiveId(legacy.activeProviderId || SYSTEM_PROVIDER_ID),
      customProviders: legacy.customProviders.map(sanitizeProvider),
      yoloMode: Boolean(legacy.yoloMode),
      followupSuggestions: Boolean(legacy.followupSuggestions)
    };
  }
  const macaron = {
    id: randomUUID(),
    name: "Macaron",
    endpoint: MACARON_API_BASE || DEFAULT_MACARON_BASE,
    model: DEFAULT_MACARON_MODEL,
    apiKey: legacy?.providers?.macaron?.apiKey || MACARON_API_KEY || ""
  };
  const wasMacaronActive = legacy?.provider === "macaron";
  return {
    activeProviderId: wasMacaronActive ? macaron.id : SYSTEM_PROVIDER_ID,
    customProviders: [macaron],
    yoloMode: Boolean(legacy?.yoloMode),
    followupSuggestions: Boolean(legacy?.followupSuggestions)
  };
}
function sanitizeProvider(p) {
  return {
    id: String(p.id || randomUUID()),
    name: String(p.name || "").trim() || "Unnamed provider",
    endpoint: String(p.endpoint || "").trim(),
    model: String(p.model || "").trim(),
    apiKey: String(p.apiKey || "")
  };
}
async function loadFromDisk() {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    return migrateIfLegacy(JSON.parse(raw));
  } catch {
    return makeDefaults();
  }
}
async function persist() {
  if (!cache)
    return;
  await fs.mkdir(path2.dirname(CONFIG_PATH), { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(cache, null, 2), "utf8");
}
async function readSettings() {
  if (!cache)
    cache = await loadFromDisk();
  return cache;
}
async function warmSettingsCache() {
  await readSettings();
  await persist();
}
async function readPublicSettings() {
  const s = await readSettings();
  const envBase = process.env.ANTHROPIC_BASE_URL || "";
  const usingRelay = Boolean(envBase);
  return {
    activeProviderId: s.activeProviderId,
    builtins: [
      {
        id: SYSTEM_PROVIDER_ID,
        name: "System default",
        description: usingRelay ? "Passes through your shell's ANTHROPIC_BASE_URL — the SDK will hit your configured relay/gateway. We don't touch anything." : "Uses your Claude Code login untouched. We don't override any env vars.",
        detectedEndpoint: usingRelay ? envBase : null
      }
    ],
    customProviders: s.customProviders.map((p) => ({
      id: p.id,
      name: p.name,
      endpoint: p.endpoint,
      model: p.model,
      configured: Boolean(p.apiKey)
    })),
    yoloMode: s.yoloMode,
    followupSuggestions: s.followupSuggestions
  };
}
async function addProvider(input) {
  const s = await readSettings();
  const created = sanitizeProvider({ ...input, id: randomUUID() });
  s.customProviders.push(created);
  await persist();
  return created;
}
async function updateProvider(id, patch) {
  const s = await readSettings();
  const idx = s.customProviders.findIndex((p) => p.id === id);
  if (idx < 0)
    return null;
  const cur = s.customProviders[idx];
  const next = sanitizeProvider({
    id: cur.id,
    name: patch.name ?? cur.name,
    endpoint: patch.endpoint ?? cur.endpoint,
    model: patch.model ?? cur.model,
    apiKey: patch.apiKey && patch.apiKey.length > 0 ? patch.apiKey : cur.apiKey
  });
  s.customProviders[idx] = next;
  await persist();
  return next;
}
async function deleteProvider(id) {
  const s = await readSettings();
  const before = s.customProviders.length;
  s.customProviders = s.customProviders.filter((p) => p.id !== id);
  if (s.customProviders.length === before)
    return false;
  if (s.activeProviderId === id)
    s.activeProviderId = SYSTEM_PROVIDER_ID;
  await persist();
  return true;
}
async function setActiveProvider(id) {
  const s = await readSettings();
  if (id !== SYSTEM_PROVIDER_ID && !s.customProviders.some((p) => p.id === id)) {
    return false;
  }
  s.activeProviderId = id;
  await persist();
  return true;
}
var ISOLATED_CONFIG_DIR = path2.join(os2.tmpdir(), "macaron-plugin-isolated-claude");
var isolatedDirReady = false;
function ensureIsolatedDir() {
  if (!isolatedDirReady) {
    if (!existsSync(ISOLATED_CONFIG_DIR))
      mkdirSync(ISOLATED_CONFIG_DIR, { recursive: true });
    const projectsLink = path2.join(ISOLATED_CONFIG_DIR, "projects");
    const realProjects = path2.join(HOME, ".claude", "projects");
    if (!existsSync(realProjects))
      mkdirSync(realProjects, { recursive: true });
    try {
      const st = lstatSync(projectsLink);
      if (!st.isSymbolicLink()) {
        fs.rm(projectsLink, { recursive: true, force: true }).catch(() => {});
        symlinkSync(realProjects, projectsLink);
      }
    } catch {
      try {
        symlinkSync(realProjects, projectsLink);
      } catch {}
    }
    isolatedDirReady = true;
  }
  return ISOLATED_CONFIG_DIR;
}
function getActiveProviderRaw() {
  const s = cache ?? makeDefaults();
  if (s.activeProviderId === SYSTEM_PROVIDER_ID)
    return null;
  const p = s.customProviders.find((x) => x.id === s.activeProviderId);
  if (!p)
    return null;
  return { id: p.id, name: p.name, endpoint: p.endpoint, model: p.model, apiKey: p.apiKey };
}
function getYoloMode() {
  return (cache ?? makeDefaults()).yoloMode ?? false;
}
async function setYoloMode(enabled) {
  const s = await readSettings();
  s.yoloMode = Boolean(enabled);
  await persist();
}
function getFollowupSuggestionsEnabled() {
  return (cache ?? makeDefaults()).followupSuggestions ?? false;
}
async function setFollowupSuggestionsEnabled(enabled) {
  const s = await readSettings();
  s.followupSuggestions = Boolean(enabled);
  await persist();
}
function getActiveProviderEnv() {
  const s = cache ?? makeDefaults();
  if (s.activeProviderId === SYSTEM_PROVIDER_ID) {
    return { model: DEFAULT_ANTHROPIC_MODEL, env: null };
  }
  const p = s.customProviders.find((x) => x.id === s.activeProviderId);
  if (!p)
    return { model: DEFAULT_ANTHROPIC_MODEL, env: null };
  const isolatedDir = ensureIsolatedDir();
  const relayBase = `http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT}/relay/anthropic/${p.id}`;
  return {
    model: p.model || DEFAULT_ANTHROPIC_MODEL,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: isolatedDir,
      CLAUDE_CODE_OAUTH_TOKEN: "",
      ANTHROPIC_BASE_URL: relayBase,
      ANTHROPIC_AUTH_TOKEN: p.apiKey,
      ANTHROPIC_API_KEY: p.apiKey,
      ANTHROPIC_MODEL: p.model || DEFAULT_ANTHROPIC_MODEL
    }
  };
}

// src/lib/permission-rules.ts
import { promises as fs2 } from "node:fs";
import path3 from "node:path";
var PERMS_PATH = path3.join(HOME, ".claude", "macaron-permissions.json");
var cache2 = null;
var sessionRules = new Map;
var TWO_WORD = new Set(["sudo", "git", "npm", "pnpm", "yarn", "bun", "npx", "bunx", "pnpx", "docker", "cargo", "go", "kubectl"]);
function splitCompound(cmd) {
  const parts = [];
  let cur = "";
  let quote = null;
  for (let i = 0;i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      cur += c;
      if (c === quote)
        quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      cur += c;
      continue;
    }
    if (cmd.slice(i, i + 2) === "&&" || cmd.slice(i, i + 2) === "||") {
      parts.push(cur);
      cur = "";
      i++;
      continue;
    }
    if (c === ";" || c === "|" || c === "&" || c === `
` || c === "\r") {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}
function bashPrefix(segment) {
  const words = segment.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]))
    i++;
  const first = words[i];
  if (!first)
    return null;
  const second = words[i + 1];
  if (TWO_WORD.has(first) && second && !second.startsWith("-"))
    return `${first} ${second}`;
  return first;
}
function computeRuleKeys(toolName, input) {
  if (toolName !== "Bash")
    return { keys: [toolName], label: toolName };
  const command = String(input?.command ?? "");
  const prefixes = [];
  for (const seg of splitCompound(command)) {
    const p = bashPrefix(seg);
    if (p && !prefixes.includes(p))
      prefixes.push(p);
  }
  if (prefixes.length === 0)
    return { keys: [], label: "" };
  return { keys: prefixes.map((p) => `Bash(${p})`), label: prefixes.join(", ") };
}
async function load() {
  try {
    const parsed = JSON.parse(await fs2.readFile(PERMS_PATH, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.projects) {
      return { version: parsed.version || 1, projects: parsed.projects };
    }
  } catch {}
  return { version: 1, projects: {} };
}
async function persist2() {
  if (!cache2)
    return;
  await fs2.mkdir(path3.dirname(PERMS_PATH), { recursive: true });
  await fs2.writeFile(PERMS_PATH, JSON.stringify(cache2, null, 2), "utf8");
}
async function warmPermissionRulesCache() {
  if (!cache2)
    cache2 = await load();
}
function isAllowed(sid, cwd, keys) {
  if (keys.length === 0)
    return false;
  const sess = sid ? sessionRules.get(sid) : undefined;
  const proj = cache2?.projects[cwd];
  const projSet = proj ? new Set(proj) : null;
  return keys.every((k) => sess?.has(k) || projSet?.has(k) || false);
}
function rememberSession(sid, keys) {
  if (!sid || keys.length === 0)
    return;
  let set = sessionRules.get(sid);
  if (!set) {
    set = new Set;
    sessionRules.set(sid, set);
  }
  for (const k of keys)
    set.add(k);
}
var writeChain = Promise.resolve();
async function rememberProject(cwd, keys) {
  if (!cwd || keys.length === 0)
    return;
  const run = writeChain.then(async () => {
    if (!cache2)
      cache2 = await load();
    const cur = new Set(cache2.projects[cwd] || []);
    for (const k of keys)
      cur.add(k);
    cache2.projects[cwd] = [...cur];
    await persist2();
  });
  writeChain = run.catch(() => {});
  return run;
}

// src/lib/codex-config.ts
import { promises as fs3 } from "node:fs";
import { randomUUID as randomUUID2 } from "node:crypto";
import path4 from "node:path";
var CODEX_SYSTEM_PROVIDER_ID = "system";
var CONFIG_PATH2 = path4.join(HOME, ".claude", "macaron-codex-config.json");
function seededCustomProvider() {
  return {
    id: randomUUID2(),
    name: "Macaron GLM",
    baseUrl: "https://pi-api-cn.macaron.xin/v1",
    apiKey: process.env.MACARON_CODEX_API_KEY || "",
    model: "gpt-5.5",
    wireApi: "responses",
    modelProvider: "OpenAI",
    reasoningEffort: "high",
    contextWindow: 200000,
    autoCompactTokenLimit: 180000,
    disableResponseStorage: true,
    webSearchEnabled: false
  };
}
function defaults() {
  return {
    activeProviderId: CODEX_SYSTEM_PROVIDER_ID,
    customProviders: [seededCustomProvider()],
    runtime: { sandboxMode: "workspace-write", approvalPolicy: "never" }
  };
}
function migrateIfLegacy2(raw) {
  const r = raw;
  if (r && Array.isArray(r.customProviders)) {
    const d = defaults();
    return {
      activeProviderId: r.activeProviderId || CODEX_SYSTEM_PROVIDER_ID,
      customProviders: r.customProviders.map(sanitize),
      runtime: { ...d.runtime, ...r.runtime || {} }
    };
  }
  const legacy = r?.provider;
  if (!legacy)
    return defaults();
  const migrated = sanitize({
    id: randomUUID2(),
    name: String(legacy.name || "Legacy provider"),
    baseUrl: String(legacy.baseUrl || ""),
    apiKey: String(legacy.apiKey || ""),
    model: String(legacy.model || "gpt-5.5"),
    wireApi: legacy.wireApi === "chat" ? "chat" : "responses",
    modelProvider: String(legacy.modelProvider || "OpenAI"),
    reasoningEffort: legacy.reasoningEffort || "high",
    contextWindow: Number(legacy.contextWindow || 200000),
    autoCompactTokenLimit: Number(legacy.autoCompactTokenLimit || 180000),
    disableResponseStorage: legacy.disableResponseStorage !== false,
    webSearchEnabled: Boolean(legacy.webSearchEnabled)
  });
  return {
    activeProviderId: legacy.apiKey ? migrated.id : CODEX_SYSTEM_PROVIDER_ID,
    customProviders: [migrated],
    runtime: {
      sandboxMode: legacy.sandboxMode || "workspace-write",
      approvalPolicy: legacy.approvalPolicy || "never"
    }
  };
}
function sanitize(p) {
  return {
    id: String(p.id || randomUUID2()),
    name: String(p.name || "Unnamed provider").trim(),
    baseUrl: String(p.baseUrl || "").trim(),
    apiKey: String(p.apiKey || ""),
    model: String(p.model || "gpt-5.5").trim(),
    wireApi: p.wireApi === "chat" ? "chat" : "responses",
    modelProvider: String(p.modelProvider || "OpenAI").trim(),
    reasoningEffort: p.reasoningEffort || "high",
    contextWindow: Number(p.contextWindow) > 0 ? Number(p.contextWindow) : 200000,
    autoCompactTokenLimit: Number(p.autoCompactTokenLimit) > 0 ? Number(p.autoCompactTokenLimit) : 180000,
    disableResponseStorage: p.disableResponseStorage !== false,
    webSearchEnabled: Boolean(p.webSearchEnabled)
  };
}
var cache3 = null;
async function loadFromDisk2() {
  try {
    const raw = await fs3.readFile(CONFIG_PATH2, "utf8");
    return migrateIfLegacy2(JSON.parse(raw));
  } catch {
    return defaults();
  }
}
async function persist3() {
  if (!cache3)
    return;
  await fs3.mkdir(path4.dirname(CONFIG_PATH2), { recursive: true });
  await fs3.writeFile(CONFIG_PATH2, JSON.stringify(cache3, null, 2), "utf8");
}
async function warmCodexConfigCache() {
  cache3 = await loadFromDisk2();
  await persist3();
}
function getCodexConfig() {
  return cache3 ?? defaults();
}
function getActiveCodexProvider() {
  const s = cache3 ?? defaults();
  if (s.activeProviderId === CODEX_SYSTEM_PROVIDER_ID)
    return null;
  return s.customProviders.find((p) => p.id === s.activeProviderId) ?? null;
}
async function setActiveCodexProvider(id) {
  if (!cache3)
    cache3 = await loadFromDisk2();
  const isSystem = id === CODEX_SYSTEM_PROVIDER_ID;
  const known = isSystem || cache3.customProviders.some((p) => p.id === id);
  if (!known)
    throw new Error(`unknown providerId: ${id}`);
  cache3.activeProviderId = id;
  await persist3();
  return cache3;
}
async function createCodexProvider(patch) {
  if (!cache3)
    cache3 = await loadFromDisk2();
  const seed = seededCustomProvider();
  const created = sanitize({ ...seed, ...patch, id: randomUUID2() });
  cache3.customProviders.push(created);
  await persist3();
  return created;
}
async function updateCodexProvider(id, patch) {
  if (!cache3)
    cache3 = await loadFromDisk2();
  const idx = cache3.customProviders.findIndex((p) => p.id === id);
  if (idx < 0)
    throw new Error(`unknown providerId: ${id}`);
  const next = sanitize({ ...cache3.customProviders[idx], ...patch, id });
  cache3.customProviders[idx] = next;
  await persist3();
  return next;
}
async function deleteCodexProvider(id) {
  if (!cache3)
    cache3 = await loadFromDisk2();
  cache3.customProviders = cache3.customProviders.filter((p) => p.id !== id);
  if (cache3.activeProviderId === id)
    cache3.activeProviderId = CODEX_SYSTEM_PROVIDER_ID;
  await persist3();
  return cache3;
}
async function updateCodexRuntime(patch) {
  if (!cache3)
    cache3 = await loadFromDisk2();
  cache3.runtime = { ...cache3.runtime, ...patch };
  await persist3();
  return cache3.runtime;
}
async function detectSystemCodex() {
  try {
    const raw = await fs3.readFile(path4.join(HOME, ".codex", "config.toml"), "utf8");
    const model = /^\s*model\s*=\s*"([^"]+)"/m.exec(raw)?.[1] ?? null;
    const endpoint = /^\s*base_url\s*=\s*"([^"]+)"/m.exec(raw)?.[1] ?? null;
    return { endpoint, model };
  } catch {
    return { endpoint: null, model: null };
  }
}
async function readPublicCodexSettings() {
  const s = cache3 ?? defaults();
  const sniff = await detectSystemCodex();
  const usingUpstream = Boolean(sniff.endpoint);
  return {
    activeProviderId: s.activeProviderId,
    builtins: [
      {
        id: CODEX_SYSTEM_PROVIDER_ID,
        name: "System default",
        description: usingUpstream ? `Uses your ~/.codex/config.toml unchanged — hits ${sniff.endpoint}.` : "Uses your ~/.codex/config.toml as-is (or Codex’s built-in defaults if none).",
        detectedEndpoint: sniff.endpoint,
        detectedModel: sniff.model
      }
    ],
    customProviders: s.customProviders.map((p) => {
      const { apiKey: _apiKey, ...rest } = p;
      return { ...rest, configured: Boolean(p.apiKey) };
    }),
    runtime: { ...s.runtime }
  };
}

// src/lib/codex-titles.ts
import { promises as fs4 } from "node:fs";
import path5 from "node:path";
var TITLES_PATH = path5.join(HOME, ".claude", "macaron-codex-titles.json");
var cache4 = null;
async function loadFromDisk3() {
  try {
    const raw = await fs4.readFile(TITLES_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
async function persist4() {
  if (!cache4)
    return;
  await fs4.mkdir(path5.dirname(TITLES_PATH), { recursive: true });
  await fs4.writeFile(TITLES_PATH, JSON.stringify(cache4, null, 2), "utf8");
}
async function warmCodexTitlesCache() {
  cache4 = await loadFromDisk3();
}
function getCodexTitle(sid) {
  return (cache4 ?? {})[sid];
}
async function setCodexTitle(sid, title) {
  if (!cache4)
    cache4 = await loadFromDisk3();
  cache4[sid] = title;
  await persist4();
}
async function deleteCodexTitle(sid) {
  if (!cache4)
    cache4 = await loadFromDisk3();
  if (!(sid in cache4))
    return;
  delete cache4[sid];
  await persist4();
}

// src/lib/genui-check.ts
import { existsSync as existsSync2 } from "node:fs";
import path6 from "node:path";
import ts from "typescript";
import { createCheckResult } from "@genui/diagnostics";
import { createTypeCheckService, DEFAULT_APP_FILENAME, DEFAULT_MAX_REPORTED, diagnosticMessage } from "@genui/diagnostics/type-check";
var FACADE_PATHS = {
  "$macaron/ui": ["./src/macaron-vendor/macaron/source.tsx"],
  "$macaron/ui/charts": ["./src/macaron-vendor/genui/charts.tsx"],
  "framer-motion": ["./node_modules/motion/react"],
  "@/components/ui/*": ["./src/macaron-vendor/components/ui/*"],
  "@/lib/*": ["./src/macaron-vendor/lib/*"],
  "@/*": ["./src/macaron-vendor/*"]
};
var compilerOptions = {
  noEmit: true,
  strict: true,
  skipLibCheck: true,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  jsxImportSource: "react",
  esModuleInterop: true,
  types: ["react", "react-dom"],
  paths: FACADE_PATHS
};
var AMBIENT_DECLARATIONS = `declare module "https://*";
declare module "http://*";
` + `declare module "$macaron/chat" {
  export function sendUserMessage(prompt: string): void;
}
`;
var toDiag = (d) => {
  const message = diagnosticMessage(ts, d);
  if (!d.file || d.start === undefined)
    return { message };
  const s = d.file.getLineAndCharacterOfPosition(d.start);
  return { message, startLineNumber: s.line + 1, startColumn: s.character + 1 };
};
var service;
var serviceUnavailable = false;
var checkGenUI = (code) => {
  if (!code.trim())
    return createCheckResult({ runtime: [{ message: "render_ui received empty TSX code." }] });
  if (serviceUnavailable)
    return { ok: true };
  try {
    if (!service) {
      if (!existsSync2(path6.join(WEB_ROOT, "src", "macaron-vendor"))) {
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
  } catch (err) {
    serviceUnavailable = true;
    service = undefined;
    return { ok: true };
  }
};

// src/routes/health.ts
async function registerHealthRoutes(app) {
  app.get("/api/health", async () => {
    const { model } = getActiveProviderEnv();
    return { ok: true, model: model || "claude-opus-4-7" };
  });
}

// src/routes/auth.ts
async function registerAuthRoutes(app, token) {
  app.get("/api/auth/status", async (req) => {
    if (!token || isLoopback(req.ip))
      return { required: false };
    return { required: !tokensMatch(extractToken(req), token) };
  });
  app.post("/api/auth/login", async (req, reply) => {
    const provided = typeof req.body?.token === "string" ? req.body.token : "";
    if (!token || tokensMatch(provided, token))
      return { ok: true };
    return reply.code(401).send({ error: "invalid token" });
  });
}

// src/routes/workspaces.ts
import { promises as fs6 } from "node:fs";
import path8 from "node:path";

// src/lib/session-store.ts
import { promises as fs5 } from "node:fs";
import { randomUUID as randomUUID3 } from "node:crypto";
import path7 from "node:path";
function basename(p) {
  if (!p)
    return "";
  return p.split("/").filter(Boolean).pop() || p;
}
function decodeClaudeProjectName(encoded) {
  return encoded.replace(/^-/, "/").replace(/-/g, "/");
}
var summaryCache = new Map;
var HEAD_BYTES = 96 * 1024;
var CWD_TAIL_BYTES = 64 * 1024;
async function deleteSession(project, sid) {
  const filePath = path7.join(CLAUDE_PROJECTS, project, `${sid}.jsonl`);
  await fs5.unlink(filePath);
  summaryCache.delete(filePath);
}
async function duplicateSession(project, sid) {
  const srcPath = path7.join(CLAUDE_PROJECTS, project, `${sid}.jsonl`);
  const raw = await fs5.readFile(srcPath, "utf8");
  const newSid = randomUUID3();
  const destPath = path7.join(CLAUDE_PROJECTS, project, `${newSid}.jsonl`);
  const outLines = [];
  for (const line of raw.split(`
`)) {
    if (!line.trim()) {
      outLines.push(line);
      continue;
    }
    try {
      const o = JSON.parse(line);
      if (typeof o.sessionId === "string")
        o.sessionId = newSid;
      outLines.push(JSON.stringify(o));
    } catch {
      outLines.push(line);
    }
  }
  let next = outLines.join(`
`);
  if (!next.endsWith(`
`))
    next += `
`;
  await fs5.writeFile(destPath, next, { encoding: "utf8", flag: "wx" });
  return { newSid };
}
async function rewindSession(project, sid, uuid) {
  const filePath = path7.join(CLAUDE_PROJECTS, project, `${sid}.jsonl`);
  const raw = await fs5.readFile(filePath, "utf8");
  const lines = raw.split(`
`);
  let cutIdx = -1;
  for (let i = 0;i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line)
      continue;
    try {
      const o = JSON.parse(line);
      if (o.uuid === uuid) {
        cutIdx = i;
        break;
      }
    } catch {}
  }
  if (cutIdx < 0) {
    throw new Error(`uuid ${uuid} not found in session`);
  }
  const keptRaw = lines.slice(0, cutIdx).join(`
`);
  const droppedRaw = lines.slice(cutIdx).join(`
`);
  const ts2 = Date.now();
  const backupPath = filePath.replace(/\.jsonl$/, `.rewind-${ts2}.jsonl.bak`);
  await fs5.writeFile(backupPath, droppedRaw, "utf8");
  const keptFinal = keptRaw.endsWith(`
`) ? keptRaw : keptRaw + `
`;
  await fs5.writeFile(filePath, keptFinal, "utf8");
  summaryCache.delete(filePath);
  const dropped = droppedRaw.split(`
`).filter((l) => l.trim()).length;
  return { dropped, backupPath };
}
async function writeCompactedSession(project, sid, summary) {
  const filePath = path7.join(CLAUDE_PROJECTS, project, `${sid}.jsonl`);
  const raw = await fs5.readFile(filePath, "utf8");
  const lines = raw.split(`
`);
  const preamble = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      preamble.push(line);
      continue;
    }
    try {
      const o = JSON.parse(t);
      if (o.type === "user" || o.type === "assistant" || o.type === "summary")
        break;
      preamble.push(line);
    } catch {
      preamble.push(line);
    }
  }
  const ts2 = Date.now();
  const backupPath = filePath.replace(/\.jsonl$/, `.pre-compact-${ts2}.jsonl.bak`);
  await fs5.writeFile(backupPath, raw, "utf8");
  const summaryLine = JSON.stringify({
    type: "summary",
    summary,
    timestamp: new Date().toISOString(),
    uuid: `compact-${ts2}`
  }) + `
`;
  const nextRaw = (preamble.length > 0 ? preamble.join(`
`).replace(/\n+$/, "") + `
` : "") + summaryLine;
  await fs5.writeFile(filePath, nextRaw, "utf8");
  summaryCache.delete(filePath);
  return { backupPath, kept: preamble.filter((l) => l.trim()).length };
}
async function mapPool(items, concurrency, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length)
        break;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
async function readSessionSummary(filePath) {
  let st;
  try {
    st = await fs5.stat(filePath);
  } catch {
    return null;
  }
  const cached = summaryCache.get(filePath);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.summary;
  }
  const summary = {
    firstUserText: "",
    cwd: "",
    gitBranch: "",
    headLines: 0,
    truncated: st.size > HEAD_BYTES,
    mtime: st.mtimeMs,
    size: st.size
  };
  try {
    const fh = await fs5.open(filePath, "r");
    try {
      const len = Math.min(st.size, HEAD_BYTES);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, 0);
      const text = buf.toString("utf8");
      const lines = text.split(`
`);
      const upto = summary.truncated ? lines.length - 1 : lines.length;
      for (let i = 0;i < upto; i++) {
        const line = lines[i];
        if (!line.trim())
          continue;
        summary.headLines++;
        if (summary.firstUserText && summary.cwd)
          continue;
        try {
          const o = JSON.parse(line);
          if (!summary.cwd && o.cwd)
            summary.cwd = o.cwd;
          if (!summary.gitBranch && o.gitBranch)
            summary.gitBranch = o.gitBranch;
          if (!summary.firstUserText && o.type === "user" && o.message?.content) {
            const c = o.message.content;
            const t = typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => b.text || "").join(" ") : "";
            if (t && !t.startsWith("<") && !t.includes("tool_result"))
              summary.firstUserText = t;
          }
        } catch {}
      }
    } finally {
      await fh.close();
    }
  } catch {}
  if (summary.truncated && !summary.cwd) {
    try {
      const fh = await fs5.open(filePath, "r");
      try {
        const len = Math.min(st.size, CWD_TAIL_BYTES);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, st.size - len);
        const text = buf.toString("utf8");
        const lines = text.split(`
`);
        for (let i = 1;i < lines.length; i++) {
          const line = lines[i];
          if (!line.trim())
            continue;
          try {
            const o = JSON.parse(line);
            if (o.cwd)
              summary.cwd = o.cwd;
            if (!summary.gitBranch && o.gitBranch)
              summary.gitBranch = o.gitBranch;
          } catch {}
        }
      } finally {
        await fh.close();
      }
    } catch {}
  }
  summaryCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, summary });
  return summary;
}
async function resolveSessionCwd(project, sid) {
  let cwd = decodeClaudeProjectName(project) || HOME || "/tmp";
  try {
    const head = await readSessionSummary(path7.join(CLAUDE_PROJECTS, project, `${sid}.jsonl`));
    if (head?.cwd)
      cwd = head.cwd;
  } catch {}
  return cwd;
}
async function listAllSessions() {
  let projects;
  try {
    projects = await fs5.readdir(CLAUDE_PROJECTS, { withFileTypes: true });
  } catch {
    return [];
  }
  const targets = [];
  await mapPool(projects.filter((p) => p.isDirectory()), 16, async (p) => {
    const projDir = path7.join(CLAUDE_PROJECTS, p.name);
    let files;
    try {
      files = await fs5.readdir(projDir);
    } catch {
      return;
    }
    for (const f of files) {
      if (f.endsWith(".jsonl")) {
        targets.push({ project: p.name, file: path7.join(projDir, f), sid: f.slice(0, -6) });
      }
    }
  });
  const summaries = await mapPool(targets, 32, async (t) => {
    const meta = await readSessionSummary(t.file);
    if (!meta)
      return null;
    const item = {
      kind: "claude",
      project: t.project,
      cwd: meta.cwd || decodeClaudeProjectName(t.project),
      gitBranch: meta.gitBranch || undefined,
      sessionId: t.sid,
      preview: (meta.firstUserText || "").slice(0, 220),
      messageCount: meta.headLines,
      messageCountSuffix: meta.truncated ? "+" : "",
      mtime: meta.mtime,
      size: meta.size,
      resumeCommand: `claude --resume ${t.sid}`
    };
    return item;
  });
  const out = summaries.filter((s) => s !== null);
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}
function groupWorkspaces(sessions) {
  const byCwd = new Map;
  for (const s of sessions) {
    const key = s.cwd || s.project;
    if (!byCwd.has(key)) {
      byCwd.set(key, {
        cwd: s.cwd,
        project: s.project,
        name: basename(s.cwd) || s.project,
        sessionCount: 0,
        lastActivity: 0,
        lastSessionId: "",
        lastPreview: ""
      });
    }
    const w = byCwd.get(key);
    w.sessionCount++;
    if (s.mtime > w.lastActivity) {
      w.lastActivity = s.mtime;
      w.lastSessionId = s.sessionId;
      w.lastPreview = s.preview;
      w.project = s.project;
    }
  }
  const arr = Array.from(byCwd.values());
  arr.sort((a, b) => b.lastActivity - a.lastActivity);
  return arr;
}
var SESSION_TAIL_BYTES = 8 * 1024 * 1024;
async function readSessionMessages(project, sid) {
  const filePath = path7.join(CLAUDE_PROJECTS, project, `${sid}.jsonl`);
  const st = await fs5.stat(filePath);
  let raw;
  let truncated = false;
  if (st.size > SESSION_TAIL_BYTES) {
    truncated = true;
    const fh = await fs5.open(filePath, "r");
    try {
      const buf = Buffer.alloc(SESSION_TAIL_BYTES);
      await fh.read(buf, 0, SESSION_TAIL_BYTES, st.size - SESSION_TAIL_BYTES);
      raw = buf.toString("utf8");
      const nl = raw.indexOf(`
`);
      if (nl !== -1)
        raw = raw.slice(nl + 1);
    } finally {
      await fh.close();
    }
  } else {
    raw = await fs5.readFile(filePath, "utf8");
  }
  const messages = [];
  let cwd = "";
  let gitBranch = "";
  let latestUsage;
  for (const line of raw.split(`
`)) {
    if (!line.trim())
      continue;
    try {
      const o = JSON.parse(line);
      if (!cwd && o.cwd)
        cwd = o.cwd;
      if (!gitBranch && o.gitBranch)
        gitBranch = o.gitBranch;
      if (o.type === "summary" && typeof o.summary === "string") {
        messages.push({
          role: "system",
          blocks: [{ kind: "system_event", eventType: "summary", text: o.summary }],
          timestamp: o.timestamp,
          uuid: o.uuid
        });
        continue;
      }
      if (o.type === "user" || o.type === "assistant") {
        if (o.isMeta) {
          if (o.type === "user") {
            const c2 = o.message?.content;
            const t = typeof c2 === "string" ? c2 : Array.isArray(c2) ? c2.map((b) => b.type === "text" ? b.text || "" : "").join("").trim() : "";
            if (/^Continue from where you left off/i.test(t)) {
              messages.push({
                role: "system",
                blocks: [{ kind: "system_event", eventType: "resume", text: t }],
                timestamp: o.timestamp,
                uuid: o.uuid
              });
            }
          }
          continue;
        }
        const blocks = [];
        const c = o.message?.content;
        if (typeof c === "string") {
          blocks.push({ kind: "text", text: c });
        } else if (Array.isArray(c)) {
          for (const b of c) {
            if (b.type === "text" && b.text)
              blocks.push({ kind: "text", text: b.text });
            else if (b.type === "thinking" && b.thinking)
              blocks.push({ kind: "thinking", text: b.thinking });
            else if (b.type === "tool_use")
              blocks.push({ kind: "tool_use", id: b.id, name: b.name, input: b.input });
            else if (b.type === "image" && b.source?.type === "base64" && b.source?.data) {
              blocks.push({
                kind: "image",
                mimeType: String(b.source.media_type || "image/png"),
                data: String(b.source.data)
              });
            } else if (b.type === "tool_result") {
              const t = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((x) => x.text || "").join(`
`) : "";
              blocks.push({ kind: "tool_result", toolUseId: b.tool_use_id, text: t.slice(0, 4000) });
            }
          }
        }
        messages.push({
          role: o.type,
          blocks,
          model: o.message?.model,
          timestamp: o.timestamp,
          uuid: o.uuid
        });
        if (o.type === "assistant" && o.message?.usage) {
          const u = o.message.usage;
          latestUsage = {
            inputTokens: Number(u.input_tokens) || 0,
            cacheCreationInputTokens: Number(u.cache_creation_input_tokens) || 0,
            cacheReadInputTokens: Number(u.cache_read_input_tokens) || 0,
            outputTokens: Number(u.output_tokens) || 0,
            model: o.message?.model
          };
        }
      }
    } catch {}
  }
  const [claudeMdCount, mcpCount] = await Promise.all([
    countClaudeMd(cwd),
    countMcpServers()
  ]);
  return {
    kind: "claude",
    sessionId: sid,
    project,
    cwd,
    gitBranch,
    messages,
    truncated,
    totalBytes: st.size,
    latestUsage,
    claudeMdCount,
    mcpCount
  };
}
async function countClaudeMd(cwd) {
  const candidates = [
    cwd ? path7.join(cwd, "CLAUDE.md") : "",
    cwd ? path7.join(cwd, ".claude", "CLAUDE.md") : "",
    path7.join(HOME, ".claude", "CLAUDE.md")
  ].filter(Boolean);
  let n = 0;
  await Promise.all(candidates.map(async (p) => {
    try {
      await fs5.access(p);
      n++;
    } catch {}
  }));
  return n;
}
async function countMcpServers() {
  const paths = [
    path7.join(HOME, ".claude", "settings.json"),
    path7.join(HOME, ".claude.json")
  ];
  for (const p of paths) {
    try {
      const raw = await fs5.readFile(p, "utf8");
      const j = JSON.parse(raw);
      if (j.mcpServers && typeof j.mcpServers === "object") {
        return Object.keys(j.mcpServers).length;
      }
    } catch {}
  }
  return 0;
}

// src/lib/sse.ts
function startSSE(reply) {
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  reply.raw.socket?.setNoDelay(true);
}
function sseSend(reply, payload) {
  reply.raw.write(`data: ${JSON.stringify(payload)}

`);
}
function sseDone(reply) {
  try {
    reply.raw.write(`data: [DONE]

`);
    reply.raw.end();
  } catch {}
}

// src/lib/live-registry.ts
var LIVE_RING = 4000;
var KEEP_AROUND_MS = 60000;
var sessions = new Map;
function liveStart(sid, meta) {
  clearTimeout(sessions.get(sid)?.gc);
  sessions.set(sid, {
    events: [{ type: "meta", cwd: meta.cwd, sessionId: sid }],
    subs: new Set,
    ended: false
  });
}
function livePush(sid, payload) {
  const ls = sessions.get(sid);
  if (!ls || ls.ended)
    return;
  ls.events.push(payload);
  if (ls.events.length > LIVE_RING)
    ls.events.splice(0, ls.events.length - LIVE_RING);
  for (const sub of ls.subs) {
    try {
      sseSend(sub, payload);
    } catch {
      ls.subs.delete(sub);
    }
  }
}
function liveEnd(sid, payload) {
  const ls = sessions.get(sid);
  if (!ls)
    return;
  ls.ended = true;
  ls.events.push(payload);
  for (const sub of ls.subs) {
    try {
      sseSend(sub, payload);
      sub.raw.write(`data: [DONE]

`);
      sub.raw.end();
    } catch {}
  }
  ls.subs.clear();
  ls.gc = setTimeout(() => {
    if (sessions.get(sid) === ls)
      sessions.delete(sid);
  }, KEEP_AROUND_MS);
}
function liveGet(sid) {
  return sessions.get(sid);
}

// src/lib/claude-runner.ts
import { randomUUID as randomUUID4 } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";

// src/lib/macaron-mcp.ts
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// src/lib/macaron-render-tool.ts
function handleRenderUI(code) {
  const result = checkGenUI(code);
  const text = result.ok ? "Rendered inline. The user sees the UI now." : `Rendered inline, but the TSX has issues:
${result.diagnostics}`;
  return { text, ok: result.ok };
}
var RENDER_UI_TOOL_DESCRIPTION = `Render an interactive TSX UI inline in the assistant message. \`code\` is a COMPLETE TSX module the host immediately mounts via React. The host runs the code in a sandbox with these capabilities preloaded:

# Imports — exact rules
- Import all UI primitives from \`$macaron/ui\` in ONE combined import: \`import { Stack, Row, Card, Button, Badge, Text, Tabs, TabsList, TabsTrigger, TabsContent, NumberFlow, motion, AnimatePresence /* etc */ } from '$macaron/ui';\`
- For charts: \`import { ChartContainer, ChartTooltip, ChartTooltipContent, AreaChart, Area, BarChart, Bar, LineChart, Line, CartesianGrid, XAxis, YAxis, PieChart, Pie } from '$macaron/ui/charts';\` (never import 'recharts' directly)
- Icons: \`import { Plus, Minus, ChevronDown, CheckCircle2, /* … */ } from 'lucide-react';\`
- React: \`import { useState, useEffect, useRef } from 'react';\`
- No relative imports, no other bare packages, no markdown fences, no JSON wrapping.

# Available $macaron/ui components (use these instead of raw div/span when possible)
Layout: Stack, Row, Grid, Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter, Surface, FeatureCard, Field, Separator
Text: Text, TextShimmer, TextMorph, TextLoop, SpinningText
Controls: Button, Badge, Checkbox, Switch, Slider, Input, Textarea, Select+SelectTrigger+SelectValue+SelectContent+SelectItem, RadioGroup+RadioGroupItem, Label, Calendar, InputOTP
Surfaces: Tabs+TabsList+TabsTrigger+TabsContent, Accordion, Popover, MorphingDialog, Disclosure
Lists/data: Table, Carousel, Sortable, Timeline
Stats: Stat, StatGrid, PillRow, NumberFlow
Media/decor: Avatar+AvatarImage+AvatarFallback, Tilt, GlowEffect, ProgressiveBlur, motion, AnimatePresence

# Quality rules
- One default export (\`export default function App()\`), no extra files, no fetch/network
- Use UnoCSS Tailwind v3 utility classes via className
- Every mapped list needs stable \`key\` from data (id/slug); never \`key={i}\`
- Keep helper components at module scope, not inside App
- No \`as any\` casts in JSX

# Sending messages back to chat (interactive widgets)
- Import from \`$macaron/chat\`: \`import { sendUserMessage } from '$macaron/chat';\`
- \`sendUserMessage(prompt)\` takes a single string and posts it to the chat as if the user typed it, driving the next assistant turn. Use it when a widget action should continue the conversation: form submits, choice confirmations, apply/regenerate buttons, wizard steps.
- \`prompt\` is the message the next turn receives — write it as the user would (e.g. "Book the 3pm slot"); fold any structured context the next turn needs directly into that string.
- Call it ONLY from event handlers or effects, never during render, and at most once per user gesture. For a purely display-only UI, don't call it.

# When to use this tool
Call render_ui when a visual answer beats prose: dashboards, charts, comparison cards, forms, settings panels, interactive widgets, mini editors, status reports. Don't use it for plain text answers. Don't write a markdown TSX fence in chat — that's a failed answer. After render_ui returns, the host already shows the rendered UI to the user; keep your follow-up reply short (one sentence ack at most).`;

// src/lib/macaron-mcp.ts
var INSTRUCTIONS = "Macaron GenUI bridge. The render_ui tool inlines a TSX component into the conversation. " + "YOU author the code field with a complete TSX module using $macaron/ui. The user already sees " + "the rendered UI when render_ui returns — do NOT paste, quote, or summarize the code in your reply.";
var macaronMcpServer = createSdkMcpServer({
  name: "macaron",
  version: "0.2.0",
  instructions: INSTRUCTIONS,
  alwaysLoad: true,
  tools: [
    tool("render_ui", RENDER_UI_TOOL_DESCRIPTION, {
      code: z.string().min(20).describe("A complete TSX module — imports + `export default function App()` — that the host mounts inline.")
    }, async ({ code }) => {
      const { text } = handleRenderUI(code);
      return { content: [{ type: "text", text }] };
    }, { alwaysLoad: true })
  ]
});

// src/lib/permission-registry.ts
var pending = new Map;
function registerPending(id, resolve) {
  pending.set(id, resolve);
}
function resolvePending(id, decision) {
  const r = pending.get(id);
  if (!r)
    return false;
  r(decision);
  pending.delete(id);
  return true;
}

// src/lib/claude-runner.ts
function buildPromptInput(opts) {
  if (!opts.images || opts.images.length === 0)
    return opts.prompt;
  const allowed = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
  const imageBlocks = opts.images.map((img) => {
    const m = /^data:([^;]+);base64,(.*)$/.exec(img.dataUrl);
    const detected = m?.[1] || img.mimeType || "image/png";
    const mediaType = allowed.has(detected) ? detected : "image/png";
    const data = m?.[2] || "";
    return {
      type: "image",
      source: { type: "base64", media_type: mediaType, data }
    };
  });
  const content = [
    ...imageBlocks,
    ...opts.prompt ? [{ type: "text", text: opts.prompt }] : []
  ];
  const msg = {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null
  };
  return async function* () {
    yield msg;
  }();
}
async function* runClaude(opts) {
  const queue = [];
  const waiters = [];
  let ended = false;
  const push = (ev) => {
    const w = waiters.shift();
    if (w)
      w({ value: ev, done: false });
    else
      queue.push(ev);
  };
  const finish = () => {
    ended = true;
    while (waiters.length)
      waiters.shift()({ value: undefined, done: true });
  };
  const next = () => {
    if (queue.length)
      return Promise.resolve({ value: queue.shift(), done: false });
    if (ended)
      return Promise.resolve({ value: undefined, done: true });
    return new Promise((res) => waiters.push(res));
  };
  const toolBlocks = new Map;
  const e = opts.envOverrides;
  const routedBase = e?.ANTHROPIC_BASE_URL || "(inherited from process.env)";
  const cfgDir = e?.CLAUDE_CONFIG_DIR || "(user default ~/.claude)";
  console.log(`[claude-runner] starting  model=${opts.model ?? "(sdk default)"}  base=${routedBase}  CLAUDE_CONFIG_DIR=${cfgDir}  resume=${opts.resume ? opts.resume.slice(0, 8) : "(new)"}`);
  (async () => {
    let sessionEmitted = false;
    let currentSid = opts.resume ?? "";
    try {
      const effectivePermissionMode = getYoloMode() ? "bypassPermissions" : opts.permissionMode ?? "default";
      const stream = query({
        prompt: buildPromptInput(opts),
        options: {
          cwd: opts.cwd,
          resume: opts.resume,
          model: opts.model,
          permissionMode: effectivePermissionMode,
          allowDangerouslySkipPermissions: effectivePermissionMode === "bypassPermissions",
          includePartialMessages: true,
          abortController: opts.abortController,
          mcpServers: { macaron: macaronMcpServer },
          allowedTools: ["mcp__macaron__render_ui"],
          canUseTool: async (toolName, input) => {
            const { keys, label } = computeRuleKeys(toolName, input);
            if (isAllowed(currentSid, opts.cwd, keys)) {
              return { behavior: "allow", updatedInput: input };
            }
            const id = randomUUID4();
            const decision = await new Promise((resolve) => {
              registerPending(id, resolve);
              push({ kind: "permission_request", id, toolName, input, ...label ? { suggestion: { label } } : {} });
            });
            if (decision.decision === "allow") {
              if (decision.scope === "session")
                rememberSession(currentSid, keys);
              else if (decision.scope === "always") {
                try {
                  await rememberProject(opts.cwd, keys);
                } catch (e2) {
                  console.error("[permission-rules] persist failed:", e2);
                }
              }
              push({ kind: "permission_resolved", id, decision: "allow" });
              return { behavior: "allow", updatedInput: input };
            }
            push({ kind: "permission_resolved", id, decision: "deny" });
            return { behavior: "deny", message: decision.reason || "denied by user", interrupt: false };
          },
          ...opts.envOverrides ? { env: opts.envOverrides } : {}
        }
      });
      for await (const m of stream) {
        if (!sessionEmitted && "session_id" in m && m.session_id) {
          sessionEmitted = true;
          currentSid = m.session_id;
          push({ kind: "session", sessionId: m.session_id });
        }
        if (m.type === "stream_event") {
          const ev = m.event;
          if (ev.type === "message_delta") {
            const usage = ev.usage;
            if (usage && typeof usage.output_tokens === "number") {
              push({ kind: "usage", outputTokens: usage.output_tokens });
            }
          }
          if (ev.type === "content_block_start") {
            const cb = ev.content_block;
            if (cb?.type === "tool_use" && cb.id && cb.name) {
              toolBlocks.set(ev.index, { id: cb.id, name: cb.name, json: "" });
              push({ kind: "tool_use", id: cb.id, name: cb.name, input: cb.input ?? {} });
            }
          } else if (ev.type === "content_block_delta") {
            const d = ev.delta;
            if (d?.type === "text_delta" && d.text) {
              push({ kind: "delta", text: d.text });
            } else if (d?.type === "input_json_delta" && typeof d.partial_json === "string") {
              const tb = toolBlocks.get(ev.index);
              if (tb) {
                tb.json += d.partial_json;
                push({
                  kind: "tool_input_delta",
                  id: tb.id,
                  name: tb.name,
                  partial_json: d.partial_json,
                  accumulated: tb.json
                });
              }
            }
          } else if (ev.type === "content_block_stop") {
            const tb = toolBlocks.get(ev.index);
            if (tb) {
              push({ kind: "tool_input_done", id: tb.id, name: tb.name, final_json: tb.json });
              toolBlocks.delete(ev.index);
            }
          }
        } else if (m.type === "user") {
          const blocks = m.message?.content || [];
          for (const b of blocks) {
            if (b.type === "tool_result" && b.tool_use_id) {
              const c = b.content;
              const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => x.text || "").join("") : "";
              push({ kind: "tool_result", tool_use_id: b.tool_use_id, text, isError: Boolean(b.is_error) });
            }
          }
        } else if (m.type === "system") {
          if (m.subtype === "thinking_tokens") {
            const est = m.estimated_tokens;
            if (typeof est === "number") {
              push({ kind: "usage", outputTokens: 0, thinkingTokens: est });
            }
          }
          push({ kind: "message", subtype: m.subtype || "system" });
        } else if (m.type === "result") {
          if (m.is_error) {
            const r = m;
            const detail = (r.errors && r.errors.length ? r.errors.join(" | ") : "") || r.result || [r.subtype, r.stop_reason, r.api_error_status ? `http ${r.api_error_status}` : ""].filter(Boolean).join(" · ") || "unknown SDK error";
            console.log("[claude-runner] SDK error result:", JSON.stringify(r, null, 2));
            push({ kind: "error", error: detail });
          }
          push({ kind: "done", exitCode: m.is_error ? 1 : 0 });
          finish();
          return;
        }
      }
      push({ kind: "done", exitCode: 0 });
    } catch (err) {
      push({ kind: "error", error: err.message });
      push({ kind: "done", exitCode: -1 });
    } finally {
      finish();
    }
  })();
  while (true) {
    const r = await next();
    if (r.done)
      return;
    yield r.value;
  }
}
var FOLLOWUP_PROMPT = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
You already have the full conversation above as context — tool calls will be rejected and waste your only turn.

Your task: envisage 2-5 possible follow-up questions the USER could ask next to continue this conversation productively.

Rules:
- User's perspective: questions the user would ask the assistant, not the reverse.
- Each fundamentally different in intent (dive deeper / pivot / verify / request an example / challenge an assumption).
- 2-8 words each, concise, no duplication, no platitudes like "thanks".
- Use THE SAME LANGUAGE and tone as the user's most recent message.

Output ONLY a JSON array of strings, nothing else. Example:
["how does caching work","show a smaller example","what if I skip persistSession"]`;
async function* runFollowup(opts) {
  const stream = query({
    prompt: FOLLOWUP_PROMPT,
    options: {
      cwd: opts.cwd,
      resume: opts.resume,
      model: opts.model,
      mcpServers: { macaron: macaronMcpServer },
      canUseTool: async () => ({ behavior: "deny", message: "text-only query", interrupt: true }),
      maxTurns: 1,
      persistSession: false,
      includePartialMessages: true,
      ...opts.envOverrides ? { env: opts.envOverrides } : {}
    }
  });
  let got = false;
  for await (const m of stream) {
    if (m.type === "stream_event") {
      const ev = m.event;
      if (ev.type === "content_block_delta") {
        const d = ev.delta;
        if (d?.type === "text_delta" && d.text) {
          got = true;
          yield d.text;
        }
      }
    }
  }
  console.log(`[claude-runner] followup  resume=${opts.resume.slice(0, 8)}  text=${got ? "ok" : "empty"}`);
}

// src/lib/active-runs.ts
var runs = new Map;
function registerRun(sid, ac) {
  runs.set(sid, ac);
}
function abortRun(sid) {
  const ac = runs.get(sid);
  if (!ac)
    return false;
  ac.abort();
  runs.delete(sid);
  return true;
}
function endRun(sid) {
  runs.delete(sid);
}

// src/routes/workspaces.ts
async function registerWorkspaceRoutes(app) {
  app.get("/api/workspaces", async () => {
    const sessions2 = await listAllSessions();
    return { workspaces: groupWorkspaces(sessions2) };
  });
  app.get("/api/workspaces/:project", async ({ params }) => {
    const sessions2 = await listAllSessions();
    const mine = sessions2.filter((s) => s.project === params.project);
    const meta = groupWorkspaces(mine)[0] || {
      project: params.project,
      cwd: "",
      name: params.project,
      sessionCount: 0,
      lastActivity: 0,
      lastSessionId: "",
      lastPreview: ""
    };
    return { workspace: meta, sessions: mine };
  });
  app.post("/api/workspaces/:project/sessions", async (req, reply) => {
    const project = req.params.project;
    const text = String(req.body?.text || "").trim();
    const images = Array.isArray(req.body?.images) ? req.body.images : [];
    const permissionMode = req.body?.permissionMode || "default";
    if (!text && images.length === 0) {
      return reply.status(400).send({ error: "text or images required" });
    }
    const { model, env: providerEnv } = getActiveProviderEnv();
    let cwd = decodeClaudeProjectName(project);
    try {
      const projDir = path8.join(CLAUDE_PROJECTS, project);
      const files = await fs6.readdir(projDir);
      for (const f of files) {
        if (!f.endsWith(".jsonl"))
          continue;
        const meta = await readSessionSummary(path8.join(projDir, f));
        if (meta?.cwd) {
          cwd = meta.cwd;
          break;
        }
      }
    } catch {}
    try {
      const st = await fs6.stat(cwd);
      if (!st.isDirectory())
        throw new Error("cwd not a directory");
    } catch (e) {
      return reply.status(400).send({ error: `cwd unusable: ${cwd} (${e.message})` });
    }
    startSSE(reply);
    sseSend(reply, { type: "starting", cwd });
    const abortController = new AbortController;
    const stream = runClaude({ prompt: text, cwd, model, permissionMode, images, envOverrides: providerEnv, abortController });
    let clientGone = false;
    reply.raw.on("close", () => {
      clientGone = true;
    });
    const safeSend = (payload) => {
      if (clientGone)
        return;
      try {
        sseSend(reply, payload);
      } catch {
        clientGone = true;
      }
    };
    let capturedSid = "";
    (async () => {
      for await (const ev of stream) {
        if (ev.kind === "session" && !capturedSid) {
          capturedSid = ev.sessionId;
          liveStart(capturedSid, { cwd });
          registerRun(capturedSid, abortController);
          livePush(capturedSid, { type: "user-text", text });
          safeSend({ type: "meta", cwd, sessionId: capturedSid });
        } else if (ev.kind === "delta") {
          safeSend({ type: "delta", text: ev.text });
          if (capturedSid)
            livePush(capturedSid, { type: "delta", text: ev.text });
        } else if (ev.kind === "tool_use") {
          const payload = { type: "tool_use", id: ev.id, name: ev.name, input: ev.input };
          safeSend(payload);
          if (capturedSid)
            livePush(capturedSid, payload);
        } else if (ev.kind === "tool_input_delta") {
          const payload = { type: "tool_input_delta", id: ev.id, name: ev.name, partial_json: ev.partial_json, accumulated: ev.accumulated };
          safeSend(payload);
          if (capturedSid)
            livePush(capturedSid, payload);
        } else if (ev.kind === "tool_input_done") {
          const payload = { type: "tool_input_done", id: ev.id, name: ev.name, final_json: ev.final_json };
          safeSend(payload);
          if (capturedSid)
            livePush(capturedSid, payload);
        } else if (ev.kind === "tool_result") {
          const payload = { type: "tool_result", tool_use_id: ev.tool_use_id, text: ev.text, isError: ev.isError };
          safeSend(payload);
          if (capturedSid)
            livePush(capturedSid, payload);
        } else if (ev.kind === "permission_request") {
          const payload = { type: "permission_request", id: ev.id, toolName: ev.toolName, input: ev.input, suggestion: ev.suggestion };
          safeSend(payload);
          if (capturedSid)
            livePush(capturedSid, payload);
        } else if (ev.kind === "permission_resolved") {
          const payload = { type: "permission_resolved", id: ev.id, decision: ev.decision };
          safeSend(payload);
          if (capturedSid)
            livePush(capturedSid, payload);
        } else if (ev.kind === "usage") {
          const payload = { type: "usage", outputTokens: ev.outputTokens, thinkingTokens: ev.thinkingTokens };
          safeSend(payload);
          if (capturedSid)
            livePush(capturedSid, payload);
        } else if (ev.kind === "message") {
          safeSend({ type: "event", event: "system", subtype: ev.subtype });
          if (capturedSid)
            livePush(capturedSid, { type: "event", event: "system", subtype: ev.subtype });
        } else if (ev.kind === "error") {
          safeSend({ type: "error", error: ev.error });
          if (capturedSid)
            livePush(capturedSid, { type: "error", error: ev.error });
        } else if (ev.kind === "done") {
          safeSend({ type: "done", exitCode: ev.exitCode });
          if (capturedSid) {
            liveEnd(capturedSid, { type: "done", exitCode: ev.exitCode });
            endRun(capturedSid);
          }
          if (!clientGone && capturedSid && ev.exitCode === 0 && getFollowupSuggestionsEnabled()) {
            try {
              for await (const delta of runFollowup({ resume: capturedSid, cwd, model, envOverrides: providerEnv })) {
                if (clientGone)
                  break;
                safeSend({ type: "followup_delta", text: delta });
              }
            } catch {}
          }
          if (!clientGone)
            sseDone(reply);
        }
      }
    })().catch((e) => {
      const msg = e.message;
      safeSend({ type: "error", error: msg });
      if (capturedSid) {
        liveEnd(capturedSid, { type: "done", exitCode: -1, error: msg });
        endRun(capturedSid);
      }
      if (!clientGone)
        sseDone(reply);
    });
  });
}

// src/routes/sessions.ts
async function registerSessionRoutes(app) {
  app.get("/api/sessions/claude/:project/:sid", async ({ params }, reply) => {
    try {
      return await readSessionMessages(params.project, params.sid);
    } catch (e) {
      return reply.status(404).send({ error: e.message });
    }
  });
  app.delete("/api/sessions/claude/:project/:sid", async ({ params }, reply) => {
    try {
      await deleteSession(params.project, params.sid);
      return { ok: true };
    } catch (e) {
      return reply.status(404).send({ error: e.message });
    }
  });
  app.post("/api/sessions/claude/:project/:sid/duplicate", async ({ params }, reply) => {
    try {
      const r = await duplicateSession(params.project, params.sid);
      return { ok: true, ...r };
    } catch (e) {
      return reply.status(404).send({ error: e.message });
    }
  });
  app.post("/api/permission-decision", async (req, reply) => {
    const id = String(req.body?.id || "").trim();
    const dec = req.body?.decision;
    if (!id || dec !== "allow" && dec !== "deny") {
      return reply.status(400).send({ error: "id + decision required" });
    }
    const scope = req.body?.scope === "session" || req.body?.scope === "always" ? req.body.scope : "once";
    const ok = resolvePending(id, dec === "allow" ? { decision: "allow", scope } : { decision: "deny", reason: req.body?.reason });
    return reply.send({ ok });
  });
  app.post("/api/sessions/claude/:project/:sid/stop", async ({ params }, reply) => {
    const ok = abortRun(params.sid);
    return reply.send({ ok, running: ok });
  });
  app.post("/api/sessions/claude/:project/:sid/rewind", async (req, reply) => {
    const uuid = String(req.body?.uuid || "").trim();
    if (!uuid)
      return reply.status(400).send({ error: "uuid required" });
    try {
      const r = await rewindSession(req.params.project, req.params.sid, uuid);
      return { ok: true, ...r };
    } catch (e) {
      return reply.status(400).send({ error: e.message });
    }
  });
  app.post("/api/sessions/claude/:project/:sid/compact", async (req, reply) => {
    const provider = getActiveProviderRaw();
    if (!provider) {
      return reply.status(400).send({
        error: "compact requires an active custom provider (system provider is unsupported)"
      });
    }
    let detail;
    try {
      detail = await readSessionMessages(req.params.project, req.params.sid);
    } catch (e) {
      return reply.status(404).send({ error: e.message });
    }
    const msgs = [];
    for (const m of detail.messages) {
      if (m.role !== "user" && m.role !== "assistant")
        continue;
      const text = m.blocks.map((b) => b.kind === "text" ? b.text : b.kind === "thinking" ? "" : "").filter(Boolean).join(`
`).trim();
      if (!text)
        continue;
      const prev = msgs[msgs.length - 1];
      if (prev && prev.role === m.role)
        prev.content += `

` + text;
      else
        msgs.push({ role: m.role, content: text });
    }
    if (msgs.length === 0) {
      return reply.status(400).send({ error: "nothing to compact — session has no text messages" });
    }
    const CAP = 40000;
    for (const m of msgs) {
      if (m.content.length > CAP) {
        m.content = m.content.slice(0, CAP) + `

[…truncated for summarization]`;
      }
    }
    msgs.push({
      role: "user",
      content: "Please write a concise recap of the entire conversation above. " + "Focus on: goals, key decisions, remaining tasks, and the current in-progress work. " + "One paragraph, no more than 250 words."
    });
    const endpoint = provider.endpoint.replace(/\/+$/, "");
    const url = endpoint.endsWith("/v1") ? `${endpoint}/messages` : `${endpoint}/v1/messages`;
    let apiRes;
    try {
      apiRes = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": provider.apiKey,
          authorization: `Bearer ${provider.apiKey}`,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: provider.model,
          max_tokens: 1024,
          system: "You are a conversation summarizer. Output ONLY the recap paragraph — no preamble, no headers, no bullet lists.",
          messages: msgs
        })
      });
    } catch (e) {
      return reply.status(502).send({ error: `provider fetch failed: ${e.message}` });
    }
    if (!apiRes.ok) {
      const body = await apiRes.text().catch(() => "");
      return reply.status(502).send({
        error: `provider returned ${apiRes.status}: ${body.slice(0, 500)}`
      });
    }
    const json = await apiRes.json().catch(() => null);
    const summary = json?.content?.filter((b) => b?.type === "text").map((b) => b?.text || "").join(`
`).trim() || "";
    if (!summary) {
      return reply.status(502).send({ error: "provider returned no summary text" });
    }
    try {
      const r = await writeCompactedSession(req.params.project, req.params.sid, summary);
      return { ok: true, summary, ...r };
    } catch (e) {
      return reply.status(500).send({ error: e.message });
    }
  });
  app.get("/api/sessions/claude/:project/:sid/live", async (req, reply) => {
    startSSE(reply);
    const ls = liveGet(req.params.sid);
    if (!ls) {
      sseSend(reply, { type: "live-end", reason: "not-live" });
      sseDone(reply);
      return;
    }
    for (const ev of ls.events) {
      try {
        sseSend(reply, ev);
      } catch {
        return;
      }
    }
    if (ls.ended) {
      sseDone(reply);
      return;
    }
    ls.subs.add(reply);
    reply.raw.on("close", () => ls.subs.delete(reply));
  });
  app.post("/api/sessions/claude/:project/:sid/followups", async ({ params }, reply) => {
    const { project, sid } = params;
    startSSE(reply);
    if (!getFollowupSuggestionsEnabled()) {
      sseDone(reply);
      return;
    }
    const cwd = await resolveSessionCwd(project, sid);
    const { model: providerModel, env: providerEnv } = getActiveProviderEnv();
    let clientGone = false;
    reply.raw.on("close", () => {
      clientGone = true;
    });
    try {
      for await (const delta of runFollowup({ resume: sid, cwd, model: providerModel, envOverrides: providerEnv })) {
        if (clientGone)
          break;
        try {
          sseSend(reply, { type: "followup_delta", text: delta });
        } catch {
          clientGone = true;
          break;
        }
      }
    } catch {}
    if (!clientGone)
      sseDone(reply);
  });
  app.post("/api/sessions/claude/:project/:sid/message", async (req, reply) => {
    const { project, sid } = req.params;
    const text = String(req.body?.text || "").trim();
    const images = Array.isArray(req.body?.images) ? req.body.images : [];
    const model = req.body?.model || "claude-opus-4-7";
    const permissionMode = req.body?.permissionMode || "default";
    if (!text && images.length === 0) {
      return reply.status(400).send({ error: "text or images required" });
    }
    const cwd = await resolveSessionCwd(project, sid);
    startSSE(reply);
    sseSend(reply, { type: "meta", cwd, sessionId: sid });
    let clientGone = false;
    reply.raw.on("close", () => {
      clientGone = true;
    });
    const safeSend = (payload) => {
      if (clientGone)
        return;
      try {
        sseSend(reply, payload);
      } catch {
        clientGone = true;
      }
    };
    const { model: providerModel, env: providerEnv } = getActiveProviderEnv();
    const abortController = new AbortController;
    registerRun(sid, abortController);
    (async () => {
      for await (const ev of runClaude({ prompt: text, cwd, resume: sid, model: providerModel, permissionMode, images, envOverrides: providerEnv, abortController })) {
        if (ev.kind === "delta")
          safeSend({ type: "delta", text: ev.text });
        else if (ev.kind === "tool_use") {
          safeSend({ type: "tool_use", id: ev.id, name: ev.name, input: ev.input });
        } else if (ev.kind === "tool_input_delta") {
          safeSend({ type: "tool_input_delta", id: ev.id, name: ev.name, partial_json: ev.partial_json, accumulated: ev.accumulated });
        } else if (ev.kind === "tool_input_done") {
          safeSend({ type: "tool_input_done", id: ev.id, name: ev.name, final_json: ev.final_json });
        } else if (ev.kind === "tool_result")
          safeSend({ type: "tool_result", tool_use_id: ev.tool_use_id, text: ev.text, isError: ev.isError });
        else if (ev.kind === "permission_request")
          safeSend({ type: "permission_request", id: ev.id, toolName: ev.toolName, input: ev.input, suggestion: ev.suggestion });
        else if (ev.kind === "permission_resolved")
          safeSend({ type: "permission_resolved", id: ev.id, decision: ev.decision });
        else if (ev.kind === "usage")
          safeSend({ type: "usage", outputTokens: ev.outputTokens, thinkingTokens: ev.thinkingTokens });
        else if (ev.kind === "message")
          safeSend({ type: "event", event: "system", subtype: ev.subtype });
        else if (ev.kind === "error")
          safeSend({ type: "error", error: ev.error });
        else if (ev.kind === "done") {
          safeSend({ type: "done", exitCode: ev.exitCode });
          endRun(sid);
          if (!clientGone && ev.exitCode === 0 && getFollowupSuggestionsEnabled()) {
            try {
              for await (const delta of runFollowup({ resume: sid, cwd, model: providerModel, envOverrides: providerEnv })) {
                if (clientGone)
                  break;
                safeSend({ type: "followup_delta", text: delta });
              }
            } catch {}
          }
          if (!clientGone)
            sseDone(reply);
        }
      }
    })().catch((e) => {
      endRun(sid);
      const msg = e.message;
      safeSend({ type: "error", error: msg });
      if (!clientGone)
        sseDone(reply);
    });
  });
}

// src/routes/settings.ts
async function registerSettingsRoutes(app) {
  app.get("/api/settings", async () => await readPublicSettings());
  app.post("/api/settings/providers", async (req, reply) => {
    const b = req.body || {};
    const name = String(b.name || "").trim();
    const endpoint = String(b.endpoint || "").trim();
    const model = String(b.model || "").trim();
    const apiKey = String(b.apiKey || "");
    if (!name)
      return reply.status(400).send({ error: "name required" });
    if (!endpoint)
      return reply.status(400).send({ error: "endpoint required" });
    if (!model)
      return reply.status(400).send({ error: "model required" });
    try {
      const created = await addProvider({ name, endpoint, model, apiKey });
      return { id: created.id, settings: await readPublicSettings() };
    } catch (e) {
      return reply.status(500).send({ error: e.message });
    }
  });
  app.put("/api/settings/providers/:id", async (req, reply) => {
    const b = req.body || {};
    const patch = {};
    if (typeof b.name === "string")
      patch.name = b.name;
    if (typeof b.endpoint === "string")
      patch.endpoint = b.endpoint;
    if (typeof b.model === "string")
      patch.model = b.model;
    if (typeof b.apiKey === "string")
      patch.apiKey = b.apiKey;
    try {
      const updated = await updateProvider(req.params.id, patch);
      if (!updated)
        return reply.status(404).send({ error: "provider not found" });
      return await readPublicSettings();
    } catch (e) {
      return reply.status(500).send({ error: e.message });
    }
  });
  app.delete("/api/settings/providers/:id", async (req, reply) => {
    try {
      const ok = await deleteProvider(req.params.id);
      if (!ok)
        return reply.status(404).send({ error: "provider not found" });
      return await readPublicSettings();
    } catch (e) {
      return reply.status(500).send({ error: e.message });
    }
  });
  app.put("/api/settings/active", async (req, reply) => {
    const id = String(req.body?.providerId || "");
    if (!id)
      return reply.status(400).send({ error: "providerId required" });
    try {
      const ok = await setActiveProvider(id);
      if (!ok)
        return reply.status(404).send({ error: "provider not found" });
      return await readPublicSettings();
    } catch (e) {
      return reply.status(500).send({ error: e.message });
    }
  });
  app.put("/api/settings/yolo", async (req, reply) => {
    if (typeof req.body?.enabled !== "boolean") {
      return reply.status(400).send({ error: "enabled (boolean) required" });
    }
    try {
      await setYoloMode(req.body.enabled);
      return await readPublicSettings();
    } catch (e) {
      return reply.status(500).send({ error: e.message });
    }
  });
  app.put("/api/settings/followups", async (req, reply) => {
    if (typeof req.body?.enabled !== "boolean") {
      return reply.status(400).send({ error: "enabled (boolean) required" });
    }
    try {
      await setFollowupSuggestionsEnabled(req.body.enabled);
      return await readPublicSettings();
    } catch (e) {
      return reply.status(500).send({ error: e.message });
    }
  });
}

// src/routes/relay.ts
async function findProvider(id) {
  const s = await readSettings();
  return s.customProviders.find((p) => p.id === id) || null;
}
function synthModelObject(id, ownerName) {
  return {
    id,
    type: "model",
    display_name: id,
    created_at: "2024-01-01T00:00:00Z",
    owned_by: ownerName
  };
}
async function registerRelayRoutes(app) {
  app.get("/relay/anthropic/:providerId/v1/models", async (req, reply) => {
    const p = await findProvider(req.params.providerId);
    if (!p)
      return reply.status(404).send({ error: "provider not found" });
    return reply.send({
      data: [synthModelObject(p.model, p.name)],
      has_more: false,
      first_id: p.model,
      last_id: p.model
    });
  });
  app.get("/relay/anthropic/:providerId/v1/models/:model", async (req, reply) => {
    const p = await findProvider(req.params.providerId);
    if (!p)
      return reply.status(404).send({ error: "provider not found" });
    return reply.send(synthModelObject(req.params.model || p.model, p.name));
  });
  app.post("/relay/anthropic/:providerId/v1/messages", async (req, reply) => {
    const p = await findProvider(req.params.providerId);
    if (!p)
      return reply.status(404).send({ error: "provider not found" });
    let body = {};
    if (req.body && typeof req.body === "object") {
      const src = req.body;
      const messagesIn = Array.isArray(src.messages) ? [...src.messages] : [];
      const messages = [];
      const systemBlocks = [];
      for (const m of messagesIn) {
        const mm = m;
        if (mm && mm.role === "system") {
          if (typeof mm.content === "string") {
            systemBlocks.push({ type: "text", text: mm.content });
          } else if (Array.isArray(mm.content)) {
            for (const c of mm.content)
              systemBlocks.push(c);
          }
        } else {
          messages.push(m);
        }
      }
      body = { ...src, model: p.model, messages };
      if (systemBlocks.length > 0) {
        const existing = src.system;
        if (typeof existing === "string") {
          body.system = [
            { type: "text", text: existing },
            ...systemBlocks
          ];
        } else if (Array.isArray(existing)) {
          body.system = [...existing, ...systemBlocks];
        } else {
          body.system = systemBlocks;
        }
      }
    }
    const upstreamUrl = `${p.endpoint.replace(/\/$/, "")}/messages`;
    const fwdHeaders = {
      "content-type": "application/json",
      authorization: `Bearer ${p.apiKey}`,
      "anthropic-version": req.headers["anthropic-version"] || "2023-06-01"
    };
    const abeta = req.headers["anthropic-beta"];
    if (abeta)
      fwdHeaders["anthropic-beta"] = abeta;
    let upstream;
    try {
      upstream = await fetch(upstreamUrl, {
        method: "POST",
        headers: fwdHeaders,
        body: JSON.stringify(body)
      });
    } catch (e) {
      return reply.status(502).send({
        type: "error",
        error: { type: "api_error", message: `upstream fetch failed: ${e.message}` }
      });
    }
    reply.hijack();
    const rawHeaders = {};
    upstream.headers.forEach((v, k) => {
      const lk = k.toLowerCase();
      if (lk === "content-length" || lk === "transfer-encoding" || lk === "connection")
        return;
      rawHeaders[k] = v;
    });
    reply.raw.writeHead(upstream.status, rawHeaders);
    if (!upstream.body) {
      reply.raw.end();
      return;
    }
    const reader = upstream.body.getReader();
    let clientGone = false;
    reply.raw.on("close", () => {
      clientGone = true;
      try {
        reader.cancel();
      } catch {}
    });
    for (;; ) {
      const { done, value } = await reader.read();
      if (done)
        break;
      if (clientGone)
        break;
      if (value)
        reply.raw.write(Buffer.from(value));
    }
    reply.raw.end();
  });
  const stub = async (req, reply) => {
    return reply.send({});
  };
  app.get("/relay/anthropic/:providerId/v1/*", stub);
  app.post("/relay/anthropic/:providerId/v1/*", stub);
}

// src/routes/codex.ts
import { promises as fs9 } from "node:fs";

// src/lib/codex-store.ts
import { promises as fs7 } from "node:fs";
import path9 from "node:path";
var CODEX_SESSIONS = path9.join(HOME, ".codex", "sessions");
var summaryCache2 = new Map;
function isRolloutFile(name) {
  return name.startsWith("rollout-") && name.endsWith(".jsonl");
}
async function readSummary(filePath, mtimeMs, size) {
  const cached = summaryCache2.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size)
    return cached;
  const fh = await fs7.open(filePath, "r").catch(() => null);
  if (!fh)
    return null;
  try {
    const cap = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(cap);
    await fh.read(buf, 0, cap, 0);
    const text = buf.toString("utf8");
    let meta = null;
    let firstUserText = "";
    let approxMessages = 0;
    const lines = text.split(`
`);
    const upto = size > cap ? lines.length - 1 : lines.length;
    for (let i = 0;i < upto; i++) {
      const line = lines[i].trim();
      if (!line)
        continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const p = o.payload || {};
      if (o.type === "session_meta" && !meta) {
        meta = {
          id: String(p.id || ""),
          cwd: String(p.cwd || ""),
          gitBranch: typeof p.git?.branch === "string" ? p.git.branch : undefined,
          timestamp: typeof p.timestamp === "string" ? p.timestamp : undefined,
          model: typeof p.model === "string" ? p.model : undefined,
          cliVersion: typeof p.cli_version === "string" ? p.cli_version : undefined
        };
      }
      if (o.type === "event_msg") {
        const t = p.type || "";
        if (t === "user_message" && !firstUserText) {
          const msg = String(p.message || "").trim();
          if (msg && !msg.startsWith("<"))
            firstUserText = msg;
        }
        if (t === "user_message" || t === "agent_message")
          approxMessages++;
      }
    }
    if (!meta)
      return null;
    const entry = { mtimeMs, size, meta, firstUserText, approxMessages };
    summaryCache2.set(filePath, entry);
    return entry;
  } finally {
    await fh.close();
  }
}
function threadIdFromFilename(name) {
  const m = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(name);
  return m?.[1] ?? "";
}
function encodeCodexProjectName(cwd) {
  if (!cwd)
    return "";
  return cwd.replace(/^\//, "-").replace(/\//g, "-");
}
async function listCodexSessions() {
  const out = [];
  const stack = [];
  try {
    await fs7.access(CODEX_SESSIONS);
  } catch {
    return out;
  }
  const years = await fs7.readdir(CODEX_SESSIONS, { withFileTypes: true }).catch(() => []);
  for (const y of years) {
    if (!y.isDirectory())
      continue;
    const yp = path9.join(CODEX_SESSIONS, y.name);
    const months = await fs7.readdir(yp, { withFileTypes: true }).catch(() => []);
    for (const mo of months) {
      if (!mo.isDirectory())
        continue;
      const mop = path9.join(yp, mo.name);
      const days = await fs7.readdir(mop, { withFileTypes: true }).catch(() => []);
      for (const d of days) {
        if (!d.isDirectory())
          continue;
        stack.push(path9.join(mop, d.name));
      }
    }
  }
  await Promise.all(stack.map(async (dir) => {
    const files = await fs7.readdir(dir).catch(() => []);
    for (const f of files) {
      if (!isRolloutFile(f))
        continue;
      const filePath = path9.join(dir, f);
      const st = await fs7.stat(filePath).catch(() => null);
      if (!st)
        continue;
      const summary = await readSummary(filePath, st.mtimeMs, st.size);
      if (!summary)
        continue;
      const sid = summary.meta.id || threadIdFromFilename(f);
      if (!sid)
        continue;
      const cwd = summary.meta.cwd;
      const project = encodeCodexProjectName(cwd);
      out.push({
        kind: "codex",
        project,
        cwd,
        gitBranch: summary.meta.gitBranch,
        sessionId: sid,
        preview: (summary.firstUserText || "").slice(0, 220),
        title: getCodexTitle(sid),
        messageCount: summary.approxMessages,
        messageCountSuffix: "",
        mtime: st.mtimeMs,
        size: st.size,
        resumeCommand: `codex resume ${sid}`
      });
    }
  }));
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}
async function findCodexRolloutFile(sid) {
  try {
    await fs7.access(CODEX_SESSIONS);
  } catch {
    return null;
  }
  const years = await fs7.readdir(CODEX_SESSIONS, { withFileTypes: true }).catch(() => []);
  for (const y of years) {
    if (!y.isDirectory())
      continue;
    const yp = path9.join(CODEX_SESSIONS, y.name);
    const months = await fs7.readdir(yp, { withFileTypes: true }).catch(() => []);
    for (const mo of months) {
      if (!mo.isDirectory())
        continue;
      const mop = path9.join(yp, mo.name);
      const days = await fs7.readdir(mop, { withFileTypes: true }).catch(() => []);
      for (const d of days) {
        if (!d.isDirectory())
          continue;
        const dp = path9.join(mop, d.name);
        const files = await fs7.readdir(dp).catch(() => []);
        const match = files.find((f) => isRolloutFile(f) && f.endsWith(`${sid}.jsonl`));
        if (match)
          return path9.join(dp, match);
      }
    }
  }
  return null;
}
async function readCodexSessionMessages(sid) {
  const filePath = await findCodexRolloutFile(sid);
  if (!filePath)
    throw new Error(`codex session not found: ${sid}`);
  const st = await fs7.stat(filePath);
  const raw = await fs7.readFile(filePath, "utf8");
  let cwd = "";
  let gitBranch = "";
  const messages = [];
  let currentAssistant = null;
  const ensureAssistant = () => {
    if (currentAssistant)
      return currentAssistant;
    const m = { role: "assistant", blocks: [] };
    messages.push(m);
    currentAssistant = m;
    return m;
  };
  for (const line of raw.split(`
`)) {
    const t = line.trim();
    if (!t)
      continue;
    let o;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    const p = o.payload || {};
    if (o.type === "session_meta") {
      if (!cwd && typeof p.cwd === "string")
        cwd = p.cwd;
      const git = p.git;
      if (!gitBranch && git?.branch)
        gitBranch = git.branch;
      continue;
    }
    if (o.type === "event_msg") {
      const kind = String(p.type || "");
      if (kind === "user_message") {
        currentAssistant = null;
        const text = String(p.message || "").trim();
        if (text && !text.startsWith("<")) {
          messages.push({
            role: "user",
            blocks: [{ kind: "text", text }],
            timestamp: o.timestamp
          });
        }
      } else if (kind === "agent_message") {
        const text = String(p.message || "").trim();
        if (!text)
          continue;
        const m = ensureAssistant();
        m.blocks.push({ kind: "text", text });
        m.timestamp ??= o.timestamp;
      } else if (kind === "agent_reasoning") {
        const text = String(p.text || "").trim();
        if (!text)
          continue;
        const m = ensureAssistant();
        m.blocks.push({ kind: "thinking", text });
      }
      continue;
    }
    if (o.type === "response_item") {
      const kind = String(p.type || "");
      if (kind === "function_call") {
        const rawName = String(p.name || "tool");
        const ns = String(p.namespace || "");
        const mcpMatch = ns.match(/^mcp__(.+)$/);
        const name = mcpMatch ? `mcp:${mcpMatch[1]}/${rawName}` : rawName;
        const callId = String(p.call_id || `codex-${messages.length}`);
        let input = p.arguments;
        if (typeof input === "string") {
          try {
            input = JSON.parse(input);
          } catch {}
        }
        const m = ensureAssistant();
        m.blocks.push({ kind: "tool_use", id: callId, name, input });
      } else if (kind === "function_call_output") {
        const callId = String(p.call_id || "");
        let text = "";
        const output = p.output;
        if (typeof output === "string")
          text = output;
        else if (output && typeof output === "object") {
          const o2 = output;
          text = o2.output || o2.content || o2.text || JSON.stringify(output);
        }
        const m = ensureAssistant();
        m.blocks.push({
          kind: "tool_result",
          toolUseId: callId,
          text: text.slice(0, 8000)
        });
      } else if (kind === "custom_tool_call") {
        const name = String(p.name || "custom");
        const callId = String(p.call_id || `codex-${messages.length}`);
        const m = ensureAssistant();
        m.blocks.push({ kind: "tool_use", id: callId, name, input: p.input ?? {} });
      } else if (kind === "custom_tool_call_output") {
        const callId = String(p.call_id || "");
        const text = typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? "").slice(0, 8000);
        const m = ensureAssistant();
        m.blocks.push({
          kind: "tool_result",
          toolUseId: callId,
          text: text.slice(0, 8000)
        });
      }
      continue;
    }
  }
  return {
    kind: "codex",
    sessionId: sid,
    project: encodeCodexProjectName(cwd),
    cwd,
    gitBranch,
    messages,
    truncated: false,
    totalBytes: st.size
  };
}
async function deleteCodexSession(sid) {
  const filePath = await findCodexRolloutFile(sid);
  if (!filePath)
    throw new Error(`codex session not found: ${sid}`);
  await fs7.unlink(filePath);
  summaryCache2.delete(filePath);
  await deleteCodexTitle(sid);
}

// src/lib/codex-runner.ts
import { execSync } from "node:child_process";
import { existsSync as existsSync3, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID as randomUUID5 } from "node:crypto";
import os3 from "node:os";
import path10 from "node:path";
var { command: MACARON_MCP_CMD, args: MACARON_MCP_ARGS } = (() => {
  const here = path10.dirname(fileURLToPath(import.meta.url));
  const jsPath = path10.join(here, "..", "macaron-mcp-stdio.js");
  if (existsSync3(jsPath)) {
    return { command: "node", args: [jsPath] };
  }
  const tsPath = path10.join(here, "..", "macaron-mcp-stdio.ts");
  let dir = here;
  for (let i = 0;i < 6; i++) {
    for (const rel of [
      ["node_modules", ".bin", "tsx"],
      ["node_modules", ".pnpm", "node_modules", ".bin", "tsx"]
    ]) {
      const candidate = path10.join(dir, ...rel);
      if (existsSync3(candidate))
        return { command: candidate, args: [tsPath] };
    }
    dir = path10.dirname(dir);
  }
  return { command: "tsx", args: [tsPath] };
})();
function detectCodexBinary() {
  if (process.env.MACARON_CODEX_PATH && existsSync3(process.env.MACARON_CODEX_PATH)) {
    return process.env.MACARON_CODEX_PATH;
  }
  for (const p of ["/opt/homebrew/bin/codex", "/usr/local/bin/codex", "/usr/bin/codex"]) {
    if (existsSync3(p))
      return p;
  }
  try {
    return execSync("which codex", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || undefined;
  } catch {
    return;
  }
}
var CODEX_BINARY = detectCodexBinary();
function buildOptions() {
  const s = getCodexConfig();
  const p = getActiveCodexProvider();
  const mcpConfig = {
    "mcp_servers.macaron.command": MACARON_MCP_CMD,
    "mcp_servers.macaron.args": MACARON_MCP_ARGS,
    "mcp_servers.macaron.default_tools_approval_mode": "approve",
    network_access: "enabled"
  };
  if (!p) {
    return {
      codex: {
        codexPathOverride: CODEX_BINARY,
        config: mcpConfig
      },
      thread: {
        sandboxMode: s.runtime.sandboxMode,
        approvalPolicy: s.runtime.approvalPolicy,
        skipGitRepoCheck: true
      }
    };
  }
  return {
    codex: {
      codexPathOverride: CODEX_BINARY,
      apiKey: p.apiKey || undefined,
      baseUrl: p.baseUrl || undefined,
      config: {
        ...mcpConfig,
        model_provider: p.modelProvider,
        model: p.model,
        review_model: p.model,
        model_reasoning_effort: p.reasoningEffort,
        model_context_window: p.contextWindow,
        model_auto_compact_token_limit: p.autoCompactTokenLimit,
        disable_response_storage: p.disableResponseStorage,
        [`model_providers.${p.modelProvider}.name`]: p.modelProvider,
        [`model_providers.${p.modelProvider}.base_url`]: p.baseUrl,
        [`model_providers.${p.modelProvider}.wire_api`]: p.wireApi,
        [`model_providers.${p.modelProvider}.experimental_bearer_token`]: p.apiKey
      }
    },
    thread: {
      model: p.model,
      sandboxMode: s.runtime.sandboxMode,
      approvalPolicy: s.runtime.approvalPolicy,
      modelReasoningEffort: p.reasoningEffort,
      webSearchEnabled: p.webSearchEnabled,
      skipGitRepoCheck: true
    }
  };
}
var IMAGE_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp"
};
function buildInput(opts) {
  if (!opts.images?.length)
    return { input: opts.prompt, tmpFiles: [] };
  const tmpFiles = [];
  const items = [];
  for (const img of opts.images) {
    const m = /^data:([^;]+);base64,(.*)$/.exec(img.dataUrl);
    const mime = m?.[1] || img.mimeType || "image/png";
    const data = m?.[2] || "";
    if (!data)
      continue;
    const file = path10.join(os3.tmpdir(), `macaron-codex-${randomUUID5()}.${IMAGE_EXT[mime] || "png"}`);
    writeFileSync(file, Buffer.from(data, "base64"));
    tmpFiles.push(file);
    items.push({ type: "local_image", path: file });
  }
  if (opts.prompt)
    items.push({ type: "text", text: opts.prompt });
  return { input: items, tmpFiles };
}
async function* runCodex(opts) {
  const queue = [];
  const waiters = [];
  let ended = false;
  const push = (ev) => {
    const w = waiters.shift();
    if (w)
      w({ value: ev, done: false });
    else
      queue.push(ev);
  };
  const finish = () => {
    ended = true;
    while (waiters.length)
      waiters.shift()({ value: undefined, done: true });
  };
  const next = () => {
    if (queue.length)
      return Promise.resolve({ value: queue.shift(), done: false });
    if (ended)
      return Promise.resolve({ value: undefined, done: true });
    return new Promise((res) => waiters.push(res));
  };
  const { codex: codexOpts, thread: threadOpts } = buildOptions();
  console.log(`[codex-runner] starting  model=${threadOpts.model}  base=${codexOpts.baseUrl || "(sdk default)"}  resume=${opts.resume ? opts.resume.slice(0, 8) : "(new)"}  cwd=${opts.cwd}`);
  const emittedToolUse = new Set;
  const handleItemEvent = (phase, item) => {
    switch (item.type) {
      case "agent_message": {
        if (phase !== "completed")
          return;
        const text = item.text?.trim();
        if (text)
          push({ kind: "delta", text });
        return;
      }
      case "reasoning": {
        if (phase !== "completed")
          return;
        const text = item.text?.trim();
        if (!text)
          return;
        push({ kind: "message", subtype: "codex_reasoning" });
        push({ kind: "delta", text });
        return;
      }
      case "command_execution": {
        const id = item.id;
        if (!emittedToolUse.has(id)) {
          emittedToolUse.add(id);
          push({
            kind: "tool_use",
            id,
            name: "Bash",
            input: { command: item.command }
          });
        }
        if (phase === "completed") {
          push({
            kind: "tool_result",
            tool_use_id: id,
            text: item.aggregated_output || `(exit ${item.exit_code ?? "?"})`,
            isError: item.status === "failed" || (item.exit_code ?? 0) !== 0
          });
        }
        return;
      }
      case "file_change": {
        const id = item.id;
        if (!emittedToolUse.has(id)) {
          emittedToolUse.add(id);
          push({
            kind: "tool_use",
            id,
            name: "Edit",
            input: { changes: item.changes }
          });
        }
        if (phase === "completed") {
          const summary = item.changes.map((c) => `${c.kind === "add" ? "＋" : c.kind === "delete" ? "－" : "△"} ${c.path}`).join(`
`);
          push({
            kind: "tool_result",
            tool_use_id: id,
            text: summary || "(no changes)",
            isError: item.status === "failed"
          });
        }
        return;
      }
      case "mcp_tool_call": {
        const id = item.id;
        if (!emittedToolUse.has(id)) {
          emittedToolUse.add(id);
          push({
            kind: "tool_use",
            id,
            name: `mcp:${item.server}/${item.tool}`,
            input: item.arguments ?? {}
          });
        }
        if (phase === "completed") {
          const text = item.error?.message ?? JSON.stringify(item.result?.content ?? item.result?.structured_content ?? "", null, 2);
          push({
            kind: "tool_result",
            tool_use_id: id,
            text: (text || "").slice(0, 8000),
            isError: item.status === "failed"
          });
        }
        return;
      }
      case "web_search": {
        const id = item.id;
        if (!emittedToolUse.has(id)) {
          emittedToolUse.add(id);
          push({
            kind: "tool_use",
            id,
            name: "WebSearch",
            input: { query: item.query }
          });
        }
        if (phase === "completed") {
          push({ kind: "tool_result", tool_use_id: id, text: "(search dispatched)", isError: false });
        }
        return;
      }
      case "todo_list": {
        if (phase !== "completed")
          return;
        const id = item.id;
        push({
          kind: "tool_use",
          id,
          name: "TodoWrite",
          input: {
            todos: item.items.map((t, i) => ({
              content: t.text,
              status: t.completed ? "completed" : "pending",
              activeForm: t.text,
              id: `codex-todo-${i}`
            }))
          }
        });
        push({ kind: "tool_result", tool_use_id: id, text: "todo list updated", isError: false });
        return;
      }
      case "error": {
        if (phase !== "completed")
          return;
        const msg = item.message || "unknown codex item error";
        if (/Skill descriptions were shortened/i.test(msg))
          return;
        push({ kind: "error", error: msg });
        return;
      }
      default:
        return;
    }
  };
  (async () => {
    let sessionEmitted = false;
    let tmpFiles = [];
    try {
      const { Codex } = await import("@openai/codex-sdk");
      const codex = new Codex(codexOpts);
      const thread = opts.resume ? codex.resumeThread(opts.resume, { ...threadOpts, workingDirectory: opts.cwd }) : codex.startThread({ ...threadOpts, workingDirectory: opts.cwd });
      if (opts.resume) {
        sessionEmitted = true;
        push({ kind: "session", sessionId: opts.resume });
      }
      const built = buildInput(opts);
      tmpFiles = built.tmpFiles;
      const streamed = await thread.runStreamed(built.input, {
        signal: opts.abortController?.signal
      });
      for await (const ev of streamed.events) {
        switch (ev.type) {
          case "thread.started":
            if (!sessionEmitted) {
              sessionEmitted = true;
              push({ kind: "session", sessionId: ev.thread_id });
            }
            break;
          case "turn.started":
            push({ kind: "message", subtype: "codex_turn_started" });
            break;
          case "item.started":
            handleItemEvent("started", ev.item);
            break;
          case "item.updated":
            handleItemEvent("updated", ev.item);
            break;
          case "item.completed":
            handleItemEvent("completed", ev.item);
            break;
          case "turn.completed":
            push({
              kind: "usage",
              outputTokens: ev.usage.output_tokens,
              thinkingTokens: ev.usage.reasoning_output_tokens
            });
            push({ kind: "done", exitCode: 0 });
            finish();
            return;
          case "turn.failed":
            push({ kind: "error", error: ev.error?.message || "codex turn failed" });
            push({ kind: "done", exitCode: 1 });
            finish();
            return;
          case "error":
            push({ kind: "error", error: ev.message || "codex stream error" });
            push({ kind: "done", exitCode: 1 });
            finish();
            return;
        }
      }
      push({ kind: "done", exitCode: 0 });
    } catch (err) {
      push({ kind: "error", error: err.message });
      push({ kind: "done", exitCode: -1 });
    } finally {
      for (const f of tmpFiles) {
        try {
          unlinkSync(f);
        } catch {}
      }
      finish();
    }
  })();
  while (true) {
    const r = await next();
    if (r.done)
      return;
    yield r.value;
  }
}

// src/lib/codex-title.ts
import { promises as fs8 } from "node:fs";
import os4 from "node:os";
var MAX_TITLE_CHARS = 80;
var MAX_SOURCE_CHARS = 6000;
var TITLE_TIMEOUT_MS = 60000;
var TITLE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { title: { type: "string", minLength: 1, maxLength: MAX_TITLE_CHARS } },
  required: ["title"]
};
var TITLE_INSTRUCTIONS = `You are generating a concise sidebar title for a Codex coding session.
Infer the user's real task from the opening user/assistant exchange below.
Use the same language as the user; for Chinese prefer 4-12 chars, for English 3-7 Title Case words.
Preserve important product, API, repo, file, and branch names.
No punctuation, quotes, emojis, markdown, or trailing period.
Return exactly JSON: {"title": string}.`;
function buildTitleOptions() {
  const p = getActiveCodexProvider();
  const thread = { sandboxMode: "read-only", approvalPolicy: "never", skipGitRepoCheck: true, modelReasoningEffort: "low" };
  if (!p)
    return { codex: { codexPathOverride: CODEX_BINARY }, thread };
  return {
    codex: {
      codexPathOverride: CODEX_BINARY,
      apiKey: p.apiKey || undefined,
      baseUrl: p.baseUrl || undefined,
      config: {
        model_provider: p.modelProvider,
        model: p.model,
        disable_response_storage: p.disableResponseStorage,
        [`model_providers.${p.modelProvider}.name`]: p.modelProvider,
        [`model_providers.${p.modelProvider}.base_url`]: p.baseUrl,
        [`model_providers.${p.modelProvider}.wire_api`]: p.wireApi,
        [`model_providers.${p.modelProvider}.experimental_bearer_token`]: p.apiKey
      }
    },
    thread: { ...thread, model: p.model }
  };
}
function firstText(messages, role) {
  const m = messages.find((msg) => msg.role === role);
  if (!m)
    return "";
  return m.blocks.filter((b) => b.kind === "text").map((b) => b.text).join(`
`).trim();
}
function clip(text) {
  return text.length > MAX_SOURCE_CHARS ? text.slice(0, MAX_SOURCE_CHARS) : text;
}
function normalizeTitle(raw) {
  let title = raw.trim();
  try {
    const parsed = JSON.parse(title);
    if (typeof parsed.title === "string")
      title = parsed.title;
  } catch {}
  title = title.replace(/^[\s"'`*_#\-—–:：]+|[\s"'`*_#\-—–:：。.!?！？]+$/g, "").replace(/\s+/g, " ").trim();
  return title ? title.slice(0, MAX_TITLE_CHARS) : null;
}
async function cleanupNamingRollout(namingSid) {
  if (!namingSid)
    return;
  const file = await findCodexRolloutFile(namingSid).catch(() => null);
  if (file)
    await fs8.unlink(file).catch(() => {});
}
async function maybeGenerateCodexTitle(sid) {
  if (getCodexTitle(sid))
    return;
  const detail = await readCodexSessionMessages(sid);
  const userText = firstText(detail.messages, "user");
  if (!userText)
    return;
  const assistantText = firstText(detail.messages, "assistant");
  const prompt = `${TITLE_INSTRUCTIONS}

USER:
"""
${clip(userText)}
"""

ASSISTANT:
"""
${clip(assistantText)}
"""`;
  const { Codex } = await import("@openai/codex-sdk");
  const { codex: codexOpts, thread: threadOpts } = buildTitleOptions();
  const thread = new Codex(codexOpts).startThread({ ...threadOpts, workingDirectory: os4.tmpdir() });
  const abort = new AbortController;
  const timer = setTimeout(() => abort.abort(), TITLE_TIMEOUT_MS);
  try {
    const result = await thread.run(prompt, { outputSchema: TITLE_SCHEMA, signal: abort.signal });
    const title = normalizeTitle(result.finalResponse || "");
    if (title)
      await setCodexTitle(sid, title);
  } finally {
    clearTimeout(timer);
    await cleanupNamingRollout(thread.id);
  }
}

// src/routes/codex.ts
async function registerCodexRoutes(app) {
  app.get("/api/codex/threads", async () => {
    const threads = await listCodexSessions();
    return { threads };
  });
  app.get("/api/codex/workspaces", async () => {
    const sessions2 = await listCodexSessions();
    return { workspaces: groupWorkspaces(sessions2) };
  });
  app.get("/api/codex/workspaces/:project", async ({ params }) => {
    const sessions2 = await listCodexSessions();
    const mine = sessions2.filter((s) => s.project === params.project);
    const meta = groupWorkspaces(mine)[0] || {
      project: params.project,
      cwd: "",
      name: params.project,
      sessionCount: 0,
      lastActivity: 0,
      lastSessionId: "",
      lastPreview: ""
    };
    return { workspace: meta, sessions: mine };
  });
  app.get("/api/codex/threads/:sid", async ({ params }, reply) => {
    try {
      return await readCodexSessionMessages(params.sid);
    } catch (e) {
      return reply.status(404).send({ error: e.message });
    }
  });
  app.delete("/api/codex/threads/:sid", async ({ params }, reply) => {
    try {
      await deleteCodexSession(params.sid);
      return { ok: true };
    } catch (e) {
      return reply.status(404).send({ error: e.message });
    }
  });
  const pipeCodexToSSE = (reply, stream, sid, live) => {
    let clientGone = false;
    reply.raw.on("close", () => {
      clientGone = true;
    });
    const safeSend = (payload) => {
      if (clientGone)
        return;
      try {
        sseSend(reply, payload);
      } catch {
        clientGone = true;
      }
    };
    let capturedSid = sid;
    let liveStarted = false;
    const ensureLive = () => {
      if (liveStarted || !capturedSid)
        return;
      liveStarted = true;
      liveStart(capturedSid, { cwd: live.cwd });
      if (live.text || live.hasImages)
        livePush(capturedSid, { type: "user-text", text: live.text });
    };
    ensureLive();
    const relay = (payload) => {
      safeSend(payload);
      if (capturedSid)
        livePush(capturedSid, payload);
    };
    (async () => {
      for await (const ev of stream) {
        if (ev.kind === "session" && !capturedSid) {
          capturedSid = ev.sessionId;
          ensureLive();
          safeSend({ type: "meta", cwd: live.cwd, sessionId: capturedSid });
        } else if (ev.kind === "delta")
          relay({ type: "delta", text: ev.text });
        else if (ev.kind === "tool_use")
          relay({ type: "tool_use", id: ev.id, name: ev.name, input: ev.input });
        else if (ev.kind === "tool_result")
          relay({ type: "tool_result", tool_use_id: ev.tool_use_id, text: ev.text, isError: ev.isError });
        else if (ev.kind === "usage")
          relay({ type: "usage", outputTokens: ev.outputTokens, thinkingTokens: ev.thinkingTokens });
        else if (ev.kind === "message")
          relay({ type: "event", event: "system", subtype: ev.subtype });
        else if (ev.kind === "error")
          relay({ type: "error", error: ev.error });
        else if (ev.kind === "done") {
          safeSend({ type: "done", exitCode: ev.exitCode });
          if (capturedSid) {
            liveEnd(capturedSid, { type: "done", exitCode: ev.exitCode });
            endRun(capturedSid);
          }
          if (capturedSid && ev.exitCode === 0)
            maybeGenerateCodexTitle(capturedSid).catch(() => {});
          if (!clientGone)
            sseDone(reply);
        }
      }
    })().catch((e) => {
      const msg = e.message;
      if (capturedSid) {
        liveEnd(capturedSid, { type: "done", exitCode: -1, error: msg });
        endRun(capturedSid);
      }
      safeSend({ type: "error", error: msg });
      if (!clientGone)
        sseDone(reply);
    });
  };
  app.post("/api/codex/threads", async (req, reply) => {
    const text = String(req.body?.text || "").trim();
    const images = Array.isArray(req.body?.images) ? req.body.images : [];
    const cwd = String(req.body?.cwd || process.env.HOME || "/tmp");
    if (!text && images.length === 0) {
      return reply.status(400).send({ error: "text or images required" });
    }
    try {
      const st = await fs9.stat(cwd);
      if (!st.isDirectory())
        throw new Error("cwd not a directory");
    } catch (e) {
      return reply.status(400).send({ error: `cwd unusable: ${cwd} (${e.message})` });
    }
    startSSE(reply);
    sseSend(reply, { type: "starting", cwd });
    const abortController = new AbortController;
    const stream = runCodex({ prompt: text, cwd, images, abortController });
    const wrapped = async function* () {
      for await (const ev of stream) {
        if (ev.kind === "session")
          registerRun(ev.sessionId, abortController);
        yield ev;
      }
    }();
    pipeCodexToSSE(reply, wrapped, null, { cwd, text, hasImages: images.length > 0 });
  });
  app.post("/api/codex/threads/:sid/message", async (req, reply) => {
    const sid = req.params.sid;
    const text = String(req.body?.text || "").trim();
    const images = Array.isArray(req.body?.images) ? req.body.images : [];
    if (!text && images.length === 0) {
      return reply.status(400).send({ error: "text or images required" });
    }
    let cwd = process.env.HOME || "/tmp";
    try {
      const detail = await readCodexSessionMessages(sid);
      if (detail.cwd)
        cwd = detail.cwd;
    } catch (e) {
      return reply.status(404).send({ error: e.message });
    }
    startSSE(reply);
    sseSend(reply, { type: "meta", sessionId: sid, cwd });
    const abortController = new AbortController;
    registerRun(sid, abortController);
    pipeCodexToSSE(reply, runCodex({ prompt: text, cwd, resume: sid, images, abortController }), sid, { cwd, text, hasImages: images.length > 0 });
  });
  app.post("/api/codex/threads/:sid/stop", async ({ params }, reply) => {
    const ok = abortRun(params.sid);
    return reply.send({ ok, running: ok });
  });
  app.get("/api/codex/threads/:sid/live", async ({ params }, reply) => {
    startSSE(reply);
    const ls = liveGet(params.sid);
    if (!ls) {
      sseSend(reply, { type: "live-end", reason: "not-live" });
      sseDone(reply);
      return;
    }
    for (const ev of ls.events) {
      try {
        sseSend(reply, ev);
      } catch {
        return;
      }
    }
    if (ls.ended) {
      sseDone(reply);
      return;
    }
    ls.subs.add(reply);
    reply.raw.on("close", () => ls.subs.delete(reply));
  });
  app.get("/api/codex/config", async () => readPublicCodexSettings());
  app.put("/api/codex/config/active", async (req, reply) => {
    const id = String(req.body?.providerId || "").trim();
    if (!id)
      return reply.status(400).send({ error: "providerId required" });
    try {
      await setActiveCodexProvider(id);
    } catch (e) {
      return reply.status(404).send({ error: e.message });
    }
    return reply.send(await readPublicCodexSettings());
  });
  app.put("/api/codex/config/runtime", async (req, reply) => {
    const patch = {};
    const b = req.body || {};
    if (typeof b.sandboxMode === "string")
      patch.sandboxMode = b.sandboxMode;
    if (typeof b.approvalPolicy === "string")
      patch.approvalPolicy = b.approvalPolicy;
    await updateCodexRuntime(patch);
    return reply.send(await readPublicCodexSettings());
  });
  app.post("/api/codex/config/providers", async (req, reply) => {
    const created = await createCodexProvider(pickCustomProviderPatch(req.body || {}));
    return reply.send({ id: created.id, settings: await readPublicCodexSettings() });
  });
  app.put("/api/codex/config/providers/:id", async (req, reply) => {
    const id = req.params.id;
    if (id === CODEX_SYSTEM_PROVIDER_ID) {
      return reply.status(400).send({ error: "system provider is not editable" });
    }
    try {
      await updateCodexProvider(id, pickCustomProviderPatch(req.body || {}));
    } catch (e) {
      return reply.status(404).send({ error: e.message });
    }
    return reply.send(await readPublicCodexSettings());
  });
  app.delete("/api/codex/config/providers/:id", async (req, reply) => {
    if (req.params.id === CODEX_SYSTEM_PROVIDER_ID) {
      return reply.status(400).send({ error: "system provider cannot be deleted" });
    }
    await deleteCodexProvider(req.params.id);
    return reply.send(await readPublicCodexSettings());
  });
  function pickCustomProviderPatch(b) {
    const patch = {};
    if (typeof b.name === "string")
      patch.name = b.name;
    if (typeof b.baseUrl === "string")
      patch.baseUrl = b.baseUrl;
    if (typeof b.model === "string")
      patch.model = b.model;
    if (typeof b.modelProvider === "string")
      patch.modelProvider = b.modelProvider;
    if (b.wireApi === "responses" || b.wireApi === "chat")
      patch.wireApi = b.wireApi;
    if (typeof b.reasoningEffort === "string")
      patch.reasoningEffort = b.reasoningEffort;
    if (typeof b.apiKey === "string" && b.apiKey.length > 0)
      patch.apiKey = b.apiKey;
    if (typeof b.webSearchEnabled === "boolean")
      patch.webSearchEnabled = b.webSearchEnabled;
    if (typeof b.disableResponseStorage === "boolean")
      patch.disableResponseStorage = b.disableResponseStorage;
    if (typeof b.contextWindow === "number")
      patch.contextWindow = b.contextWindow;
    if (typeof b.autoCompactTokenLimit === "number")
      patch.autoCompactTokenLimit = b.autoCompactTokenLimit;
    return patch;
  }
  app.get("/api/engine", async () => ({
    engine: process.env.MACARON_ENGINE === "codex" ? "codex" : "claude"
  }));
}

// src/index.ts
process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT || "300000";
var app = Fastify({
  logger: {
    level: process.env.MACARON_LOG_LEVEL || "info",
    serializers: {
      req(req) {
        return {
          method: req.method,
          url: redactTokenInUrl(req.url),
          host: req.host,
          remoteAddress: req.ip,
          remotePort: req.socket?.remotePort
        };
      }
    }
  },
  ignoreTrailingSlash: true,
  bodyLimit: 2 * 1024 * 1024
});
var { token: authToken, generated: authGenerated } = resolveToken(HOST, AUTH_TOKEN);
app.addHook("onRequest", makeAuthHook(authToken));
await app.register(async (instance) => {
  await registerHealthRoutes(instance);
  await registerAuthRoutes(instance, authToken);
  await registerSettingsRoutes(instance);
  await registerRelayRoutes(instance);
  await registerWorkspaceRoutes(instance);
  await registerSessionRoutes(instance);
  await registerCodexRoutes(instance);
});
if (existsSync4(WEB_DIST)) {
  await app.register(fastifyStatic, {
    root: WEB_DIST,
    prefix: "/",
    index: false
  });
  const spaEntry = process.env.MACARON_ENGINE === "codex" ? "codex.html" : "index.html";
  app.get("/", (_req, reply) => reply.sendFile(spaEntry));
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) {
      return reply.status(404).send({ error: "not found", path: req.url });
    }
    return reply.sendFile(spaEntry);
  });
} else {
  app.log.warn(`web dist not found at ${WEB_DIST} — running in API-only mode (use vite dev for the UI)`);
  app.setNotFoundHandler((req, reply) => reply.status(404).send({ error: "not found", path: req.url }));
}
try {
  await warmSettingsCache();
  await warmPermissionRulesCache();
  await warmCodexConfigCache();
  await warmCodexTitlesCache();
  await app.listen({ host: HOST, port: PORT });
  app.log.info(`macaron server listening on http://${HOST}:${PORT}`);
  if (authGenerated) {
    app.log.warn(`bound to non-loopback host ${HOST} with no MACARON_AUTH_TOKEN — generated one for this run.`);
    console.log(`connect from another device with: http://${HOST}:${PORT}/?token=${authToken}`);
  } else if (authToken) {
    app.log.info("server auth enabled (MACARON_AUTH_TOKEN) — remote requests require the token.");
  }
  setImmediate(() => checkGenUI(`import "$macaron/ui";
export default function App() { return null }`));
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
