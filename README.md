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
palette setup
```

This pulls an optional `node-llama-cpp` for offline review if your platform
supports it; otherwise `none`/`remote` review still work.

**Standalone binary (zero toolchain):** grab the baseline Linux binary from the
[latest release](../../releases), put it on your `PATH`, and run `palette setup`.

## Quickstart

```bash
palette          # home: switch palettes, create, configure, set up services
palette setup    # install the managed palette + systemd user timers
palette config   # periods, defaults, and local review models
```

Run `palette` again any time. A first run is detected by the absence of a saved
schedule, and it offers to set up the services for you.

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

Add your own from `palette config` → *Periods & schedule*. Triggers understand
`"7am"`, `"13:30"`, `"sunset"`, `"30m before sunset"`, `"1h after sunrise"`.
Built-ins can be disabled but not deleted.

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

Three human commands, one interactive surface:

```
palette          open the home screen: switch now, create a palette, configure,
                 or run setup. First run offers to install the services.
palette setup    install / uninstall / status of the systemd + Ptyxis wiring
palette config   periods & schedule, defaults & review, local GGUF models
```

Two hidden machine hooks (invoked by systemd, never by hand):

```
palette apply-period <name>   apply the palette assigned to a period
palette regen                 refresh the period timers as the sun drifts
```

## Configuration

State lives in `~/.config/palette/` (`config.json`, `schedule.json`,
`last_regen`, `models/`) so the non-interactive systemd path has a stable,
machine-readable substrate. You never hand-edit it — the `palette config`
screen owns it.

Local review never bundles a model: `palette config` will scan for a GGUF you
already have (llama.cpp / Ollama / LM Studio) or fetch a small, permissively
licensed one with explicit consent.

## Trust & provenance

`palette` is upstream-authored software. The maintainer designs, generates, and
validates every palette enabled by default, and **does not enable palettes,
models, or plugins authored by anyone else by default**. Not to be unwelcoming —
a terminal palette is a surface you read all day, and defaulting to third-party
output would import a supply chain into your eyes. It is the same reasoning as
any dependency: you are opting into someone else's judgement.

Anyone may publish and use their own period packs, derivers, reviewers, and
sinks. They are simply opt-in, and the project distinguishes:

- **Official** — authored by this project, or explicitly admitted by the
  maintainer. Shipped and enabled by default.
- **Community** — everyone else. Never enabled by default; loaded only when you
  explicitly opt in, and run out-of-process.

Pins and content hashes live in `palette.lock.json`. The full model is in
[RFC 0001](docs/rfc/0001-open-palette-benchmarking.md).

## Proof of Thought

Where an idea here has no prior art, the operator's exact prompt is recorded —
verbatim, with the harness, model, date, and commit that produced it — and
hash-pinned so it cannot be silently rewritten. We call this a **proof of
thought**: the citation is not "someone once said this" but "here is the exact
prompt, and here is its hash." Source of truth:
[`docs/citations/proof-of-thought.json`](docs/citations/proof-of-thought.json);
rendered: [`docs/citations/proof-of-thought.md`](docs/citations/proof-of-thought.md).

## Benchmarking (experimental)

Because generation is deterministic, the *only* variable in a run is the
reviewer. That makes `palette` a clean harness for comparing models and prompts
on a real, constrained task: hold the candidates fixed, vary the reviewer, and
measure approval rate, tweak magnitude, and **scope conformance** — whether the
reviewer stayed on the task it was given instead of drifting, inventing, or
smuggling in unrelated content. Runs can be named and bookmarked by company or
model. See [RFC 0001](docs/rfc/0001-open-palette-benchmarking.md).

## Development

```bash
bun install
bun run dev -- help       # run the CLI from source
bun test                   # unit tests
bun run check              # biome lint + format
bun run typecheck          # tsc --noEmit
bun run build:binary       # compiled baseline binary → dist/palette
```

## License

MIT
