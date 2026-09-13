# RFC 0001 — Open palette benchmarking

- **Status:** Draft / open for discussion
- **Date:** 2026-09-12
- **Author:** [@lfox91](https://github.com/lfox91)
- **Base commit:** `2a2e2396`
- **Discussion:** open an issue titled `RFC 0001` or a PR against this file.

> This is a starting point, not a governing document. If someone has already
> begun this idea elsewhere, this RFC is intended to be a node in that chain —
> cite it, fork it, or supersede it.

## 1. Motivation

Terminal color schemes are a trust surface. You read them all day, across every
TUI, editor, shell, and multiplexer you use. Today the ecosystem ships these as
static artifacts: someone's taste, frozen, unversioned, and unauditable. And the
generation of new ones is either hand-tuning or an opaque model call.

`palette` makes a different bet: **generation is deterministic code, and a model
may only *review* it.** The generator places all 16 ANSI slots with intent; a
validator gates every result; an optional reviewer may suggest per-slot tweaks
which are re-validated and shown as a diff. The model can nudge. It can never
originate a color, and it can never bypass the gate.

That design has a second-order consequence, which this RFC is about: because the
candidates are deterministic, **the only variable in a run is the reviewer.** Keep
the candidate palettes fixed, vary the model and the prompt, and you have a clean
benchmark.

## 2. Goals

1. **Open, reproducible benchmarking** of models and prompts on a constrained,
   real task.
2. **No chicanery.** Data sources and methodology are open and understandable;
   a run records exactly what was asked, of which model, over which candidates.
3. **Scope conformance as a first-class metric.** It must be possible to say a
   reviewer stayed on the task it was given — and to catch it when it didn't.
4. **Provenance for original ideas.** Where no prior art exists, cite the exact
   prompt that produced the contribution (see §7).
5. **A strict trust boundary.** Official content is upstream-authored; community
   content is opt-in and isolated, never enabled by default.

## 3. Non-goals

- Ranking models in general. This measures one task; treat it as one node, not a
  leaderboard to game.
- Judging human aesthetic preference. No study yet connects AI review to human
  preference for terminal palettes (see §5).
- Replacing the generator with a model. The model is a reviewer, permanently.

## 4. The idea chain (prior art)

We stand on a documented lineage. In rough order:

1. **Datasheets for Datasets** — Gebru et al., 2018/2021, arXiv:1803.09010.
   Documentation as a first-class artifact.
2. **Model Cards for Model Reporting** — Mitchell et al., 2019,
   arXiv:1810.03993; FAT*'19, DOI 10.1145/3287560.3287596.
3. **ML Reproducibility Checklist** — Raff 2019; Pineau et al., 2021,
   arXiv:2003.12206.
4. **Goodhart's Law** — Manheim & Garrabrant, 2018, arXiv:1803.04585; and
   **The Benchmark Lottery** — Dehghani et al., 2021, arXiv:2107.07002. Metrics
   distort the thing they measure; name it up front.
5. **HELM** — Liang et al., 2022, arXiv:2211.09110; **lm-evaluation-harness** —
   Gao et al., 2021, DOI 10.5281/zenodo.5371628. Standardized, reproducible evals.
6. **MT-Bench / LLM-as-judge** — Zheng et al., 2023, arXiv:2306.05685;
   **Chatbot Arena** — Chiang et al., 2024, arXiv:2403.04132. Models judging
   model output; known biases must be documented.
7. **The Leaderboard Illusion** — Singh et al., 2025, arXiv:2504.20879. Why open
   data and honest methodology matter more than rank.
8. **BenchmarkCards** — Sokol et al., 2024/2025, arXiv:2410.12974;
   **Eval Factsheets** — Bordes et al., 2025, arXiv:2512.04062;
   **Model Openness Framework** — White et al., 2024, arXiv:2403.13784.
   Metadata, methodology statements, and openness grading.

Supporting foundations: Sigstore (DOI 10.1145/3548606.3560596), SLSA
(slsa.dev/spec/v1.1), in-toto, DSSE, `npm publish --provenance`, GitHub artifact
attestations; Croissant (arXiv:2403.19546) for dataset metadata + per-file
checksums; MLPerf rules. Palette-specific prior art: Base16, Solarized, pywal,
Root Loops, `palettecore`; color-science grounding in OKLab (Ottosson), Okhsl,
CSS Color 4, WCAG 2.2, APCA, CIEDE2000 (Sharma et al., 2005), Crameri 2020,
ColorBrewer, and CVD models (Brettel 1997; Machado 2009).

### Verification note

This chain was assembled in a first research pass on 2026-09-12. Two citation IDs
were flagged unverified (Dataset Nutrition Label, arXiv:1805.03677; FactSheets,
arXiv:1809.02534) and should be spot-checked before formal publication. Treat
every identifier here as a claim to verify, not a settled fact.

## 5. What is, and isn't, novel

Stated carefully, because overclaiming novelty is the failure mode.

- **Well-supported (not novel):** provenance/documentation discipline (Eval
  Factsheets, BenchmarkCards, Model Openness Framework); deterministic generation
  removing irreproducibility; AI-as-reviewer with documented biases; open data as
  an anti-gaming measure (Leaderboard Illusion).
- **Plausibly novel (thin evidence):** benchmarking a model strictly as a
  constrained *reviewer* of procedurally generated palette candidates; benchmark
  isolation by construction (only the reviewer varies); signed, versioned result
  sets for a design/perception task.
- **Speculative (label as such):** that AI review correlates with human palette
  preference; that reviewer-only performance transfers to developer productivity;
  that any specific ΔE/APCA threshold is "correct."

## 6. Design

### 6.1 Trust tiers

| Tier | Authored by | Loading | Enabled by default |
|---|---|---|---|
| **official** | this project, or explicitly admitted by the maintainer | in-process | yes |
| **local** | you, on your machine | in-process | only by you |
| **community** | anyone else | **out-of-process** | **never** |

A `palette.lock.json` pins id, version, tier, and a content hash. Verification
rejects unpinned plugins, hash mismatches, tier changes, and any community plugin
that lacks a subprocess command. Official content is limited to what the
maintainer has personally authored or allowed in their own revision graph; the
maintainer does not run anyone else's revisions by default. This is stated
plainly in the README with reasoning, not buried.

Plugin kinds: **reviewer** (critiques a candidate), **sink** (where a result
goes), **deriver** (produces candidate ranges). All are reachable from the
`palette` TUI — no new verbs.

### 6.2 Deterministic case set

`buildCases(size)` lays out a deterministic ladder (period-major). Each case fixes
a mood and period. Candidate seed is derived from `runSeed:caseId`, so the same
run seed always produces the same candidates. A run records `goalHash`,
`promptHash`, model, and timestamps.

### 6.3 Metrics

- **approvalRate** — fraction of candidates the reviewer approved unchanged.
- **tweak magnitude** — mean per-tweak ΔE (OKLab) for accepted tweaks.
- **cleanRate / okRate** — post-tweak validation of what would actually ship.
- **scopeViolations** — count of rationales that left the committed goal.

### 6.4 Scope conformance

The task has one goal, and the reviewer must stay inside it. `scopeCheck()`
flags URLs, emails, code fences, injection phrases, and long rationales with no
on-goal vocabulary. It is a heuristic, explicitly, and its thresholds are
versioned. The metric exists because "the model behaved and only did the task" is
otherwise an invisible property — and a benchmark that cannot see scope drift
cannot be trusted with a default-on surface.

### 6.5 Bookmarks

A run may be named and tagged with a company or model (e.g. `Acme / acme-1`),
so organizations can show off their models with an auditable artifact rather than
a screenshot.

## 7. Proof of Thought

Where a contribution has no prior art, we do not cite a paper: we cite **the
operator's exact prompt**, verbatim, together with the harness, model, date, and
commit that produced it, hash-pinned so the text cannot be silently altered. The
citation is not "someone once said this"; it is "here is the exact prompt, and
here is its hash."

- Ledger (source of truth): [`../citations/proof-of-thought.json`](../citations/proof-of-thought.json)
- Rendered: [`../citations/proof-of-thought.md`](../citations/proof-of-thought.md)
- Mechanism: `src/proof.ts` (`proofHash`, `renderProof`, `renderLedger`),
  rendered by `bun run proofs`.

Entries recorded for this RFC:

1. *Open palette benchmark: deterministic generator + AI reviewer only, with an
   explicit trust boundary.*
2. *Scope conformance as a benchmark eval, and named model/company bookmarks.*
3. *One palette contract across TUIs, nvim, terminals, tmux, harnesses, and
   languages; surface conflicts instead of overwriting.*
4. *Proof of Thought: cite the operator's exact prompts where no prior art exists.*

## 8. Open questions

- Are the metrics the right ones, and are the thresholds defensible?
- How should `scopeCheck` be versioned and validated against human labels?
- What is the right signing story for result sets (Sigstore vs SLSA provenance)?
- Who else is working on this? If you are, this RFC wants to cite you — open an
  issue.

## 9. References

See §4. Every identifier is a claim to verify.
