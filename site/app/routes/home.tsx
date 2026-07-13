import type { Route } from './+types/home';
import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { Card, Cards } from 'fumadocs-ui/components/card';
import { Tab, Tabs, TabsList, TabsTrigger } from 'fumadocs-ui/components/tabs';
import { Steps, Step } from 'fumadocs-ui/components/steps';
import { DynamicCodeBlock } from 'fumadocs-ui/components/dynamic-codeblock';
import { Link } from 'react-router';
import { MonitorPlay, MessagesSquare, SlidersHorizontal, Wand2, Puzzle, Terminal } from 'lucide-react';
import ClaudeCode from '@lobehub/icons/es/ClaudeCode/components/Mono';
import Codex from '@lobehub/icons/es/Codex/components/Mono';
import { baseOptions } from '@/lib/layout.shared';

// Fumadocs' code block ships shiki highlighting + a copy button; wrap it so the install steps stay terse.
function Command({ code }: { code: string }) {
  return <DynamicCodeBlock lang="bash" code={code} />;
}

export function meta({}: Route.MetaArgs) {
  return [
    { title: 'Macaron Artifacts' },
    { name: 'description', content: 'The local WebUI, GenUI tooling, and plugin manifests for running Macaron with Claude Code and Codex.' },
  ];
}

// pkg.pr.new ships prebuilt tarballs per commit; `<sha>` stands in for a commit on main.
const PKG = 'https://pkg.pr.new/mindverse-ltd/macaron-claude-code/mcc@<sha>';
const PKG_MCX = 'https://pkg.pr.new/mindverse-ltd/macaron-claude-code/mcx@<sha>';

