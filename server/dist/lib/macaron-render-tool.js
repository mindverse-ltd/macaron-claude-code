// Shared render_ui handler — the actual work behind the Macaron GenUI tool.
// Used by BOTH the in-process MCP server (Claude side, via
// createSdkMcpServer) AND the standalone stdio MCP server (Codex side,
// spawned as a child of `codex exec`). Both surfaces MUST return an
// identical tool_result shape so the model self-corrects the same way.
import { checkGenUI } from './genui-check.js';
export function handleRenderUI(code) {
    const result = checkGenUI(code);
    const text = result.ok
        ? 'Rendered inline. The user sees the UI now.'
        : `Rendered inline, but the TSX has issues:\n${result.diagnostics}`;
    return { text, ok: result.ok };
}
/** Tool description mirrored on both sides so the model gets the same
 * authoring rules regardless of which engine it's running under. Kept in
 * sync with macaron-mcp.ts's in-process tool description. */
export const RENDER_UI_TOOL_DESCRIPTION = `Render an interactive TSX UI inline in the assistant message. \`code\` is a COMPLETE TSX module the host immediately mounts via React. The host runs the code in a sandbox with these capabilities preloaded:

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

# When to use this tool
Call render_ui when a visual answer beats prose: dashboards, charts, comparison cards, forms, settings panels, interactive widgets, mini editors, status reports. Don't use it for plain text answers. Don't write a markdown TSX fence in chat — that's a failed answer. After render_ui returns, the host already shows the rendered UI to the user; keep your follow-up reply short (one sentence ack at most).`;
//# sourceMappingURL=macaron-render-tool.js.map