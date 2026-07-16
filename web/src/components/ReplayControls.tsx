import { Pause, Play, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Message } from '@macaron/shared';

const SPEEDS = [1, 2, 5] as const;
const MAX_DELAY_MS = 2_000;

function eventTime(message: Message, fallback: number): number {
  const timestamp = message.timestamp ? new Date(message.timestamp).getTime() : NaN;
  return Number.isFinite(timestamp) ? timestamp : fallback;
}

export function useReplay(messages: Message[], disabled = false) {
  const [active, setActive] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [cursor, setCursor] = useState(messages.length);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const signature = `${messages.length}:${messages.at(-1)?.sourceLine ?? ''}:${messages.at(-1)?.timestamp ?? ''}`;
  const timeline = useMemo(() => messages.map((message, index) => ({ message, time: eventTime(message, index) })), [signature]);

  useEffect(() => {
    setActive(false);
    setPlaying(false);
    setCursor(messages.length);
  }, [signature]);

  useEffect(() => {
    if (!active || !playing) return;
    if (cursor >= timeline.length) { setPlaying(false); return; }
    const previous = cursor > 0 ? timeline[cursor - 1]!.time : timeline[cursor]!.time;
    const delay = Math.min(MAX_DELAY_MS, Math.max(0, timeline[cursor]!.time - previous)) / speed;
    const timer = window.setTimeout(() => setCursor((value) => value + 1), delay);
    return () => window.clearTimeout(timer);
  }, [active, cursor, playing, speed, timeline]);

  const start = () => { setActive(true); setCursor(0); setPlaying(true); };
  const stop = () => { setActive(false); setPlaying(false); setCursor(messages.length); };
  return {
    messages: active ? messages.slice(0, cursor) : messages,
    controls: disabled || messages.length < 2 ? null : (
      <div className="replay-controls" role="group" aria-label="Session replay">
        <button className="replay-button" onClick={active ? () => setPlaying((value) => !value) : start} title={active && playing ? 'Pause replay' : 'Play replay'} aria-label={active && playing ? 'Pause replay' : 'Play replay'}>
          {active && playing ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
        </button>
        {active && <button className="replay-button" onClick={stop} title="Exit replay" aria-label="Exit replay"><RotateCcw size={14} aria-hidden="true" /></button>}
        <input type="range" min={0} max={messages.length} value={active ? cursor : messages.length} onChange={(event) => { setActive(true); setPlaying(false); setCursor(Number(event.target.value)); }} aria-label="Replay position" />
        <span className="replay-count">{active ? cursor : messages.length}/{messages.length}</span>
        <button className="replay-button replay-speed" onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]!)} title="Replay speed">{speed}×</button>
      </div>
    ),
  };
}
