import type { Route } from './+types/home';
import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { Card, Cards } from 'fumadocs-ui/components/card';
import { Link } from 'react-router';
import { MonitorPlay, MessagesSquare, SlidersHorizontal, Wand2, Puzzle, Terminal } from 'lucide-react';
import { baseOptions } from '@/lib/layout.shared';

export function meta({}: Route.MetaArgs) {
  return [
    { title: 'Macaron Artifacts' },
    { name: 'description', content: 'The local WebUI, GenUI tooling, and plugin manifests for running Macaron with Claude Code and Codex.' },
  ];
}

export default function Home() {
  return (
    <HomeLayout {...baseOptions()}>
      <main className="flex flex-col items-center flex-1 px-4">
        <section className="flex flex-col items-center text-center max-w-2xl pt-20 pb-16">
          <span className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs text-fd-muted-foreground mb-6">
            <Terminal className="size-3.5" /> Claude Code &amp; Codex
          </span>
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight mb-4">Macaron Artifacts</h1>
          <p className="text-fd-muted-foreground text-lg mb-8">
            The local WebUI, GenUI tooling, and plugin manifests for running Macaron with Claude Code and Codex — visual
            sessions, live chat, and generated UI, straight from your terminal.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link className="text-sm bg-fd-primary text-fd-primary-foreground rounded-full font-medium px-5 py-2.5" to="/docs">
              Read the docs
            </Link>
            <Link className="text-sm border rounded-full font-medium px-5 py-2.5" to="/docs/usage">
              Quick start
            </Link>
          </div>
        </section>

        <section className="w-full max-w-5xl pb-24">
          <div className="mb-6">
            <h2 className="text-2xl font-semibold mb-1">Run agents with a UI</h2>
            <p className="text-fd-muted-foreground">Drive Macaron sessions from the browser and watch every turn as it happens.</p>
          </div>
          <Cards>
            <Card icon={<MonitorPlay />} title="Visual sessions" href="/docs/usage">
              Browse workspaces and sessions with previews, then continue a turn from the browser.
            </Card>
            <Card icon={<MessagesSquare />} title="Live chat" href="/docs/usage">
              Stream thinking, tool calls, and GenUI previews from supported agent runtimes.
            </Card>
            <Card icon={<SlidersHorizontal />} title="Provider controls" href="/docs/usage">
              Run against an ambient login or a compatible endpoint such as Macaron, OpenRouter, or LiteLLM.
            </Card>
          </Cards>

          <div className="mt-12 mb-6">
            <h2 className="text-2xl font-semibold mb-1">Generate and extend</h2>
            <p className="text-fd-muted-foreground">GenUI tooling and plugin manifests that plug into your existing agent setup.</p>
          </div>
          <Cards>
            <Card icon={<Wand2 />} title="genui-builder skill" href="/docs/usage">
              The bundled skill lets supported agents produce GenUI TSX from the command line.
            </Card>
            <Card icon={<Puzzle />} title="Plugin manifests" href="/docs">
              Ship the manifests that register Macaron artifacts with Claude Code and Codex.
            </Card>
          </Cards>
        </section>
      </main>
    </HomeLayout>
  );
}
