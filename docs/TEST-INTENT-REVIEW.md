# Test-intent review

- **Date:** 2026-09-12
- **Reviewed revision:** `05955bdb` (`tfw` — Security and trust hardening)
- **Reviewer:** opencode (`opencode-go/deepseek-v4.1-flash`)

## Purpose

Verify that the test suite asserts the **product intent** — what a terminal user
needs — rather than merely re-asserting the behavior of the code as written. A
test that passes because it encodes the implementation's current semantics can
hide a product defect. This review looks specifically for that failure mode.

## Method

Each product intent is traced to the tests that claim to cover it, then judged on
one question: *could the test still pass if the product were wrong for a user?*
Evidence was measured with a 135-palette sweep (the full 3×3×3 mood grid × 5
periods) plus `validatePalette` on the shipped defaults.

## Product intents (from the README)

- **P1** — Deterministic, offline generation; no model on the hot path.
- **P2** — Every palette passes a validation gate: WCAG contrast **and** OKLCH
  perceptual spacing/coherence.
- **P3** — One managed palette (`Sundial`) rewritten per period.
- **P4** — Dual light/dark schemes.
- **P5** — Sun-relative scheduling via idempotent systemd **user** timers.
- **P6** — A reviewer may suggest tweaks but never originates color or bypasses
  the gate.
- **P7** — Config is never hand-edited; corruption is quarantined, not reset.
- **P8** — Semantic ANSI roles hold, so hues read correctly across nvim / tmux /
  `LS_COLORS`.

## Traceability

| Intent | Tests claiming coverage | Verdict |
|---|---|---|
| P1 deterministic | `generate.test.ts:19-26` | Pass — same seed ⇒ same palette |
| P2 "passes the gate" | `palette.test.ts:75-78`, `config.test.ts:26-29` assert only `.ok` | **Fail (misaligned)** — Finding 1 |
| P2 gate: contrast | `contrast.test.ts:43-79` | Pass — independently recomputes WCAG contrast |
| P2 gate: spacing/coherence | `generate.test.ts:62-70` assert only `.ok` | **Weak** — output is measurably 100% `.clean`; the test would not catch a clean→warn regression |
| P3 one palette | `review-ptyxis.test.ts` render/path assertions | Pass |
| P4 light/dark | `config.test.ts:31-37` | Weak — asserts both have 16 colors, not that they differ *meaningfully* |
| P5 scheduling | `schedule.test.ts:33-62` | Pass |
| P6 reviewer | `palette.test.ts:86-102` | Pass — a contrast-breaking tweak is rejected |
| P7 config integrity | `config-resilience.test.ts` | Pass — corrupt file quarantined |
| P8 semantic roles | `semantic.test.ts:7-21` | **Fail (defends a defect)** — Finding 2 |

## Findings

### Finding 1 — the gate is asserted as "no fatals", not "passes"

The README states every palette passes the gate. The shipped defaults do not:

```
Day (shipped default):     ok=true clean=false  (3 contrast + 6 coherence warnings)
Evening (shipped default): ok=true clean=false  (3 contrast + 8 coherence warnings)
```

The tests assert `validatePalette(...).ok === true` — which is true whenever
there are no **fatal** issues. So the suite is green while the product claim is
false for the default a user sees first. A test can pass while the user gets an
incoherent palette.

### Finding 2 — a test encodes the defect as expected behavior

`semantic.test.ts:7-11` asserts the built-in seed **has** coherence warnings and
that they are non-fatal. This is the definition of a test that tests the code:
it makes "fix the shipped default" and "keep the suite green" mutually
exclusive. Meanwhile the generated path is measurably clean:

```
generated n=135  cleanPct=100.0  fatal=0  coherenceIssues=0  spacingIssues=0
```

Shipped defaults are off-role — `Day` magenta 28° off, `Evening` magenta 34°
off, green/blue/cyan 19–26° off — exactly the semantic collision the project
set out to prevent. The concrete user impact: in nvim / tmux / `LS_COLORS`,
"media" and "keyword" can render close enough to "error" and "red" to misread.

### Finding 3 — a tautological test

`config.test.ts:50-53` is titled "built-in periods cannot be distinguished from
custom by name alone" but asserts only `s.periods.every((p) => p.builtin)` — it
tests the field, not the property its name claims.

### Finding 4 — assertions weaker than the product

`generate.test.ts:62-70` ("tone windows do not break validation") asserts `.ok`
while the measured output is 100% `.clean`. `schedule.test.ts:76-84`
(`resolveBin` "never returns an empty string") checks non-emptiness, but the
intent is that systemd can execute the hook; a non-empty broken path passes.

## Corrections applied in this change

- `config.test.ts` — replaced the tautological test with one that asserts the
  actual property: built-ins are flagged, a custom period is not.
- `generate.test.ts` — the tone-window test now asserts `.clean`, and a new test
  requires the entire mood grid to be `.clean`.
- `semantic.test.ts` — the role-deviation check now sweeps the full mood grid ×
  periods, not a single mood.
- `schedule.test.ts` — `resolveBin` must resolve to an existing executable, not
  merely a non-empty string.

## Open product decision (needs the operator)

Findings 1 and 2 resolve one of two ways, and the choice is a product call:

- **(a) Make the shipped `Day`/`Evening` seeds satisfy the coherence contract**,
  shifting green/blue/magenta/cyan toward their canonical roles so P2 is true as
  written; or
- **(b) Keep the hand-tuned look and reword the README**, so it reads: safety
  (contrast, structure) is enforced; coherence is advisory and surfaced as a
  warning at apply time.

Either is defensible. Leaving the README claiming "passes the gate" while the
shipped default warns is not — the documentation and the behavior must agree.

## Resolution

Option **(a)** was chosen. `dayPalette()` and `eveningPalette()` now snap their
chromatic slots to the canonical ANSI role hues (keeping lightness and chroma,
so the palette's character survives) and pass through the contrast projection.
`Day` and `Evening` validate `.clean`, so P2 is true as written. The test that
previously asserted the defect now asserts the intent: the shipped defaults pass
the full gate, not merely the fatal check.