export default function Home() {
  return (
    <HomeLayout {...baseOptions()}>
      <div className="flex flex-col items-center flex-1 px-4">
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
            <Link
              className="text-sm bg-fd-primary text-fd-primary-foreground rounded-full font-medium px-5 py-2.5 transition-opacity hovered:opacity-90"
              to="/docs"
            >
              Read the Docs
            </Link>
            <Link
              className="text-sm border rounded-full font-medium px-5 py-2.5 transition-colors hovered:bg-fd-accent hovered:text-fd-accent-foreground"
              to="/docs/usage"
            >
              Quick Start
            </Link>
          </div>
        </section>

        <section className="w-full max-w-3xl pb-20">
          <div className="mb-6 text-center">
            <h2 className="text-2xl font-semibold mb-1">Install</h2>
            <p className="text-fd-muted-foreground">
              Add the plugin to your agent, or run the published build with no install at all.
            </p>
          </div>

          <div className="mb-4 text-sm font-medium text-fd-muted-foreground">Plugin Marketplace</div>
          <Tabs defaultValue="claude-code">
            <TabsList>
              <TabsTrigger value="claude-code" className="gap-2">
                <ClaudeCode size={16} /> Claude Code
              </TabsTrigger>
              <TabsTrigger value="codex" className="gap-2">
                <Codex size={16} /> Codex
              </TabsTrigger>
            </TabsList>
            <Tab value="claude-code">
              <Steps>
                <Step>
                  <p className="font-medium">Add the Marketplace Source</p>
                  <Command code="claude plugin marketplace add https://github.com/MindLab-Research/macaron-artifacts" />
                </Step>
                <Step>
                  <p className="font-medium">Install the Plugin</p>
                  <Command code="claude plugin install macaron@macaron" />
                </Step>
                <Step>
                  <p className="font-medium">Run It and Open the WebUI</p>
                  <p className="text-sm text-fd-muted-foreground">
                    Run <code className="text-fd-foreground">/macaron</code> in a session — the WebUI opens on{' '}
                    <code className="text-fd-foreground">http://localhost:7878</code>.
                  </p>
                </Step>
              </Steps>
            </Tab>
            <Tab value="codex">
              <Steps>
                <Step>
                  <p className="font-medium">Add the Marketplace Source</p>
                  <Command code="codex plugin marketplace add https://github.com/MindLab-Research/macaron-artifacts" />
                </Step>
                <Step>
                  <p className="font-medium">Add the Plugin</p>
                  <Command code="codex plugin add macaron@macaron" />
                </Step>
                <Step>
                  <p className="font-medium">Run It and Open the WebUI</p>
                  <p className="text-sm text-fd-muted-foreground">
                    Ask Codex to open the Macaron WebUI — it serves on{' '}
                    <code className="text-fd-foreground">http://localhost:7979</code>.
                  </p>
                </Step>
              </Steps>
            </Tab>
          </Tabs>

          <div className="mt-8 mb-4 text-sm font-medium text-fd-muted-foreground">Run Without Installing</div>
          <p className="mb-3 text-sm text-fd-muted-foreground">
            The <code className="text-fd-foreground">pkg.pr.new</code> tarball ships prebuilt bundles and two bins —{' '}
            <code className="text-fd-foreground">mcc</code> (Claude, port 7878) and{' '}
            <code className="text-fd-foreground">mcx</code> (Codex, port 7979). Replace{' '}
            <code className="text-fd-foreground">&lt;sha&gt;</code> with a commit on <code className="text-fd-foreground">main</code>.
          </p>
          <Tabs items={['bun', 'npm']}>
            <Tab value="bun">
              <div className="flex flex-col gap-3">
                <div>
                  <div className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
                    <ClaudeCode size={15} /> Claude — <code className="text-fd-muted-foreground">mcc</code>
                  </div>
                  <Command code={`bunx mcc@${PKG}`} />
                </div>
                <div>
                  <div className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
                    <Codex size={15} /> Codex — <code className="text-fd-muted-foreground">mcx</code>
                  </div>
                  <Command code={`bunx mcx@${PKG_MCX}`} />
                </div>
              </div>
            </Tab>
            <Tab value="npm">
              <div className="flex flex-col gap-3">
                <div>
                  <div className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
                    <ClaudeCode size={15} /> Claude — <code className="text-fd-muted-foreground">mcc</code>
                  </div>
                  <Command code={`npx mcc@${PKG}`} />
                </div>
                <div>
                  <div className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
                    <Codex size={15} /> Codex — <code className="text-fd-muted-foreground">mcx</code>
                  </div>
                  <Command code={`npx mcx@${PKG_MCX}`} />
                </div>
              </div>
            </Tab>
          </Tabs>
        </section>

        <section className="w-full max-w-5xl pb-24">
          <div className="mb-6">
            <h2 className="text-2xl font-semibold mb-1">Run Agents With a UI</h2>
            <p className="text-fd-muted-foreground">Drive Macaron sessions from the browser and watch every turn as it happens.</p>
          </div>
          <Cards className="grid-cols-1 sm:grid-cols-3">
            <Card icon={<MonitorPlay />} title="Visual Sessions" href="/docs/usage">
              Browse workspaces and sessions with previews, then continue a turn from the browser.
            </Card>
            <Card icon={<MessagesSquare />} title="Live Chat" href="/docs/usage">
              Stream thinking, tool calls, and GenUI previews from supported agent runtimes.
            </Card>
            <Card icon={<SlidersHorizontal />} title="Provider Controls" href="/docs/usage">
              Run against an ambient login or a compatible endpoint such as Macaron, OpenRouter, or LiteLLM.
            </Card>
          </Cards>

          <div className="mt-12 mb-6">
            <h2 className="text-2xl font-semibold mb-1">Generate and Extend</h2>
            <p className="text-fd-muted-foreground">GenUI tooling and plugin manifests that plug into your existing agent setup.</p>
          </div>
          <Cards>
            <Card icon={<Wand2 />} title="genui-builder Skill" href="/docs/usage">
              The bundled skill lets supported agents produce GenUI TSX from the command line.
            </Card>
            <Card icon={<Puzzle />} title="Plugin Manifests" href="/docs">
              Ship the manifests that register Macaron Artifacts with Claude Code and Codex.
            </Card>
          </Cards>
        </section>
      </div>
    </HomeLayout>
  );
}
