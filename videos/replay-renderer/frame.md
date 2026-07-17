---
background: "#FAF9F5"
surface: "#FFFFFF"
surface_2: "#F5F4ED"
surface_3: "#EFEDE3"
border: "#E8E6DC"
border_strong: "#D9D5C7"
foreground: "#3D3929"
foreground_2: "#5D584A"
muted: "#8A8473"
accent: "#C96442"
good: "#5A8B5A"
warn: "#B88A3A"
bad: "#C0524A"
font_display: "Tiempos Text"
font_body: "Sohne"
font_mono: "Sohne Mono"
corner_radius: 8
---

# Macaron Session Replay

This composition uses the existing Macaron web design system verbatim. The
normative source is `web/src/styles.css`: warm paper background, white and
warm-gray surfaces, orange accent, 1px warm-gray borders, and the existing
Sohne/Tiempos/Sohne Mono stacks.

- Preserve the 260px Macaron sidebar, pill session bar, 14px thread surface,
  inline TUI tool rows, and `render_ui` header treatment.
- The GenUI preview is one persistent DOM tree. Streaming stages update text,
  values, and bar transforms in place; newly available nodes enter individually.
- Never crossfade, replace, or hide the whole preview between stream stages.
- Use only existing Macaron semantic colors and radii. Do not add a separate
  replay palette, decorative grid, glow, or heavy video-only border system.
- No narration or music. The result remains a functional review surface.
