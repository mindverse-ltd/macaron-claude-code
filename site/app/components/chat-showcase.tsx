import { useEffect, useState } from 'react';
import { Check, Sparkles } from 'lucide-react';
import { cn } from '@/lib/cn';

type GenUI = 'form' | 'chart' | 'mixed';
type Entry = { side: 'agent' | 'human'; lines: number[] } | { genui: GenUI };

// One full loop of the placeholder conversation: alternating agent/human
// bubbles with a highlighted GenUI block after every exchange. The feed cycles
// through this script forever, so the loop is seamless by construction.
const SCRIPT: Entry[] = [
  { side: 'human', lines: [148] },
  { side: 'agent', lines: [180, 116] },
  { side: 'human', lines: [88] },
  { genui: 'form' },
  { side: 'human', lines: [132, 64] },
  { side: 'agent', lines: [164] },
  { side: 'human', lines: [104] },
  { genui: 'chart' },
  { side: 'human', lines: [156] },
  { side: 'agent', lines: [120, 172] },
  { side: 'human', lines: [92] },
  { genui: 'mixed' },
];

const KEEP = 10;
const INITIAL = 4;

function Lines({ widths, className }: { widths: number[]; className?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      {widths.map((w, i) => (
        <div key={i} className={cn('h-2 max-w-full rounded-full', className ?? 'bg-fd-muted-foreground/35')} style={{ width: w }} />
      ))}
    </div>
  );
}

function FormUI() {
  const [choice, setChoice] = useState(1);
  const [sent, setSent] = useState(false);
  return (
    <div className="flex flex-col gap-2.5">
      <div className="h-2 w-14 rounded-full bg-fd-muted-foreground/35" />
      <div className="flex h-8 items-center rounded-lg border bg-fd-background/60 px-2.5">
        <div className="h-1.5 w-20 rounded-full bg-fd-muted-foreground/25" />
      </div>
      <div className="h-2 w-20 rounded-full bg-fd-muted-foreground/35" />
      <div className="flex gap-1.5">
        {[0, 1, 2].map((i) => (
          <button
            key={i}
            type="button"
            aria-label={`Option ${i + 1}`}
            onClick={() => setChoice(i)}
            className={cn(
              'flex h-7 flex-1 items-center justify-center rounded-lg border transition-colors',
              i === choice ? 'border-genui/60 bg-genui/15' : 'bg-fd-background/60 hovered:bg-fd-accent',
            )}
          >
            <span className={cn('h-1.5 w-8 rounded-full', i === choice ? 'bg-genui/60' : 'bg-fd-muted-foreground/30')} />
          </button>
        ))}
      </div>
      <button
        type="button"
        aria-label="Submit"
        onClick={() => setSent(true)}
        className="mt-0.5 flex h-8 w-24 items-center justify-center rounded-lg bg-genui transition-transform active:scale-95"
      >
        {sent ? <Check className="size-4 text-white" /> : <span className="h-1.5 w-10 rounded-full bg-white/80" />}
      </button>
    </div>
  );
}

// Bars rise from the baseline on mount; the springy overshoot lives in the
// easing so height changes (mount and dataset switches) share one transition.
const BAR_TRANSITION = 'height 0.6s cubic-bezier(0.34, 1.3, 0.64, 1)';

function useRaised() {
  const [raised, setRaised] = useState(false);
  useEffect(() => setRaised(true), []);
  return raised;
}

const CHART = [42, 68, 34, 88, 56, 74, 48, 62, 30, 80, 52, 66];

function ChartUI() {
  const raised = useRaised();
  const [active, setActive] = useState(3);
  return (
    <div className="flex h-24 items-end gap-1.5">
      {CHART.map((h, i) => (
        <button
          key={i}
          type="button"
          aria-label={`Bar ${i + 1}`}
          onClick={() => setActive(i)}
          className={cn('flex-1 rounded-t-md transition-colors', i === active ? 'bg-genui' : 'bg-fd-muted-foreground/30 hovered:bg-fd-muted-foreground/50')}
          style={{ height: raised ? `${h}%` : '6%', transition: `${BAR_TRANSITION}, background-color 0.2s`, transitionDelay: raised ? `${i * 45}ms` : '0ms' }}
        />
      ))}
    </div>
  );
}

