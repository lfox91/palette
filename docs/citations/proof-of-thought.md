# Proof of Thought

Citations of record for contributions that have no prior art. Each entry is the
operator's exact prompt, hash-pinned with the harness, model, date, and commit
that produced it. A changed prompt produces a different hash.

### Open palette benchmark: deterministic generator + AI reviewer only, with an explicit trust boundary
- **Harness:** opencode
- **Model:** opencode-go/deepseek-v4.1-flash
- **Date:** 2026-09-12
- **Commit:** `cc98b31d`
- **Prior art:** none found for benchmarking an AI model strictly as a constrained reviewer of procedurally generated palette candidates (searched 2026-09-12; nearest: palettecore, Root Loops — generators/auditors, no AI; MT-Bench/Chatbot Arena — rank model outputs, not critique non-AI artifacts)
- **Realized in:** `docs/rfc/0001-open-palette-benchmarking.md`
- **Prompt (verbatim; sha256 `62542f029fb2` for the full entry):**

> this opens up a new opportunity for plugins and adpaters as well. we can start with the ones that matter to me but people can use their on. I think this can be used as a public modeling benchmarking tool. I'll lock on versions and mark certain versions offical and obviously using the latest open source and available security tooling by default. but I never plan to use the versions other people make by default and that should be stated plainly with reasoning in the read me as well.

### Scope conformance as a benchmark eval: nothing off-goal, and named model/company bookmarks
- **Harness:** opencode
- **Model:** opencode-go/deepseek-v4.1-flash
- **Date:** 2026-09-12
- **Commit:** `cc98b31d`
- **Prior art:** none found for a scope-conformance metric that measures whether a reviewer's output stays on the committed goal (searched 2026-09-12); adjacent: Eval Factsheets / BenchmarkCards document methodology but do not evaluate on-goal adherence of agent output
- **Realized in:** `src/bench.ts`
- **Prompt (verbatim; sha256 `bda689e01e6f` for the full entry):**

> yes, another selling point for me is I can show off my prompt engineering with far less risk of accidentally uploading anything harmful. that can even be an eval, there should be nothing in the code or created by an agent that is about anything other than the goal as committed.oh yeah people can show off their models by making named bookmarks for their company or model

### One palette contract across TUIs, nvim, terminals, tmux, harnesses, and languages; surface conflicts instead of overwriting
- **Harness:** opencode
- **Model:** opencode-go/deepseek-v4.1-flash
- **Date:** 2026-09-12
- **Commit:** `cc98b31d`
- **Prior art:** ANSI/LS_COLORS slot conventions and Solarized are prior art for roles; the framing of conflict-surfacing (report drift, offer rename over overwrite) across this specific consumer set was not found (searched 2026-09-12)
- **Realized in:** `src/ansi.ts`
- **Prompt (verbatim; sha256 `49da018e6368` for the full entry):**

> it's important this works for tuis, nvim, gnome terminals ex. ptyxis, tmux, code harnesses, and languages. so the agent also needs to say when things are conflicting this might trigger the user to rename instead of overwrite

### Proof of Thought: cite the operator's exact prompts where no prior art exists
- **Harness:** opencode
- **Model:** opencode-go/deepseek-v4.1-flash
- **Date:** 2026-09-12
- **Commit:** `cc98b31d`
- **Prior art:** none found for a hash-pinned, harness/model/date/commit-attributed citation of an operator's exact prompts as evidence of original reasoning (searched 2026-09-12)
- **Realized in:** `src/proof.ts`
- **Prompt (verbatim; sha256 `d76c7d7db9a0` for the full entry):**

> I want you to try something new too, for anything you can't find prior art on I want you to add my exact prompts with harness, model, date, and commit hash to the citation section. I'm saying this is proof of thought
