---
background: "#101416"
foreground: "#F4F5EF"
accent: "#B9E86A"
font_display: "Montserrat"
font_mono: "JetBrains Mono"
corner_radius: 8
---

# Replay Workbench

Concept angle: a session replay should feel like a calm editing desk where the
agent's trace remains readable while the generated interface becomes the active
subject.

- Focal element: the live `render_ui` preview on the right.
- Edge anchors: session identity at top-left; elapsed time and event count at
  bottom-right.
- Supporting detail: fixed-height transcript rows, tool status marks, a timeline
  rail, and a single streaming progress rule.
- Background: deep green-tinted neutral with a low-opacity grid and one bounded
  lime bloom behind the preview surface.
- Typography: Montserrat 700/900 for product labels and titles; JetBrains Mono
  400/700 for tool names, code, values, and timestamps.
- Motion rules: dynamic-content-sequencing for event timing,
  discrete-text-sequence for streamed code, spring-pop-entrance for UI groups,
  and ambient-glow-bloom for the preview focus.
- No narration or music. Silence keeps the review surface functional and avoids
  implying production audio is part of the renderer contract.
