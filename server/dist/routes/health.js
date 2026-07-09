import { getActiveProviderEnv } from '../lib/settings-store.js';
export async function registerHealthRoutes(app) {
    app.get('/api/health', async () => {
        const { model } = getActiveProviderEnv();
        return { ok: true, model: model || 'claude-opus-4-7' };
    });
}
//# sourceMappingURL=health.js.map