const SETS = [
  [64, 40, 82, 55, 70, 46, 62],
  [38, 76, 48, 90, 30, 68, 54],
  [85, 52, 66, 30, 58, 78, 44],
];

function MixedUI() {
  const raised = useRaised();
  const [sel, setSel] = useState(0);
  return (
    <div className="flex items-stretch gap-3">
      <div className="flex w-24 shrink-0 flex-col justify-between gap-1.5">
        {SETS.map((_, i) => (
          <button
            key={i}
            type="button"
            aria-label={`Series ${i + 1}`}
            onClick={() => setSel(i)}
            className={cn(
              'flex items-center gap-1.5 rounded-lg border px-2 py-1.5 transition-colors',
              i === sel ? 'border-genui/60 bg-genui/15' : 'bg-fd-background/60 hovered:bg-fd-accent',
            )}
          >
            <span className={cn('size-2 rounded-full transition-colors', i === sel ? 'bg-genui' : 'bg-fd-muted-foreground/30')} />
            <span className="h-1.5 w-10 rounded-full bg-fd-muted-foreground/35" />
          </button>
        ))}
      </div>
      <div className="flex h-24 flex-1 items-end gap-1.5">
        {SETS[sel].map((h, i) => (
          <div
            key={i}
            className="flex-1 rounded-t-md bg-genui/75"
            style={{ height: raised ? `${h}%` : '6%', transition: BAR_TRANSITION, transitionDelay: raised ? `${i * 40}ms` : '0ms' }}
          />
        ))}
      </div>
    </div>
  );
}

function GenUICard({ kind }: { kind: GenUI }) {
  return (
    <div className="flex w-full flex-col gap-3 rounded-2xl rounded-bl-md border border-genui/30 bg-genui/8 p-3.5">
      <div className="flex items-center gap-1.5 text-genui">
        <Sparkles className="size-3.5" />
        <div className="h-2 w-16 rounded-full bg-genui/40" />
      </div>
      {kind === 'form' ? <FormUI /> : kind === 'chart' ? <ChartUI /> : <MixedUI />}
    </div>
  );
}

function Row({ entry, animate }: { entry: Entry; animate: boolean }) {
  const human = 'side' in entry && entry.side === 'human';
  return (
    <div className={cn('grid', animate && 'chat-grow')}>
      <div className="min-h-0 overflow-hidden">
        <div className={cn('flex pt-3', human ? 'justify-end' : 'justify-start')}>
          <div className={cn(animate && 'chat-pop', human ? 'origin-bottom-right' : 'origin-bottom-left', 'genui' in entry ? 'w-[85%]' : 'max-w-[75%]')}>
            {'genui' in entry ? (
              <GenUICard kind={entry.genui} />
            ) : (
              <div className={cn('rounded-2xl px-3.5 py-2.5', human ? 'rounded-br-md bg-fd-foreground/10' : 'rounded-bl-md bg-fd-secondary')}>
                <Lines widths={entry.lines} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ChatShowcase() {
  const [rows, setRows] = useState(() => SCRIPT.slice(0, INITIAL).map((entry, id) => ({ id, entry, animate: false })));

  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let index = INITIAL;
    let id = INITIAL;
    let timer: number;
    const tick = () => {
      const entry = SCRIPT[index % SCRIPT.length];
      setRows((prev) => [...prev.slice(1 - KEEP), { id: id++, entry, animate: true }]);
      index++;
      // Dwell on GenUI blocks so they can be poked at before the chat moves on.
      timer = window.setTimeout(tick, 'genui' in entry ? 3400 : 950);
    };
    timer = window.setTimeout(tick, 1200);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="chat-mask relative h-105 overflow-hidden">
      <div className="absolute inset-x-0 bottom-0">
        {rows.map(({ id, entry, animate }) => (
          <Row key={id} entry={entry} animate={animate} />
        ))}
      </div>
    </div>
  );
}
