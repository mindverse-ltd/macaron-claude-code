// Shared render_ui handler — the actual work behind the Macaron GenUI tool.
// Used by BOTH the in-process MCP server (Claude side, via
// createSdkMcpServer) AND the standalone stdio MCP server (Codex side,
// spawned as a child of `codex exec`). Both surfaces MUST return an
// identical tool_result shape so the model self-corrects the same way.

import { checkGenUI } from './genui-check.js';

export type RenderUIResult = {
  /** Text to send back as the tool_result content. */
  text: string;
  /** false when checkGenUI flagged diagnostics — surfaced so the caller
   * (mcp handler) can flip isError if the transport supports it. */
  ok: boolean;
};

/** Server-level instructions surfaced to the model at MCP handshake time.
 * Kept short and imperative — this is a high-context slot so we spend it
 * on the trigger heuristic, not on the authoring rules (those live in the
 * tool description and only load when the tool is actually invoked). */
export const RENDER_UI_INSTRUCTIONS =
  'Macaron GenUI bridge. `render_ui` is your PRIMARY answer format whenever the response ' +
  'has structure — call it, do not describe it. Structure means any of: (a) explicit visual ' +
  'ask ("画一个 …", "show me …", "make …", dashboard/card/form/chart/table/widget/page); ' +
  '(b) the user needs to CHOOSE between 2+ options — render clickable buttons that call ' +
  'sendUserMessage; (c) COMPARING or SUMMARIZING 2+ items with attributes — render a Card / ' +
  'Table / StatGrid, not a Markdown table; (d) DATA the user shared (JSON, CSV, list of ' +
  'records) — visualize it; (e) a FORM / wizard / configurator — render inputs the user ' +
  'submits back via sendUserMessage; (f) proposing "next steps" the user might act on — ' +
  'render each as a clickable CTA. NEVER put TSX in ```tsx fences. NEVER explain the code ' +
  'before calling — call first, then one-sentence ack. DO stay in plain text for: pure prose ' +
  'explanations, code walkthroughs, debugging traces, single-line Q&A, code you\'re asked ' +
  'to write to a FILE (that\'s Edit/Write, not render_ui).';

export function handleRenderUI(code: string): RenderUIResult {
  const result = checkGenUI(code);
  const text = result.ok
    ? 'Rendered inline. The user sees the UI now.'
    : `Rendered inline, but the TSX has issues:\n${result.diagnostics}`;
  return { text, ok: result.ok };
}

/** Tool description mirrored on both sides so the model gets the same
 * authoring rules regardless of which engine it's running under. Kept in
 * sync with macaron-mcp.ts's in-process tool description. */
