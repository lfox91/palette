# palette

**Sun-aware [Ptyxis](https://gitlab.gnome.org/chergert/ptyxis) palette generator & scheduler.**

`palette` generates perceptually-tuned terminal color schemes from a short mood
dialog and cycles them across the day by your **position relative to the sun** —
because mood tracks daylight more than the wall clock. Mornings come up bright,
evenings warm and dim toward sunset, and the whole thing follows sunrise/sunset
as they drift through the year.

- **Fast & offline.** Generation is deterministic code (no model on the hot
  path). No network unless you opt into remote review.
- **Safe & beautiful.** Every palette passes a validation gate — WCAG contrast
  *and* perceptual spacing/coherence in OKLCH — before it can be written.
- **One clean palette.** It manages a single Ptyxis palette (`Sundial`) and
  rewrites its colors per period, instead of littering your picker.
- **Light/dark just works.** Palettes are dual-scheme and follow your desktop's
  light/dark preference via the freedesktop portal.

## Install

**npm (recommended):**

```bash
npm i -g @leafox/palette
palette install
```

This pulls an optional `node-llama-cpp` for offline review if your platform
supports it; otherwise `none`/`remote` review still work.

**Standalone binary (zero toolchain):** grab the baseline Linux binary from the
[latest release](../../releases), put it on your `PATH`, and run `palette install`.

## Quickstart

```bash
palette install          # register the managed palette + systemd user timers
palette create           # guided: mood → generated palette → assign to a period
palette schedule show    # see today's trigger times
palette                  # apply a palette right now (choose scope)
```

## How it works

**Periods are sun-relative.** Five built-ins ship with sensible defaults; each
trigger is either a clock time or a solar anchor with an offset:

| Period    | Default              |
|-----------|----------------------|
| morning   | 06:00                |
| lunch     | 12:00                |
| afternoon | ~1h after solar noon |
| evening   | ~1h48m before sunset |
| owl       | 02:00                |

Add your own: `palette period add gym "1h before sunrise"`. Triggers understand
`"7am"`, `"13:30"`, `"sunset"`, `"30m before sunset"`, `"1h after sunrise"`.
Built-ins can be disabled (`palette period disable owl`) but not deleted.

**Generation is code; the model only reviews.** A constraint-based engine places
all 16 ANSI slots (plus fg/bg/cursor) deliberately in OKLCH space and randomizes
only within tight per-slot bands, then a shared validator gates the result. An
optional reviewer (`none` / `local` GGUF / `remote` API key) may *suggest* slot
tweaks, shown as a diff you accept or reject — and every accepted tweak is
re-validated. The model can nudge; it can never originate a color or bypass the
gate.

**Scheduling** uses systemd **user** timers, one per enabled period, regenerated
idempotently as the sun drifts (`palette regen`, driven by a 6-hourly scheduler
timer). Location comes from GNOME Night Light → GeoClue → a timezone fallback.

## Commands

```
palette                       apply a palette now (choose + scope)
palette create                generate + review + assign to a period
palette apply <version>       apply a stored version now
palette list                  period→version map + saved versions
palette schedule show         today's trigger times
palette schedule <p> <v>      assign version v to period p
palette period add|rm|disable|enable <name> [trigger]
palette configure             review mode, defaults, remote key
palette model scan|list|pull|use   manage GGUFs for local review
palette regen                 refresh period timers
palette install | uninstall   set up / remove systemd units
```

## Configuration

State lives in `~/.config/palette/` (`config.json`, `schedule.json`,
`last_regen`, `models/`). `palette configure` edits it interactively.

Local review never bundles a model: `palette model scan` reuses a GGUF already
on your machine (llama.cpp / Ollama / LM Studio), or `palette model pull <id>`
fetches a small, permissively-licensed one with explicit consent.

## Development

```bash
bun install
bun run dev -- list        # run the CLI from source
bun test                   # unit tests
bun run check              # biome lint + format
bun run typecheck          # tsc --noEmit
bun run build:binary       # compiled baseline binary → dist/palette
```

## License

MIT
