import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

// Push-to-talk speech-to-text. Records via MediaRecorder, POSTs the audio to
// the server's Whisper proxy, returns the transcript. Mirrors the shape every
// serious Claude Code WebUI converged on — browser-native SpeechRecognition is
// skipped on purpose (no Firefox, flaky Safari).

export type VoiceState = 'idle' | 'recording' | 'transcribing';

// MIME candidates in preference order. Opus-in-webm is smallest and best
// supported on Chrome/Edge/Firefox; mp4 is the Safari fallback.
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];

function pickMimeType(): string {
  const MR = window.MediaRecorder;
  if (MR?.isTypeSupported) {
    for (const m of MIME_CANDIDATES) if (MR.isTypeSupported(m)) return m;
  }
  return '';
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || '').split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export function useVoiceInput(onTranscript: (text: string) => void, onError?: (msg: string) => void) {
  const [available, setAvailable] = useState(false);
  const [state, setState] = useState<VoiceState>('idle');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  // Guards the async getUserMedia window: a second tap (state hasn't flipped to
  // 'recording' yet) or an unmount mid-permission-prompt must not start a
  // second stream or a recorder on a dead component.
  const startingRef = useRef(false);
  const mountedRef = useRef(true);

  // Feature-gate on both a configured backend and browser capability.
  useEffect(() => {
    let alive = true;
    const supported = typeof window.MediaRecorder !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);
    if (!supported) return;
    api.voiceHealth().then((h) => { if (alive) setAvailable(h.configured); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const cleanup = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
  }, []);

  const start = useCallback(async () => {
    if (state !== 'idle' || startingRef.current) return;
    startingRef.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      // Unmounted (or cleaned up) while the permission prompt was open — drop
      // the stream instead of leaving the mic hot on a dead component.
      if (!mountedRef.current) { stream.getTracks().forEach((t) => t.stop()); return; }
      streamRef.current = stream;
      const mimeType = pickMimeType();
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      rec.onstop = async () => {
        const type = rec.mimeType || mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type });
        cleanup();
        // Guard against an accidental tap that captured nothing meaningful.
        if (blob.size < 800) { setState('idle'); return; }
        setState('transcribing');
        try {
          const b64 = await blobToBase64(blob);
          const { text } = await api.transcribe(b64, type);
          if (text.trim()) onTranscript(text.trim());
        } catch (e) {
          onError?.(`transcription failed: ${(e as Error).message}`);
        } finally {
          setState('idle');
        }
      };
      rec.start();
      recorderRef.current = rec;
      setState('recording');
    } catch (e) {
      cleanup();
      setState('idle');
      const err = e as Error;
      const msg = err.name === 'NotAllowedError'
        ? 'microphone permission denied'
        : err.name === 'NotFoundError'
          ? 'no microphone found'
          : `microphone error: ${err.message}`;
      onError?.(msg);
    } finally {
      startingRef.current = false;
    }
  }, [state, cleanup, onTranscript, onError]);

  const stop = useCallback(() => {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
  }, []);

  const toggle = useCallback(() => {
    if (state === 'recording') stop();
    else if (state === 'idle') void start();
  }, [state, start, stop]);

  useEffect(() => () => { mountedRef.current = false; cleanup(); }, [cleanup]);

  return { available, state, toggle };
}
