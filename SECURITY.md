# Security policy

`palette` is pre-1.0. Only the latest release is supported with security fixes.

## Reporting a vulnerability

Please report privately through GitHub's
[private vulnerability reporting](../../security/advisories/new)
(**Security → Advisories → Report a vulnerability**). Do not open a public issue
for an unfixed vulnerability.

Include the affected version or commit, a description, reproduction steps, and
the impact you believe it has. We aim to acknowledge within a few days and will
credit you unless you prefer otherwise.

## Scope

**In scope**

- The CLI, generator, validator, scheduler, and Ptyxis integration under `src/`.
- Plugin verification (`palette.lock.json`) and the plugin execution boundary.
- The release pipeline (`.github/workflows/`) and the published npm artifact.

**Out of scope**

- Vulnerabilities in `node-llama-cpp` or in model files you supply — report those
  upstream to their authors.
- Third-party / community plugins you chose to enable.
- Aesthetic quality of a generated palette. That is a design issue, not a
  security one.

## What the software touches

See [Privacy and Risks](README.md) in the README. In short: it writes a Ptyxis
palette, installs systemd **user** units, reads local coordinates to compute
solar times, and — only if you explicitly opt in — sends a palette to a remote
review API.

## Hardening by default

- Remote API keys are read from environment variables, never stored on disk.
- Community plugins are pinned by version and content hash and run
  out-of-process.
- Dependency and secret scans run in CI: `bun audit` for dependencies, and
  [gitleaks](https://github.com/gitleaks/gitleaks) (official action) over the full
  git history for leaked keys and high-entropy secrets.
