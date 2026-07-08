import { getTunnelState, startTunnel, stopTunnel } from '../lib/tunnel-manager.js';
const VALID = ['cloudflared', 'ngrok'];
export async function registerTunnelRoutes(app) {
    app.get('/api/tunnel/status', async () => getTunnelState());
    app.post('/api/tunnel/start', async (req, reply) => {
        const provider = String(req.body?.provider || '');
        if (!VALID.includes(provider))
            return reply.status(400).send({ error: 'provider must be cloudflared or ngrok' });
        const cur = getTunnelState();
        if (cur.status === 'starting' || cur.status === 'running') {
            return reply.status(409).send({ error: 'a tunnel is already active', state: cur });
        }
        try {
            return await startTunnel(provider);
        }
        catch (e) {
            return reply.status(500).send({ error: e.message, state: getTunnelState() });
        }
    });
    app.post('/api/tunnel/stop', async () => stopTunnel());
}
//# sourceMappingURL=tunnel.js.map