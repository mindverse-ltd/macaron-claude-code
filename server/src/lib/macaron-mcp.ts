// MCP server is just the transport bridge. Claude Agent SDK only accepts
// custom tools via MCP — there's no raw-tool API — so we wrap a `render_ui`
// tool whose `code` field carries a Claude-authored TSX module. The server
// streams the tool_input_delta back to the WebUI as it's typed (see
// claude-runner.ts), and the handler runs TS diagnostics over the final TSX,
// feeding { ok, diagnostics? } back as the tool_result so bad renders self-correct.
// We do NOT call any external "generator" model — the Claude in this session
// writes the TSX directly using $macaron/ui, taught via the tool description below.

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { checkGenUI } from './genui-check.js';

// Distilled from the macaron-genui-demo system prompt. Teaches Claude the
// $macaron/ui library + streaming-friendly write order.
const TOOL_DESCRIPTION = `Render an interactive TSX UI inline in the assistant message. \`code\` is a COMPLETE TSX module the host immediately mounts via React. The host runs the code in a sandbox with these capabilities preloaded:

# Imports — exact rules
- Import all UI primitives from \`$macaron/ui\` in ONE combined import: \`import { Stack, Row, Card, Button, Badge, Text, Tabs, TabsList, TabsTrigger, TabsContent, NumberFlow, motion, AnimatePresence /* etc */ } from '$macaron/ui';\`
- For charts: \`import { ChartContainer, ChartTooltip, ChartTooltipContent, AreaChart, Area, BarChart, Bar, LineChart, Line, CartesianGrid, XAxis, YAxis, PieChart, Pie } from '$macaron/ui/charts';\` (never import 'recharts' directly)
- Icons: \`import { Plus, Minus, ChevronDown, CheckCircle2, /* … */ } from 'lucide-react';\`
- React: \`import { useState, useEffect, useRef } from 'react';\`
- No relative imports, no other bare packages, no markdown fences, no JSON wrapping. esm.sh URLs are allowed for tiny React-free helpers only.

# Available $macaron/ui components (use these instead of raw div/span when possible)
Layout: Stack, Row, Grid, Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter, Surface, FeatureCard, Field, Separator
Text: Text, TextShimmer, TextMorph, TextLoop, SpinningText
Controls: Button, Badge, Checkbox, Switch, Slider, Input, Textarea, Select+SelectTrigger+SelectValue+SelectContent+SelectItem+SelectGroup+SelectLabel+SelectSeparator, RadioGroup+RadioGroupItem, Label, Calendar, InputOTP+InputOTPGroup+InputOTPSlot+InputOTPSeparator
Surfaces: Tabs+TabsList+TabsTrigger+TabsContent, Accordion+AccordionItem+AccordionTrigger+AccordionContent, Popover+PopoverTrigger+PopoverContent, MorphingDialog+MorphingDialogTrigger+MorphingDialogContainer+MorphingDialogContent+MorphingDialogTitle+MorphingDialogClose, Disclosure+DisclosureTrigger+DisclosureContent
Lists/data: Table+TableHeader+TableBody+TableRow+TableHead+TableCell+TableFooter+TableCaption, Carousel+CarouselContent+CarouselItem+CarouselPrevious+CarouselNext, Sortable, Timeline+TimelineItem+TimelineHeader+TimelineTitle+TimelineDate+TimelineContent
Stats: Stat, StatGrid, PillRow, NumberFlow
Media/decor: Avatar+AvatarImage+AvatarFallback+AvatarBadge+AvatarGroup, Tilt, GlowEffect, ProgressiveBlur, motion, AnimatePresence

# Streaming-first write order (CRITICAL)
The preview renders as you type. To keep it interactive sooner:
1. Imports
2. \`export default function App() {\`
3. Immediately \`return (\` with real visible JSX
4. THEN put data arrays / helpers AFTER the return inside the function — never at module top
That way the user sees a meaningful shell within seconds.

# Quality rules
- One default export, no extra files, no fetch/network
- Use UnoCSS Tailwind v3 utility classes via className
- Every mapped list needs stable \`key\` from data (id/slug); never \`key={i}\`
- Keep helper components at module scope, not inside App
- No \`as any\` casts in JSX

# When to use this tool
Call render_ui when a visual answer beats prose: dashboards, charts, comparison cards, forms, settings panels, interactive widgets, mini editors, status reports. Don't use it for plain text answers. Don't write a markdown TSX fence in chat — that's a failed answer. After render_ui returns, the host already shows the rendered UI to the user; keep your follow-up reply short (one sentence ack at most).`;

const INSTRUCTIONS =
  'Macaron GenUI bridge. The render_ui tool inlines a TSX component into the conversation. ' +
  'YOU author the code field with a complete TSX module using $macaron/ui. The user already sees ' +
  'the rendered UI when render_ui returns — do NOT paste, quote, or summarize the code in your reply.';

export const macaronMcpServer = createSdkMcpServer({
  name: 'macaron',
  version: '0.2.0',
  instructions: INSTRUCTIONS,
  alwaysLoad: true,
  tools: [
    tool(
      'render_ui',
      TOOL_DESCRIPTION,
      {
        code: z
          .string()
          .min(20)
          .describe('A complete TSX module — imports + `export default function App()` — that the host mounts inline.'),
      },
      async ({ code }) => {
        // The route layer streams partial code to the client from Claude's
        // input_json_delta events, so the user already sees the rendered UI by
        // the time this handler runs. What we add here is diagnostics: run TS
        // checks against the vendored $macaron/ui source and feed { ok,
        // diagnostics? } back to Claude as the tool_result, so a bad render
        // (wrong props, missing exports, type errors) can self-correct in-turn.
        const result = checkGenUI(code);
        const text = result.ok ? 'Rendered inline. The user sees the UI now.' : `Rendered inline, but the TSX has issues:\n${result.diagnostics}`;
        return { content: [{ type: 'text' as const, text }] };
      },
      // Keep render_ui visible in the first prompt even when Claude defers MCP
      // tools behind tool search. The server-level alwaysLoad covers any
      // future Macaron tools; this keeps the core bridge explicit.
      { alwaysLoad: true },
    ),
  ],
});
