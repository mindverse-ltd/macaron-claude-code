// Web Push state, persisted to ~/.claude/macaron-push.json.
//
// Two things live here: a lazily-generated VAPID keypair (so there are zero
// env vars to manage — first use mints and persists the pair) and the list of
// browser push subscriptions. sendPush() ships a payload to every subscription
// and prunes the ones the push service reports as gone (404/410).
//
// Kept separate from macaron-config.json (provider settings) on purpose: this
// file is device/subscription state, not user-facing config.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { HOME } from '../config.js';
const PUSH_PATH = path.join(HOME, '.claude', 'macaron-push.json');
let cache = null;
async function load() {
    if (cache)
        return cache;
    try {
        const raw = await fs.readFile(PUSH_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed?.vapid?.publicKey && parsed?.vapid?.privateKey) {
            cache = { vapid: parsed.vapid, subscriptions: parsed.subscriptions ?? [] };
            return cache;
        }
    }
    catch { /* missing or corrupt — mint fresh below */ }
    const vapid = webpush.generateVAPIDKeys();
    cache = { vapid, subscriptions: [] };
    await persist();
    return cache;
}
async function persist() {
    if (!cache)
        return;
    await fs.mkdir(path.dirname(PUSH_PATH), { recursive: true });
    await fs.writeFile(PUSH_PATH, JSON.stringify(cache, null, 2), 'utf8');
}
export async function getVapidPublicKey() {
    return (await load()).vapid.publicKey;
}
export async function saveSubscription(sub) {
    const s = await load();
    if (s.subscriptions.some((x) => x.endpoint === sub.endpoint))
        return;
    s.subscriptions.push(sub);
    await persist();
}
export async function removeSubscription(endpoint) {
    const s = await load();
    const before = s.subscriptions.length;
    s.subscriptions = s.subscriptions.filter((x) => x.endpoint !== endpoint);
    if (s.subscriptions.length !== before)
        await persist();
}
// Fire-and-forget: never throws (a push failure must not crash an SDK run) and
// no-ops when nothing is subscribed. Dead subscriptions (404/410) are pruned.
export async function sendPush(payload) {
    const s = await load();
    if (s.subscriptions.length === 0)
        return;
    // A VAPID subject must be a resolvable https:// or mailto: with a real domain;
    // some push services reject a non-routable one like `.local`.
    webpush.setVapidDetails('https://github.com/mindverse-ltd/macaron-claude-code', s.vapid.publicKey, s.vapid.privateKey);
    const body = JSON.stringify(payload);
    // Snapshot before the multi-second await: a concurrent /unsubscribe can
    // reassign s.subscriptions, which would misalign these indices and prune the
    // wrong endpoint (or index past the end).
    const subs = [...s.subscriptions];
    const results = await Promise.allSettled(subs.map((sub) => webpush.sendNotification(sub, body)));
    const dead = [];
    results.forEach((r, i) => {
        if (r.status === 'rejected') {
            const code = r.reason?.statusCode;
            if (code === 404 || code === 410)
                dead.push(subs[i].endpoint);
        }
    });
    if (dead.length) {
        s.subscriptions = s.subscriptions.filter((x) => !dead.includes(x.endpoint));
        await persist();
    }
}
//# sourceMappingURL=push-store.js.map