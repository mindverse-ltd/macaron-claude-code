# Replay video renderer

This HyperFrames project turns a normalized Macaron session replay into a
deterministic MP4. It renders messages, ordinary tool calls, tool results, and
incremental `render_ui` snapshots on one seekable timeline.

## Render the sample

Requires Node.js 22+, FFmpeg, and Chromium or Chrome.

```bash
npm test
npm run check
npm run render
```

The high-quality render is written to `out/replay-sample.mp4`.

## Render another replay

Create a JSON file matching `replay.schema.json`, then compile it before using
the normal HyperFrames commands:

```bash
node scripts/prepare-replay.mjs path/to/replay.json index.html
npx hyperframes check
npx hyperframes render --quality high --output out/my-replay.mp4
```

The compiler validates event identity and type, allocates event time from content
length, and places each `render_ui.stream[]` frame monotonically inside its tool
window. The generated `index.html` is checked in so the sample can be previewed
without a separate build step.

## Input model

- `user` / `assistant`: a message with `text`.
- `tool`: `name`, `input`, `result`, and optional `status`.
- `render_ui`: source `code` plus at least two ordered `stream` frames.

Each stream frame carries a small visual snapshot descriptor: title, status,
optional stats, bars, and rows. Keeping snapshots declarative makes frame seeking
deterministic and avoids executing arbitrary model-authored TSX during video
rendering.