export const RENDER_UI_TOOL_DESCRIPTION = `Render an interactive TSX UI inline in the assistant message. \`code\` is a COMPLETE TSX module the host immediately mounts via React.

# MUST call render_ui — not describe, not fence — when

**Explicit visual asks** (obvious):
- dashboard, panel, card, widget, badge, chart, graph, plot, table, timeline, calendar, gallery, grid
- login / signup / settings / profile / pricing / checkout / onboarding page or form
- comparison, leaderboard, roadmap, status report, changelog, KPIs, metrics
- interactive demo, mini editor, playground, animation, toy component
- "画一个 X", "show me X", "make X", "draw X", "design X", "prototype X", "生成一个 X", "做一个 X"

**Structural fit** — call render_ui even when the user did NOT ask visually, if your answer would contain any of:
- **Choice**: 2+ options the user needs to pick from → render clickable buttons that call \`sendUserMessage\` with the chosen option. (You would otherwise write "Options: 1. A  2. B  3. C, which do you want?" — that's a bad answer; render buttons instead.)
- **Comparison / summary of records**: 2+ items with attributes ("here are 3 approaches, tradeoffs are…") → render a Table or side-by-side Cards, not a Markdown table.
- **Structured data the user shared**: array of objects, JSON, CSV, config, records → visualize as a UI, not a bulleted breakdown.
- **Status / dashboard / snapshot**: build result, PR checks, service health, TODO progress, session state → render Stats/StatGrid/Timeline.
- **Form / wizard / configurator**: any answer that would say "tell me the following: name, ..., ..." → render Inputs the user submits back via sendUserMessage.
- **Actionable next steps**: "you could do X, Y, or Z" where each step is something the user might click to trigger → render each as a Button that fires sendUserMessage.

If a Markdown table, numbered list of ≥3 things, or "reply with your choice" would be in your answer — you're describing what render_ui is for. Render it instead.

# MUST NOT

- **NEVER** put TSX inside a markdown code fence in your assistant text.  \`\`\`tsx / \`\`\`jsx code blocks are a failed answer — the user came here for a rendered component, not source to copy-paste.
- **NEVER** explain the component structure before calling. Call first, ack in one sentence after.
- **NEVER** call render_ui for:
  - Pure prose explanations, code walkthroughs, debugging traces, single-sentence Q&A
  - Code you are asked to write to a FILE (use Edit/Write, not render_ui)
  - Simple confirmations ("done", "here's the file path", "the tests pass")
  - Answers that fit in one line of text

# Imports — exact rules

- Import all UI primitives from \`$macaron/ui\` in ONE combined import: \`import { Stack, Row, Card, Button, Badge, Text, Tabs, TabsList, TabsTrigger, TabsContent, NumberFlow, motion, AnimatePresence /* etc */ } from '$macaron/ui';\`
- For charts: \`import { ChartContainer, ChartTooltip, ChartTooltipContent, AreaChart, Area, BarChart, Bar, LineChart, Line, CartesianGrid, XAxis, YAxis, PieChart, Pie } from '$macaron/ui/charts';\` (never import 'recharts' directly)
- Icons: \`import { Plus, Minus, ChevronDown, CheckCircle2, /* … */ } from 'lucide-react';\`
- React: \`import { useState, useEffect, useRef } from 'react';\`
- No relative imports, no other bare packages, no markdown fences, no JSON wrapping.

# Available $macaron/ui components (use these instead of raw div/span when possible)

Layout: Stack, Row, Grid, Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter, Surface, FeatureCard, Field, Separator
Text: Text, TextShimmer, TextMorph, TextLoop, SpinningText
Controls: Button, Badge, Checkbox, Switch, Slider, Input, Textarea, Select+SelectTrigger+SelectValue+SelectContent+SelectItem, RadioGroup+RadioGroupItem, Label, Calendar, InputOTP
Surfaces: Tabs+TabsList+TabsTrigger+TabsContent, Accordion, Popover, MorphingDialog, Disclosure
Lists/data: Table, Carousel, Sortable, Timeline
Stats: Stat, StatGrid, PillRow, NumberFlow
Media/decor: Avatar+AvatarImage+AvatarFallback, Tilt, GlowEffect, ProgressiveBlur, motion, AnimatePresence

# Quality rules

- One default export (\`export default function App()\`), no extra files, no fetch/network
- Use UnoCSS Tailwind v3 utility classes via className
- Every mapped list needs stable \`key\` from data (id/slug); never \`key={i}\`
- Keep helper components at module scope, not inside App
- No \`as any\` casts in JSX

# Sending messages back to chat (interactive widgets)

- Import from \`$macaron/chat\`: \`import { sendUserMessage } from '$macaron/chat';\`
- \`sendUserMessage(prompt)\` takes a single string and posts it to the chat as if the user typed it, driving the next assistant turn. Use it when a widget action should continue the conversation: form submits, choice confirmations, apply/regenerate buttons, wizard steps.
- \`prompt\` is the message the next turn receives — write it as the user would (e.g. "Book the 3pm slot"); fold any structured context the next turn needs directly into that string.
- Call it ONLY from event handlers or effects, never during render, and at most once per user gesture. For a purely display-only UI, don't call it.

# After the call

The host already shows the rendered UI to the user. Your follow-up reply is at most ONE sentence acknowledging what was rendered (e.g. "Here's the dashboard."). Do not paste the code, do not describe the layout, do not offer variations unless the user asks.`;
