// Persists final rendered TSX to disk so the UI can re-display a preview
// when the in-memory genui-stream cache has expired (page reload, app
// restart, looking at an old session, etc).
//
// Stored under ~/.macaron-plugin/previews/<tool_use_id>.tsx — tool_use_id is
// Anthropic-format unique enough that a flat directory is fine for now.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const DIR = path.join(os.homedir(), '.macaron-plugin', 'previews');
let dirEnsured = false;
async function ensureDir() {
    if (dirEnsured)
        return;
    await fs.mkdir(DIR, { recursive: true });
    dirEnsured = true;
}
// Disallow path traversal; ids are constrained to safe chars upstream but
// double-check before constructing a path.
function safeName(id) {
    if (!/^[A-Za-z0-9_-]+$/.test(id))
        return null;
    return `${id}.tsx`;
}
export async function savePreview(id, code) {
    const name = safeName(id);
    if (!name)
        return;
    try {
        await ensureDir();
        await fs.writeFile(path.join(DIR, name), code, 'utf8');
    }
    catch {
        /* persistence failures are non-fatal */
    }
}
export async function loadPreview(id) {
    const name = safeName(id);
    if (!name)
        return null;
    try {
        return await fs.readFile(path.join(DIR, name), 'utf8');
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=genui-persistence.js.map