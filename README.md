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

## What it does to your system

`palette` is not a passive linter; it writes to your machine. Concretely:

- **Writes one Ptyxis palette file** (`Sundial.palette`) into your Ptyxis
  palettes directory (native or Flatpak) and selects it for your default
  profile. It does not touch your other palettes, your shell, or your editor.
- **Installs systemd *user* units** — one timer per enabled period plus a
  6-hourly scheduler — and enables the scheduler. `palette setup` installs and
  removes them; nothing is installed without a confirmation prompt.
- **Reads your approximate location** to compute solar times, via GNOME Night
  Light coordinates → GeoClue → a timezone-based fallback city. It is used
  locally and is not transmitted by default.
- **Writes config** under `~/.config/palette/` (`config.json`, `schedule.json`,
  `last_regen`, `models/`).

To remove everything: `palette setup` → *uninstall*.

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
screen owns it. An unreadable config file is moved aside as
`*.corrupt-<timestamp>` rather than silently reset.

Local review never bundles a model: `palette config` will scan for a GGUF you
already have (llama.cpp / Ollama / LM Studio) or fetch a small, permissively
licensed one with explicit consent.

## Privacy

- **Offline by default.** Generation and validation are local code. There is no
  telemetry, no account, and no phone-home.
- **Location stays on your machine.** Solar timing needs latitude/longitude;
  those are read locally and used only to compute sunrise/sunset times.
- **Remote review is opt-in and sends only the palette.** If you configure a
  `remote` reviewer and supply an API key, the generated palette, the mood you
  chose, and the review instructions are sent to that provider's API. No file
  paths, hostnames, or coordinates are included. The default is `none`; use
  `local` to keep everything on-device.
- **API keys are read from the environment**, never written to config. Config
  stores only the *name* of the environment variable to read.
- **Model downloads are explicit.** Pulling a suggested model fetches a GGUF
  from Hugging Face; check its source and license before use.

## Risks & things to know

- **Pre-1.0.** The interface, config schema, and the plugin/benchmark model may
  change between releases.
- **Community plugins are code you chose to run.** Official plugins run
  in-process; community plugins are pinned by version and content hash and run
  out-of-process. Out-of-process is isolation from the CLI's memory, not a
  sandbox. Only opt in to plugins you trust.
- **Remote review hands your palette to a third party.** See *Privacy*.
- **It changes your Ptyxis palette selection.** It only manages `Sundial`, and
  leaves your other palettes alone, but your default profile's selection will
  change.
- **Solar scheduling depends on location.** The timezone fallback is
  approximate, and polar day/night has no solar anchor, so those periods fall
  back to clock behavior.
- **This gates legibility, not taste.** Contrast and coherence are enforced;
  whether a palette looks good to you is still your call.

Security-relevant details and how to report a vulnerability are in
[`SECURITY.md`](SECURITY.md).

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

Pins and content hashes live in `palette.lock.json`.

### Writing a reviewer plugin

A reviewer is a small program behind a JSON contract. Pick the tier by who you
are:

- **local** — an ES module exporting `default` (or `review`) that takes the
  request and returns a suggestion. Runs in-process.
- **community** — any executable that reads one JSON request on stdin and writes
  one JSON response on stdout. Always out-of-process.

The request is `{ kind: "review", prompt, palette, mood }`. The response is the
same shape every backend returns:

```json
{ "approved": true, "rationale": "reads warm and quiet", "tweaks": [] }
```

A manifest is a JSON file:

```json
{
  "id": "you/reviewer",
  "kind": "reviewer",
  "name": "Your reviewer",
  "version": "1.0.0",
  "tier": "community",
  "command": ["your-binary", "--review"]
}
```

Pin and activate it in `palette config` → **Plugins & trust** → *Pin a plugin*,
then *Use a pinned plugin for review*. A manifest cannot mark itself `official` —
that tier means upstream-authored, so a self-declared official is demoted to
`local`. Responses still pass through the structural validator, so a plugin can
propose tweaks but cannot bypass safety. Out-of-process is isolation, not a
sandbox: a community plugin runs with your user's privileges, so read it first.

## Proof of Thought

Where an idea here has no prior art, the operator's exact prompt is recorded —
verbatim, with the harness, model, date, and commit that produced it — and
hash-pinned so it cannot be silently rewritten. We call this a **proof of
thought**: the citation is not "someone once said this" but "here is the exact
prompt, and here is its hash." The ledger is kept locally rather than published
with the source.

## Benchmarking (experimental)

Because generation is deterministic, the *only* variable in a run is the
reviewer. That makes `palette` a clean harness for comparing models and prompts
on a real, constrained task: hold the candidates fixed, vary the reviewer, and
measure approval rate, tweak magnitude, and **scope conformance** — whether the
reviewer stayed on the task it was given instead of drifting, inventing, or
smuggling in unrelated content. Runs can be named and bookmarked by company or
model.

## Development

```bash
bun install
bun run dev -- help       # run the CLI from source
bun test                   # unit tests
bun run check              # biome lint + format
bun run typecheck          # tsc --noEmit
bun run build:binary       # compiled baseline binary → dist/palette
bun run audit              # dependency vulnerability audit
```

## How this was made

This software was built with **The Framework**, a personal agent-orchestration
and systems-engineering workflow. The framework is construction method, not part
of the product: it is not distributed with `palette` and is deliberately kept
out of the repository (see `.gitignore`).

## License

MIT — see [`LICENSE`](LICENSE).
