import { isSearchEnabled, search, syncAll, indexStats } from '../lib/search-index.js';
export async function registerSearchRoutes(app) {
    // Full-text search across every indexed session. `q` is the raw user query;
    // an empty/whitespace query returns no hits rather than erroring.
    app.get('/api/search', async (req) => {
        const query = String(req.query?.q || '').trim();
        if (!isSearchEnabled()) {
            return { enabled: false, query, hits: [] };
        }
        if (!query)
            return { enabled: true, query, hits: [] };
        const limit = Number(req.query?.limit) || 40;
        const hits = await search(query, limit);
        return { enabled: true, query, hits };
    });
    // Force a full re-sync of the index from disk. Handy after bulk session
    // changes; normal searches already self-refresh on a throttle.
    app.post('/api/search/reindex', async (_req, reply) => {
        if (!isSearchEnabled()) {
            return reply.status(400).send({ error: 'search is disabled (MACARON_SEARCH=0)' });
        }
        const r = await syncAll();
        return { ok: true, ...r, ...indexStats() };
    });
}
//# sourceMappingURL=search.js.map