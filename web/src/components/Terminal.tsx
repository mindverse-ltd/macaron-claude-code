import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '../assets/fonts/jetbrains-maple-mono/jetbrains-maple-mono.css';
import '@xterm/xterm/css/xterm.css';
import {
  terminalStreamUrl,
  sendTerminalInput,
  sendTerminalResize,
} from '../lib/terminal';

// Light "paper" theme matching the app's CSS variables (see styles.css :root).
const THEME = {
  background: '#F5F4ED', // --surface-2
  foreground: '#3D3929', // --text
  cursor: '#C96442', // --accent
  cursorAccent: '#F5F4ED',
  selectionBackground: 'rgba(201, 100, 66, 0.22)',
  black: '#3D3929', brightBlack: '#8A8473',
  red: '#C0524A', brightRed: '#C0524A',
  green: '#5A8B5A', brightGreen: '#5A8B5A',
  yellow: '#B88A3A', brightYellow: '#B88A3A',
  blue: '#4A6FA5', brightBlue: '#4A6FA5',
  magenta: '#9A5BA5', brightMagenta: '#9A5BA5',
  cyan: '#3F8A8A', brightCyan: '#3F8A8A',
  white: '#5D584A', brightWhite: '#3D3929',
};

// xterm measures text with OffscreenCanvas in modern browsers; canvas font
// parsing does not resolve CSS custom properties, so keep this as a concrete
// monospace stack instead of var(--font-mono).
const TERMINAL_FONT_SIZE = 12;
const TERMINAL_FONT =
  '"JetBrains Maple Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

async function loadTerminalFont(): Promise<void> {
  const fonts = document.fonts;
  if (!fonts?.load) return;
  await Promise.all([
    fonts.load(`${TERMINAL_FONT_SIZE}px "JetBrains Maple Mono"`),
    fonts.load(`700 ${TERMINAL_FONT_SIZE}px "JetBrains Maple Mono"`),
  ]);
}

export function Terminal({ project, sid, focused }: { project: string; sid: string; focused: boolean }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let raf = 0;
    let ro: ResizeObserver | null = null;
    let es: EventSource | null = null;
    let term: XTerm | null = null;

    void (async () => {
      try { await loadTerminalFont(); } catch { /* fall back to the font stack */ }
      if (disposed) return;

      term = new XTerm({
        fontFamily: TERMINAL_FONT,
        fontSize: TERMINAL_FONT_SIZE,
        theme: THEME,
        cursorBlink: true,
        scrollback: 5000,
        convertEol: false,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);
      fit.fit();
      termRef.current = term;
      fitRef.current = fit;
      if (focused) term.focus();

      const { cols, rows } = term;
      term.onData((data) => sendTerminalInput(project, sid, data));

      // history = full snapshot (reset+write, idempotent on reconnect);
      // output = incremental chunk; exit = dim footer.
      es = new EventSource(terminalStreamUrl(project, sid, cols, rows));
      es.onmessage = (e) => {
        if (e.data === '[DONE]') { es?.close(); return; }
        let msg: { type?: string; data?: string; exitCode?: number; error?: string };
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.type === 'history') { term?.reset(); if (msg.data) term?.write(msg.data); }
        else if (msg.type === 'output') term?.write(msg.data || '');
        else if (msg.type === 'exit') { term?.write(`\r\n\x1b[2m[process exited${msg.exitCode ? ` (${msg.exitCode})` : ''}]\x1b[0m\r\n`); es?.close(); }
        else if (msg.type === 'error') term?.write(`\r\n\x1b[31m${msg.error || 'error'}\x1b[0m\r\n`);
      };
      // Reconnects are useful while the PTY is alive; exit/[DONE] are terminal
      // states, so close the EventSource above to avoid respawning a shell.

      const doFit = () => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          try { fit.fit(); } catch { /* detached */ }
          if (term?.cols && term.rows) sendTerminalResize(project, sid, term.cols, term.rows);
        });
      };
      ro = new ResizeObserver(doFit);
      ro.observe(host);
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      es?.close();
      term?.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [project, sid]);

  // Focus the terminal when its tile gains focus.
  useEffect(() => {
    if (focused) termRef.current?.focus();
  }, [focused]);

  return <div className="term-host" ref={hostRef} />;
}
