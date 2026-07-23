import type { FastifyInstance } from 'fastify';
import { STT_BASE_URL, STT_API_KEY, STT_MODEL, STT_LANGUAGE } from '../config.js';

// Voice input: a thin proxy to any OpenAI-compatible /audio/transcriptions
// endpoint. The browser records with MediaRecorder and POSTs base64 audio
// (reusing the same JSON-body convention as image attachments), so we don't
// pull in @fastify/multipart. The STT key never leaves the server.

type TranscribeBody = { audio?: string; mimeType?: string };

// Cap decoded audio at ~8 MB. Base64 inflates the payload by 4/3, so the
// per-route bodyLimit below is what actually lets an ~8 MB clip reach this
// handler: without it the global 2 MB bodyLimit (server/src/index.ts) would
// reject anything past ~1.5 MB of decoded audio with a generic 413 before we
// run. This decoded-size check is the real ceiling and returns a friendly 413.
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

// Raw request-body ceiling for the transcribe route. Base64 of 8 MB is
// ~10.7 MB; 12 MB leaves headroom for the JSON envelope. Overrides the app's
// global 2 MB bodyLimit so MAX_AUDIO_BYTES is the effective cap, not Fastify's.
const TRANSCRIBE_BODY_LIMIT = 12 * 1024 * 1024;

export async function registerVoiceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/voice/health', async () => ({ configured: Boolean(STT_API_KEY) }));

  app.post<{ Body: TranscribeBody }>('/api/voice/transcribe', { bodyLimit: TRANSCRIBE_BODY_LIMIT }, async (req, reply) => {
    if (!STT_API_KEY) return reply.status(503).send({ error: 'voice input not configured' });
    const audioB64 = String(req.body?.audio || '');
    const mimeType = String(req.body?.mimeType || 'audio/webm');
    if (!audioB64) return reply.status(400).send({ error: 'audio required' });

    const buf = Buffer.from(audioB64, 'base64');
    if (buf.length === 0) return reply.status(400).send({ error: 'audio empty or not base64' });
    if (buf.length > MAX_AUDIO_BYTES) return reply.status(413).send({ error: 'audio too large' });

    const ext = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : 'webm';
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: mimeType }), `recording.${ext}`);
    fd.append('model', STT_MODEL);
    // Pin JSON so a backend defaulting to text/plain doesn't make r.json() throw.
    fd.append('response_format', 'json');
    if (STT_LANGUAGE) fd.append('language', STT_LANGUAGE);

    try {
      const r = await fetch(`${STT_BASE_URL}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${STT_API_KEY}` },
        body: fd,
        // A hung backend would otherwise leave the client stuck in 'transcribing'.
        signal: AbortSignal.timeout(30_000),
      });
      if (!r.ok) {
        const detail = (await r.text()).slice(0, 500);
        app.log.warn(`STT upstream ${r.status}: ${detail}`);
        // Remap upstream auth/4xx to 502 so a backend-key failure isn't
        // mistaken for a client error in this app.
        return reply.status(502).send({ error: `transcription backend error (${r.status})` });
      }
      const data = (await r.json()) as { text?: string };
      return { text: String(data?.text || '') };
    } catch (e) {
      app.log.error(e);
      return reply.status(502).send({ error: 'transcription request failed' });
    }
  });
}
