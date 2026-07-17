---
workflow: general-video
flow: automation
storyboard: no
message: "Replay an agent session as a reviewable video without losing tool progress or streaming UI states"
destination: developer-review
aspect: 1920x1080
language: en
audience: Macaron engineers and product reviewers
length: 24s
---

## Intent

Create a deterministic replay renderer for Macaron sessions. The video should make
the agent's working rhythm legible at a glance: user intent, assistant reasoning,
tool execution, tool results, and live GenUI output all remain visually distinct.

## Assets

- ../../assets/mindlab-symbol.svg - existing Macaron brand mark for the replay shell.

## Customizations

- The fixture includes multiple ordinary tool calls and two `render_ui` calls.
- Each `render_ui` result visibly streams through several intermediate UI states.
- The composition reads replay data from a checked-in JSON fixture so other sessions
  can be rendered by replacing the input without redesigning the timeline.

## Notes

- Use a quiet, work-focused desktop UI rather than a marketing-video layout.
- Deliberate silence: no narration, music, captions, or generated media in this pass.
- Keep the composition seek-safe and fully deterministic for CI rendering.
