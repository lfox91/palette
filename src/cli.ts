#!/usr/bin/env node
/**
 * palette — sun-aware Ptyxis palette generator & scheduler.
 *
 * Three human commands, one interactive surface:
 *   palette          home — the daily driver (switch, create, configure, setup)
 *   palette setup    install / uninstall / status of the systemd + Ptyxis wiring
 *   palette config   form-based configuration (periods, defaults, models)
 *
 * Two hidden machine hooks (invoked by systemd, never by hand):
 *   palette apply-period <name>
 *   palette regen
 *
 * Config lives at ~/.config/palette/ and is owned by the prompts; users never
 * hand-edit it. First run is detected by the absence of schedule.json on disk.
 */

import { existsSync, readFileSync } from 'node:fs';
import * as p from '@clack/prompts';
import { ANSI_HUE, ANSI_HUE_MAX_DEVIATION, ANSI_ROLES } from './ansi.js';
import {
  type BenchRun,
  compareRuns,
  listRuns,
  loadRun,
  runBench,
  SIZES,
  saveRun,
} from './bench.js';
import { contrastHex, hexToOklch, hexToRgb, hueDistance } from './color.js';
import {
  ensureInitialized,
  loadConfig,
  loadSchedule,
  nextFreeName,
  paths,
  readLastRegen,
  saveConfig,
  saveSchedule,
} from './config.js';
import { generatePalette } from './generate.js';
import {
  humanSize,
  pullModel,
  SUGGESTED_MODELS,
  scanModels,
  suggestedById,
  useModel,
} from './models.js';
import { describeTrigger, parseTrigger, resolveTrigger } from './periods.js';
import { installPlugin, loadLock, lockPath, removePlugin, TIER_NOTE } from './plugins.js';
import { applyVersion, detectInstall, installManaged, resolveEnv } from './ptyxis.js';
import { applyTweaks, getReviewer, type ReviewBackend } from './review/index.js';
import { installUnits, regen, uninstallUnits } from './schedule.js';
import type { Coordinates } from './solar.js';
import { resolveCoordinates } from './solar.js';
import type {
  Contrast,
  Energy,
  MoodInput,
  PaletteSuggestion,
  PaletteVersion,
  RawPalette,
  ReviewMode,
  ScheduleConfig,
  Scheme,
  Warmth,
} from './types.js';
import { formatIssues, validatePalette } from './validate.js';

// --- terminal preview -------------------------------------------------------

function block(hex: string): string {
  const { r, g, b } = hexToRgb(hex);
  const R = Math.round(r * 255);
  const G = Math.round(g * 255);
  const B = Math.round(b * 255);
  return `\x1b[48;2;${R};${G};${B}m  \x1b[0m`;
}

function previewScheme(label: string, s: Scheme): string {
  const row = s.colors.map(block).join('');
  return `${label.padEnd(6)} ${block(s.background)}${block(s.foreground)} │ ${row}`;
}

function previewPalette(pal: RawPalette): string {
  return `${previewScheme('light', pal.light)}\n${previewScheme('dark', pal.dark)}`;
}

// --- small helpers ----------------------------------------------------------

function cancelled(v: unknown): boolean {
  if (p.isCancel(v)) {
    p.cancel('Cancelled.');
    return true;
  }
  return false;
}

function currentPeriod(
  schedule: ScheduleConfig,
  coords: Coordinates,
  now = new Date()
): string | null {
  const enabled = schedule.periods.filter((x) => x.enabled);
  let best: { name: string; t: number } | null = null;
  let latest: { name: string; t: number } | null = null;
  for (const per of enabled) {
    const dt = resolveTrigger(per.trigger, now, coords);
    if (!dt) continue;
    const t = dt.getTime();
    if (!latest || t > latest.t) latest = { name: per.name, t };
    if (t <= now.getTime() && (!best || t > best.t)) best = { name: per.name, t };
  }
  return (best ?? latest)?.name ?? null;
}

// --- generation + review ----------------------------------------------------

async function generateReviewed(input: MoodInput, period: string): Promise<RawPalette | null> {
  const cfg = loadConfig();
  const s = p.spinner();
  s.start('Generating palette');
  const { palette, validation } = await generatePalette(input, { period });
  s.stop('Generated');
  if (!validation.ok) {
    p.log.error(`Could not produce a valid palette:\n${formatIssues(validation)}`);
    return null;
  }
  if (!validation.clean) p.log.warn(`Validation notes:\n${formatIssues(validation)}`);
  p.log.message(previewPalette(palette));

  if (cfg.defaults.reviewMode === 'none') return palette;

  const rs = p.spinner();
  rs.start(`Reviewing with ${cfg.defaults.reviewMode} backend`);
  let suggestion: PaletteSuggestion;
  try {
    const reviewer = await getReviewer(cfg);
    suggestion = await reviewer.review(palette, input);
    rs.stop('Review complete');
  } catch (err) {
    rs.stop('Review unavailable');
    p.log.warn(`Review skipped: ${(err as Error).message}`);
    return palette;
  }

  if (suggestion.approved || suggestion.tweaks.length === 0) {
    p.log.success(`Reviewer approved: ${suggestion.rationale}`);
    return palette;
  }

  p.log.info(`Reviewer suggests ${suggestion.tweaks.length} tweak(s): ${suggestion.rationale}`);
  const accepted: typeof suggestion.tweaks = [];
  for (const tweak of suggestion.tweaks) {
    const ok = await p.confirm({
      message: `${tweak.scheme}/${tweak.slot} → ${tweak.hex}  (${tweak.reason})`,
    });
    if (cancelled(ok)) return null;
    if (ok) accepted.push(tweak);
  }
  if (accepted.length === 0) return palette;

  const result = applyTweaks(palette, accepted);
  if (result.rejected.length > 0) {
    p.log.warn(`${result.rejected.length} tweak(s) rejected — they would break validation.`);
  }
  p.log.message(previewPalette(result.palette));
  return result.palette;
}

// --- side effects -----------------------------------------------------------

function applyToPtyxis(version: PaletteVersion): void {
  const check = validatePalette(version.palette);
  if (!check.ok)
    fail(`refusing to apply "${version.name}" — it fails validation:\n${formatIssues(check)}`);
  if (!check.clean) p.log.warn(`"${version.name}" has validation notes:\n${formatIssues(check)}`);
  const env = resolveEnv();
  applyVersion(env, version);
}

function regenQuietly(schedule: ScheduleConfig): void {
  try {
    regen(schedule, { force: true });
  } catch {
    /* scheduling is best-effort here; `palette regen` surfaces errors */
  }
}

function fail(msg: string): never {
  console.error(`palette: ${msg}`);
  process.exit(1);
}

function requireInteractive(command: string): void {
  if (!process.stdin.isTTY) {
    fail(
      `"${command}" is interactive and needs a terminal.\n` +
        '  Use the machine hooks instead: `palette apply-period <name>` / `palette regen`.'
    );
  }
}

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

// --- flows ------------------------------------------------------------------

async function newPaletteFlow(): Promise<void> {
  const cfg = loadConfig();
  const schedule = loadSchedule();
  const d = cfg.defaults.mood;

  const enabledPeriods = schedule.periods.filter((per) => per.enabled);
  if (enabledPeriods.length === 0) {
    p.log.warn('No enabled periods — add or enable one under Configure first.');
    return;
  }

  const energy = (await p.select({
    message: 'Energy',
    initialValue: d.energy ?? 'med',
    options: [
      { value: 'low', label: 'low' },
      { value: 'med', label: 'medium' },
      { value: 'high', label: 'high' },
    ],
  })) as Energy;
  if (cancelled(energy)) return;
  const warmth = (await p.select({
    message: 'Warmth',
    initialValue: d.warmth ?? 'neutral',
    options: [
      { value: 'cool', label: 'cool' },
      { value: 'neutral', label: 'neutral' },
      { value: 'warm', label: 'warm' },
    ],
  })) as Warmth;
  if (cancelled(warmth)) return;
  const contrast = (await p.select({
    message: 'Contrast',
    initialValue: d.contrast ?? 'balanced',
    options: [
      { value: 'soft', label: 'soft' },
      { value: 'balanced', label: 'balanced' },
      { value: 'vivid', label: 'vivid' },
    ],
  })) as Contrast;
  if (cancelled(contrast)) return;
  const note = await p.text({ message: 'Note (optional — e.g. "ocean at dusk")', placeholder: '' });
  if (cancelled(note)) return;

  const period = (await p.select({
    message: 'Assign to which period?',
    options: enabledPeriods.map((per) => ({
      value: per.name,
      label: per.name,
      hint: describeTrigger(per.trigger),
    })),
  })) as string;
  if (cancelled(period)) return;

  const input: MoodInput = { energy, warmth, contrast, note: (note as string) || undefined };
  const palette = await generateReviewed(input, period);
  if (!palette) return;

  const typed = (await p.text({
    message: 'Version name',
    placeholder: `${period}-${energy}`,
    defaultValue: `${period}-${energy}`,
  })) as string;
  if (cancelled(typed)) return;
  let name = typed || `${period}-${energy}`;

  if (schedule.versions[name]) {
    const owners = Object.entries(schedule.assignments)
      .filter(([, v]) => v === name)
      .map(([owner]) => owner);
    p.log.warn(
      `A palette named "${name}" already exists${owners.length ? ` (in use by: ${owners.join(', ')})` : ''}.`
    );
    const how = (await p.select({
      message: `"${name}" conflicts — rename or overwrite?`,
      options: [
        { value: 'rename', label: 'Rename the new palette' },
        { value: 'overwrite', label: 'Overwrite the existing palette' },
        { value: 'cancel', label: 'Cancel' },
      ],
    })) as string;
    if (cancelled(how) || how === 'cancel') return;
    if (how === 'rename') {
      const suggested = nextFreeName(name, (n) => Boolean(schedule.versions[n]));
      const again = (await p.text({
        message: 'New palette name',
        defaultValue: suggested,
      })) as string;
      if (cancelled(again)) return;
      name = again && !schedule.versions[again] ? again : suggested;
    }
  }

  const version: PaletteVersion = {
    name,
    input,
    tone: period,
    palette,
    createdAt: new Date().toISOString(),
  };
  schedule.versions[name] = version;
  schedule.assignments[period] = name;
  saveSchedule(schedule);

  const apply = await p.confirm({ message: `Apply "${name}" now?` });
  if (!cancelled(apply) && apply) applyToPtyxis(version);
  regenQuietly(schedule);
  p.log.success(`Saved "${name}" and assigned it to ${period}.`);
}

async function switchNowFlow(): Promise<void> {
  const cfg = loadConfig();
  const schedule = loadSchedule();

  const choice = (await p.select({
    message: 'Apply which palette?',
    options: [
      ...Object.keys(schedule.versions).map((v) => ({ value: v, label: v })),
      { value: '__new__', label: 'generate a new one…' },
    ],
  })) as string;
  if (cancelled(choice)) return;

  let version: PaletteVersion;
  if (choice === '__new__') {
    const coords = resolveCoordinates();
    const period = coords ? (currentPeriod(schedule, coords) ?? 'afternoon') : 'afternoon';
    const palette = await generateReviewed(
      { energy: 'med', warmth: 'neutral', contrast: 'balanced' },
      period
    );
    if (!palette) return;
    version = {
      name: 'scratch',
      input: { energy: 'med', warmth: 'neutral', contrast: 'balanced' },
      palette,
    };
  } else {
    const found = schedule.versions[choice];
    if (!found) {
      p.log.error(`no such version "${choice}".`);
      return;
    }
    version = found;
  }

  const scope = (await p.select({
    message: 'For how long?',
    initialValue: cfg.defaults.applyScope,
    options: [
      { value: 'until-next-change', label: 'until the next scheduled change', hint: 'temporary' },
      { value: 'all-times', label: 'all times', hint: 'persist for the current period' },
    ],
  })) as 'all-times' | 'until-next-change';
  if (cancelled(scope)) return;

  if (schedule.override && scope === 'until-next-change') {
    const ow = await p.confirm({ message: 'A temporary override is active — overwrite it?' });
    if (cancelled(ow) || !ow) return;
  }

  applyToPtyxis(version);

  if (scope === 'all-times') {
    const coords = resolveCoordinates();
    const cur = coords ? currentPeriod(schedule, coords) : null;
    if (choice === '__new__') schedule.versions[version.name] = version;
    if (cur) {
      schedule.assignments[cur] = version.name;
      schedule.override = null;
    } else {
      // No location: we cannot resolve which period "now" is, so keep the
      // applied palette as a standing override rather than silently dropping it.
      schedule.override = { versionName: version.name, setAt: new Date().toISOString() };
      p.log.warn('No location available — kept as a standing override.');
    }
  } else {
    // persist so the override record references a version that actually exists
    if (choice === '__new__') schedule.versions[version.name] = version;
    schedule.override = { versionName: version.name, setAt: new Date().toISOString() };
  }
  saveSchedule(schedule);
  p.log.success(
    scope === 'all-times'
      ? 'Applied and set as the standing choice.'
      : 'Applied until the next scheduled change.'
  );
}

// --- config screens ---------------------------------------------------------

async function periodsMenu(): Promise<void> {
  for (;;) {
    const schedule = loadSchedule();
    p.note(
      schedule.periods
        .map((per) => {
          const on = per.enabled ? '' : ' (disabled)';
          const v = schedule.assignments[per.name] ?? '—';
          return `${per.name.padEnd(12)} ${describeTrigger(per.trigger).padEnd(22)} → ${v}${on}`;
        })
        .join('\n'),
      'Periods'
    );

    const action = (await p.select({
      message: 'Periods & schedule',
      options: [
        { value: 'add', label: 'Add a custom period' },
        { value: 'toggle', label: 'Enable / disable periods' },
        { value: 'assign', label: 'Assign a palette to a period' },
        { value: 'remove', label: 'Remove a custom period' },
        { value: 'back', label: 'Back' },
      ],
    })) as string;
    if (cancelled(action) || action === 'back') return;

    if (action === 'add') {
      let name = (await p.text({ message: 'Period name' })) as string;
      if (cancelled(name) || !name) continue;
      if (schedule.periods.some((x) => x.name === name)) {
        const suggested = nextFreeName(name, (n) => schedule.periods.some((x) => x.name === n));
        p.log.warn(`A period named "${name}" already exists.`);
        const again = (await p.text({
          message: 'Choose a different name',
          defaultValue: suggested,
        })) as string;
        if (cancelled(again)) continue;
        name = again && !schedule.periods.some((x) => x.name === again) ? again : suggested;
      }
      const expr = (await p.text({
        message: 'Trigger (e.g. "1h before sunrise", "7am", "sunset")',
      })) as string;
      if (cancelled(expr)) continue;
      let trigger: ReturnType<typeof parseTrigger>;
      try {
        trigger = parseTrigger(expr);
      } catch (e) {
        p.log.error((e as Error).message);
        continue;
      }
      schedule.periods.push({ name, trigger, builtin: false, enabled: true });
      saveSchedule(schedule);
      regenQuietly(schedule);
      p.log.success(`Added ${name}.`);
    } else if (action === 'toggle') {
      const enabled = (await p.multiselect({
        message: 'Enabled periods (space toggles)',
        options: schedule.periods.map((x) => ({ value: x.name, label: x.name })),
        initialValues: schedule.periods.filter((x) => x.enabled).map((x) => x.name),
        required: false,
      })) as string[];
      if (cancelled(enabled)) continue;
      for (const per of schedule.periods) per.enabled = enabled.includes(per.name);
      saveSchedule(schedule);
      regenQuietly(schedule);
    } else if (action === 'assign') {
      const enabled = schedule.periods.filter((x) => x.enabled);
      if (enabled.length === 0) {
        p.log.warn('No enabled periods to assign.');
        continue;
      }
      const versions = Object.keys(schedule.versions);
      if (versions.length === 0) {
        p.log.warn('No saved palettes yet — create one first.');
        continue;
      }
      const per = (await p.select({
        message: 'Period',
        options: enabled.map((x) => ({
          value: x.name,
          label: `${x.name} → ${schedule.assignments[x.name] ?? '—'}`,
        })),
      })) as string;
      if (cancelled(per)) continue;
      const v = (await p.select({
        message: 'Palette',
        options: versions.map((x) => ({ value: x, label: x })),
      })) as string;
      if (cancelled(v)) continue;
      schedule.assignments[per] = v;
      saveSchedule(schedule);
      p.log.success(`Assigned ${v} → ${per}.`);
    } else if (action === 'remove') {
      const removable = schedule.periods.filter((x) => !x.builtin);
      if (removable.length === 0) {
        p.log.warn('No custom periods to remove.');
        continue;
      }
      const per = (await p.select({
        message: 'Remove which period?',
        options: removable.map((x) => ({ value: x.name, label: x.name })),
      })) as string;
      if (cancelled(per)) continue;
      schedule.periods = schedule.periods.filter((x) => x.name !== per);
      delete schedule.assignments[per];
      saveSchedule(schedule);
      regenQuietly(schedule);
      p.log.success(`Removed ${per}.`);
    }
  }
}

async function defaultsForm(): Promise<void> {
  const cfg = loadConfig();

  const reviewMode = (await p.select({
    message: 'Default review mode',
    initialValue: cfg.defaults.reviewMode,
    options: [
      { value: 'none', label: 'none', hint: 'code only, offline' },
      { value: 'local', label: 'local', hint: 'node-llama-cpp + GGUF' },
      { value: 'remote', label: 'remote', hint: 'BYO API key' },
      { value: 'plugin', label: 'plugin', hint: 'a pinned local/community backend' },
    ],
  })) as ReviewMode;
  if (cancelled(reviewMode)) return;
  cfg.defaults.reviewMode = reviewMode;

  if (reviewMode === 'plugin') {
    const pinned = loadLock().plugins;
    if (pinned.length === 0) {
      p.log.warn('No plugins are pinned yet — add one under Plugins & trust first.');
      return;
    }
    const pluginId = (await p.select({
      message: 'Plugin reviewer',
      initialValue: cfg.defaults.pluginId,
      options: pinned.map((e) => ({ value: e.id, label: `${e.id}@${e.version}`, hint: e.tier })),
    })) as string;
    if (cancelled(pluginId)) return;
    cfg.defaults.pluginId = pluginId;
  }

  const scope = (await p.select({
    message: 'Default apply-scope for `palette`',
    initialValue: cfg.defaults.applyScope,
    options: [
      { value: 'until-next-change', label: 'until the next scheduled change' },
      { value: 'all-times', label: 'all times' },
    ],
  })) as 'all-times' | 'until-next-change';
  if (cancelled(scope)) return;
  cfg.defaults.applyScope = scope;

  if (reviewMode === 'remote') {
    const provider = (await p.select({
      message: 'Provider',
      options: [
        { value: 'anthropic', label: 'Anthropic' },
        { value: 'openai-compatible', label: 'OpenAI-compatible' },
      ],
    })) as 'anthropic' | 'openai-compatible';
    if (cancelled(provider)) return;
    const apiKeyEnv = (await p.text({
      message: 'Env var holding the API key',
      defaultValue: provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY',
    })) as string;
    if (cancelled(apiKeyEnv)) return;
    cfg.remote = { provider, apiKeyEnv };
  }

  saveConfig(cfg);
  p.log.success('Saved configuration.');
}

async function modelsMenu(): Promise<void> {
  for (;;) {
    const action = (await p.select({
      message: 'Local review models',
      options: [
        { value: 'scan', label: 'Scan this machine for GGUFs' },
        { value: 'list', label: 'List suggested + discovered' },
        { value: 'pull', label: 'Download a suggested model' },
        { value: 'use', label: 'Set the active model' },
        { value: 'back', label: 'Back' },
      ],
    })) as string;
    if (cancelled(action) || action === 'back') return;

    if (action === 'scan') {
      const found = scanModels();
      if (found.length === 0) p.log.info('No GGUF models found on this machine.');
      else
        p.note(
          found
            .map((m) => `${m.source.padEnd(10)} ${humanSize(m.sizeBytes).padStart(8)}  ${m.path}`)
            .join('\n'),
          'Discovered models'
        );
    } else if (action === 'list') {
      const cur = loadConfig().modelPath;
      p.note(
        [
          ...SUGGESTED_MODELS.map(
            (m) =>
              `${m.id.padEnd(14)} ${humanSize(m.sizeBytes).padStart(7)}  ${m.license}  ${m.name}`
          ),
          '',
          `Active: ${cur ?? '(none)'}`,
        ].join('\n'),
        'Suggested (permissively licensed)'
      );
    } else if (action === 'pull') {
      const id = (await p.text({ message: 'Model id' })) as string;
      if (cancelled(id)) continue;
      const m = suggestedById(id);
      if (!m) {
        p.log.error(`unknown model "${id}".`);
        continue;
      }
      const ok = await p.confirm({
        message: `Download ${m.name} (${humanSize(m.sizeBytes)}, ${m.license})?`,
      });
      if (cancelled(ok) || !ok) continue;
      const s = p.spinner();
      s.start('Downloading');
      try {
        const dest = await pullModel(id, (r, t) =>
          s.message(`Downloading ${humanSize(r)} / ${humanSize(t)}`)
        );
        s.stop(`Saved to ${dest}`);
        useModel(dest);
        p.log.success('Model pulled and set active (review mode: local).');
      } catch (e) {
        s.stop('Download failed');
        p.log.error((e as Error).message);
      }
    } else if (action === 'use') {
      const path = (await p.text({
        message: 'Model path (or a suggested id already pulled)',
      })) as string;
      if (cancelled(path)) continue;
      try {
        p.log.success(`Active model: ${useModel(path)} (review mode: local)`);
      } catch (e) {
        p.log.error((e as Error).message);
      }
    }
  }
}

async function configMenu(): Promise<void> {
  ensureInitialized();
  p.intro('palette config');
  for (;;) {
    const action = (await p.select({
      message: 'Configure',
      options: [
        { value: 'periods', label: 'Periods & schedule' },
        { value: 'defaults', label: 'Defaults & review' },
        { value: 'models', label: 'Local review models' },
        { value: 'plugins', label: 'Plugins & trust' },
        { value: 'setup', label: 'Services (install / uninstall)' },
        { value: 'back', label: 'Back' },
      ],
    })) as string;
    if (cancelled(action) || action === 'back') break;
    if (action === 'periods') await periodsMenu();
    else if (action === 'defaults') await defaultsForm();
    else if (action === 'models') await modelsMenu();
    else if (action === 'plugins') await pluginsScreen();
    else if (action === 'setup') await setupMenu();
  }
  p.outro('Done.');
}

// --- plugins & trust --------------------------------------------------------

async function pluginsScreen(): Promise<void> {
  for (;;) {
    const lock = loadLock();
    const entries =
      lock.plugins.length === 0
        ? 'No plugins pinned yet.'
        : lock.plugins
            .map((e) => `${e.id}@${e.version}  ${e.tier}  sha256:${e.hash.slice(0, 12)}`)
            .join('\n');
    p.note(
      [
        `Lock: ${lockPath()}`,
        '',
        `official   ${TIER_NOTE.official}`,
        `local      ${TIER_NOTE.local}`,
        `community  ${TIER_NOTE.community}`,
        '',
        entries,
      ].join('\n'),
      'Plugins & trust'
    );
    const action = (await p.select({
      message: 'Plugins',
      options: [
        { value: 'install', label: 'Pin a plugin from a manifest path' },
        { value: 'activate', label: 'Use a pinned plugin for review' },
        { value: 'remove', label: 'Unpin a plugin' },
        { value: 'back', label: 'Back' },
      ],
    })) as string;
    if (cancelled(action) || action === 'back') return;

    if (action === 'install') {
      const manifestPath = (await p.text({ message: 'Path to plugin manifest (.json)' })) as string;
      if (cancelled(manifestPath) || !manifestPath) continue;
      try {
        const entry = installPlugin(manifestPath);
        p.log.success(`Pinned ${entry.id}@${entry.version} (${entry.tier}).`);
      } catch (err) {
        p.log.error(err instanceof Error ? err.message : String(err));
      }
    } else if (action === 'activate') {
      if (lock.plugins.length === 0) {
        p.log.warn('Nothing pinned to activate.');
        continue;
      }
      const id = (await p.select({
        message: 'Plugin reviewer',
        options: lock.plugins.map((e) => ({
          value: e.id,
          label: `${e.id}@${e.version}`,
          hint: e.tier,
        })),
      })) as string;
      if (cancelled(id)) continue;
      const cfg = loadConfig();
      cfg.defaults.reviewMode = 'plugin';
      cfg.defaults.pluginId = id;
      saveConfig(cfg);
      p.log.success(`Review mode set to plugin: ${id}.`);
    } else if (action === 'remove') {
      if (lock.plugins.length === 0) continue;
      const id = (await p.select({
        message: 'Unpin which plugin?',
        options: lock.plugins.map((e) => ({ value: e.id, label: `${e.id}@${e.version}` })),
      })) as string;
      if (cancelled(id)) continue;
      if (removePlugin(id)) p.log.success(`Unpinned ${id}.`);
    }
  }
}

// --- benchmark --------------------------------------------------------------

function summaryText(s: BenchRun['summary']): string {
  return [
    `cases             ${s.cases}`,
    `approved          ${(s.approvedRate * 100).toFixed(1)}%`,
    `mean tweaks       ${s.meanTweaks.toFixed(2)}`,
    `mean tweak ΔE     ${s.meanTweakDeltaE.toFixed(4)}`,
    `still valid       ${(s.validRate * 100).toFixed(1)}%`,
    `still clean       ${(s.cleanRate * 100).toFixed(1)}%`,
    `scope violations  ${s.scopeViolations}`,
    `mean latency      ${s.meanLatencyMs.toFixed(0)}ms`,
  ].join('\n');
}

async function runBenchFlow(): Promise<void> {
  ensureInitialized();
  const cfg = loadConfig();

  const size = (await p.select({
    message: 'Case set size',
    options: [
      { value: 'quick', label: `quick — ${SIZES.quick} cases` },
      { value: 'standard', label: `standard — ${SIZES.standard} cases` },
      { value: 'full', label: `full — ${SIZES.full} cases` },
    ],
  })) as keyof typeof SIZES;
  if (cancelled(size)) return;

  const mode = (await p.select({
    message: 'Reviewer (the only variable in a run)',
    options: [
      { value: 'configured', label: `Configured reviewer (${cfg.defaults.reviewMode})` },
      { value: 'none', label: 'none — no review (control)' },
      { value: 'plugin', label: 'plugin — a pinned community/local reviewer' },
    ],
  })) as string;
  if (cancelled(mode)) return;

  let pluginId: string | undefined;
  if (mode === 'plugin') {
    const pinned = loadLock().plugins;
    if (pinned.length === 0) {
      p.log.warn('No plugins are pinned — add one under Plugins & trust.');
      return;
    }
    pluginId = (await p.select({
      message: 'Plugin reviewer',
      options: pinned.map((e) => ({ value: e.id, label: `${e.id}@${e.version}`, hint: e.tier })),
    })) as string;
    if (cancelled(pluginId)) return;
  }

  const label = (await p.text({
    message: 'Label',
    defaultValue: cfg.defaults.reviewMode,
  })) as string;
  if (cancelled(label)) return;

  const bookmark = (await p.text({
    message: 'Bookmark name (optional — e.g. "Acme / acme-1")',
  })) as string;
  if (cancelled(bookmark)) return;

  let reviewer: ReviewBackend;
  try {
    if (mode === 'none') {
      reviewer = await getReviewer({ ...cfg, defaults: { ...cfg.defaults, reviewMode: 'none' } });
    } else if (mode === 'plugin') {
      reviewer = await getReviewer({
        ...cfg,
        defaults: { ...cfg.defaults, reviewMode: 'plugin', pluginId },
      });
    } else {
      reviewer = await getReviewer(cfg);
    }
  } catch (e) {
    p.log.error((e as Error).message);
    return;
  }

  const spin = p.spinner();
  spin.start(`Running ${SIZES[size]} cases…`);
  let run: BenchRun;
  try {
    run = await runBench({
      label: label || cfg.defaults.reviewMode,
      reviewer,
      size: SIZES[size],
      runSeed: `cli-${Date.now()}`,
      onCase: (done, total) => spin.message(`Running ${done}/${total}…`),
    });
  } catch (e) {
    spin.stop('Benchmark failed.');
    p.log.error((e as Error).message);
    return;
  }
  spin.stop(`Ran ${run.summary.cases} cases.`);

  if (bookmark) {
    run.name = bookmark;
    const [company, model] = bookmark.split('/').map((x) => x.trim());
    if (company) run.company = company;
    if (model) run.model = model;
  }
  saveRun(run);
  p.note(summaryText(run.summary), `Results — ${run.name}`);
  p.log.info(`Saved: ${run.name}${run.company ? ` (${run.company})` : ''}`);
}

function showRuns(): void {
  const runs = listRuns();
  if (runs.length === 0) {
    p.log.info('No saved runs yet.');
    return;
  }
  p.note(
    runs
      .map(
        (r) =>
          `${r.name.padEnd(24)} ${r.summary.cases} cases  ${(r.summary.approvedRate * 100).toFixed(0)}% approved`
      )
      .join('\n'),
    'Saved runs'
  );
}

async function compareBenchFlow(): Promise<void> {
  const runs = listRuns();
  if (runs.length < 2) {
    p.log.info('Need at least two saved runs to compare.');
    return;
  }
  const pick = async (message: string): Promise<BenchRun | null> => {
    const name = (await p.select({
      message,
      options: runs.map((r) => ({ value: r.name, label: r.name })),
    })) as string;
    if (cancelled(name)) return null;
    return loadRun(name);
  };
  const a = await pick('First run');
  if (!a) return;
  const b = await pick('Second run');
  if (!b) return;
  p.note(compareRuns(a, b), `${a.name}  vs  ${b.name}`);
}

async function benchMenu(): Promise<void> {
  ensureInitialized();
  p.intro('palette benchmark');
  for (;;) {
    const action = (await p.select({
      message: 'Benchmark',
      options: [
        { value: 'run', label: 'Run a benchmark' },
        { value: 'list', label: 'Saved runs' },
        { value: 'compare', label: 'Compare two saved runs' },
        { value: 'back', label: 'Back' },
      ],
    })) as string;
    if (cancelled(action) || action === 'back') break;
    if (action === 'run') await runBenchFlow();
    else if (action === 'list') showRuns();
    else if (action === 'compare') await compareBenchFlow();
  }
  p.outro('Done.');
}

// --- setup / services -------------------------------------------------------

function runInstall(): void {
  const schedule = loadSchedule();
  const coords = resolveCoordinates();
  const cur = coords ? (currentPeriod(schedule, coords) ?? 'afternoon') : 'afternoon';
  const versionName = schedule.assignments[cur] ?? 'Day';
  const version = schedule.versions[versionName] ?? schedule.versions.Day;
  if (!version) {
    p.log.error('No palette versions available — create one under Configure first.');
    return;
  }

  try {
    const env = resolveEnv();
    installManaged(env, version);
    p.log.success(`Managed palette selected (${env.install}).`);
  } catch (e) {
    p.log.error(`Could not select the palette in Ptyxis: ${(e as Error).message}`);
  }

  try {
    installUnits();
    const r = regen(schedule, { force: true, ...(coords ? { coords } : {}) });
    p.log.success(`${r.timers.length} period timers scheduled.`);
  } catch (e) {
    p.log.error(`Could not install timers: ${(e as Error).message}`);
  }
}

function setupStatus(): void {
  ensureInitialized();
  const lines: string[] = [];
  const install = detectInstall();
  lines.push(`Ptyxis: ${install ?? 'not detected'}`);
  if (install) {
    try {
      const env = resolveEnv();
      lines.push(`Palettes dir: ${env.palettesDir}`);
      lines.push(`Profile: ${env.profileUuid}`);
    } catch (e) {
      lines.push(`Env error: ${(e as Error).message}`);
    }
  }
  const last = readLastRegen();
  lines.push(`Last regen: ${last ? last.toISOString() : '(never)'}`);
  lines.push(`Config: ${paths().base}`);
  p.note(lines.join('\n'), 'Status');
}

async function setupMenu(): Promise<void> {
  ensureInitialized();
  p.intro('palette setup');
  const action = (await p.select({
    message: 'Services',
    options: [
      { value: 'install', label: 'Install — select the managed palette + enable timers' },
      { value: 'uninstall', label: 'Uninstall — remove palette systemd units' },
      { value: 'status', label: 'Status' },
      { value: 'back', label: 'Back' },
    ],
  })) as string;
  if (cancelled(action) || action === 'back') {
    p.outro('');
    return;
  }
  if (action === 'install') runInstall();
  else if (action === 'uninstall') {
    uninstallUnits();
    p.log.success('Removed palette systemd units.');
    p.log.info(`Config left in place at ${paths().base}`);
  } else if (action === 'status') setupStatus();
  p.outro('Done.');
}

// --- read-only views --------------------------------------------------------

function showSchedule(): void {
  const schedule = loadSchedule();
  const coords = resolveCoordinates();
  if (!coords) {
    p.log.error('No usable location (GNOME Night Light / GeoClue / timezone fallback).');
    return;
  }
  const now = new Date();
  const rows = schedule.periods
    .filter((per) => per.enabled)
    .map((per) => ({ per, dt: resolveTrigger(per.trigger, now, coords) }))
    .sort((a, b) => (a.dt?.getTime() ?? 0) - (b.dt?.getTime() ?? 0));
  p.note(
    rows
      .map(({ per, dt }) => {
        const t = dt
          ? `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`
          : '—';
        return `${t}  ${per.name.padEnd(12)} → ${schedule.assignments[per.name] ?? '—'}`;
      })
      .join('\n'),
    "Today's schedule"
  );
}

// --- machine hooks (systemd) ------------------------------------------------

function applyPeriod(periodName: string): void {
  const schedule = loadSchedule();
  const versionName = schedule.assignments[periodName];
  if (!versionName) fail(`period "${periodName}" has no assigned version.`);
  const version = schedule.versions[versionName!];
  if (!version) fail(`assigned version "${versionName}" not found.`);
  if (schedule.override) {
    schedule.override = null;
    saveSchedule(schedule);
  }
  applyToPtyxis(version!);
  console.log(`Applied "${versionName}" for period ${periodName}.`);
}

function regenCmd(): void {
  const schedule = loadSchedule();
  const r = regen(schedule);
  console.log(
    r.regenerated
      ? `Regenerated ${r.timers.length} timers (${r.reason}).`
      : `No change (${r.reason}).`
  );
}

// --- home -------------------------------------------------------------------

function roleLegend(): void {
  const schedule = loadSchedule();
  const coords = resolveCoordinates();
  const cur = coords ? currentPeriod(schedule, coords) : null;
  const versionName = cur ? schedule.assignments[cur] : undefined;
  const version = (versionName && schedule.versions[versionName]) || schedule.versions.Day;
  if (!version) {
    p.log.warn('No palette to inspect yet.');
    return;
  }
  const lines: string[] = [];
  for (const which of ['dark', 'light'] as const) {
    const scheme = version.palette[which];
    lines.push(`${which.toUpperCase()} — contrast vs its own background`);
    for (let i = 0; i < 16; i++) {
      const hex = scheme.colors[i]!;
      const role = ANSI_ROLES[i];
      const ratio = contrastHex(hex, scheme.background);
      const canonical = ANSI_HUE[i];
      let drift = '';
      if (canonical !== undefined) {
        const d = hueDistance(hexToOklch(hex).h, canonical);
        const mark = d > ANSI_HUE_MAX_DEVIATION ? '!' : ' ';
        drift = `  off-role ${d.toFixed(0).padStart(3)}°${mark}`;
      }
      lines.push(
        `${block(hex)} color${i.toString().padStart(2, ' ')}  ${(role?.name ?? '?').padEnd(14)} ${ratio.toFixed(1).padStart(4)}:1${drift}  ${role?.consumers ?? ''}`
      );
    }
    lines.push('');
  }
  p.note(lines.join('\n'), `Roles — ${version.name}`);
}

async function home(): Promise<void> {
  const firstRun = !existsSync(paths().schedule);
  ensureInitialized();
  p.intro('palette');

  if (firstRun) {
    p.log.info('Looks like your first run.');
    const go = await p.confirm({
      message: 'Set up the managed palette and systemd timers now?',
    });
    if (!cancelled(go) && go) {
      runInstall();
      p.outro('Setup complete.');
      return;
    }
  }

  for (;;) {
    const coords = resolveCoordinates();
    const schedule = loadSchedule();
    if (coords) {
      const cur = currentPeriod(schedule, coords);
      if (cur) {
        const vn = schedule.assignments[cur];
        const version = vn ? schedule.versions[vn] : undefined;
        p.log.info(`Current period: ${cur} → ${vn ?? '—'}`);
        if (version) p.log.message(previewPalette(version.palette));
      }
    } else {
      p.log.warn('No usable location — solar periods cannot be resolved.');
    }

    const action = (await p.select({
      message: 'What would you like to do?',
      options: [
        { value: 'switch', label: 'Switch palette now' },
        { value: 'new', label: 'Create a new palette' },
        { value: 'schedule', label: "Show today's schedule" },
        { value: 'roles', label: 'Show palette roles' },
        { value: 'bench', label: 'Benchmark models & prompts' },
        { value: 'config', label: 'Configure' },
        { value: 'setup', label: 'Services (install / uninstall)' },
        { value: 'quit', label: 'Quit' },
      ],
    })) as string;
    if (cancelled(action) || action === 'quit') break;
    if (action === 'switch') await switchNowFlow();
    else if (action === 'new') await newPaletteFlow();
    else if (action === 'schedule') showSchedule();
    else if (action === 'roles') roleLegend();
    else if (action === 'bench') await benchMenu();
    else if (action === 'config') await configMenu();
    else if (action === 'setup') await setupMenu();
  }
  p.outro('');
}

// --- dispatch ---------------------------------------------------------------

const HELP = `palette — sun-aware Ptyxis palette generator & scheduler

  palette          open the home screen (switch, create, configure, setup)
  palette setup    install / uninstall / status of the services
  palette config   configure periods, defaults, and review models

  Machine hooks (systemd only):
    palette apply-period <name>   apply a period's assigned palette
    palette regen                 refresh period timers`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case undefined:
      requireInteractive('palette');
      return home();
    case 'setup':
      requireInteractive('palette setup');
      return setupMenu();
    case 'config':
      requireInteractive('palette config');
      return configMenu();
    case 'apply-period':
      return void applyPeriod(rest[0] ?? fail('usage: palette apply-period <name>'));
    case 'regen':
      return void regenCmd();
    case 'version':
    case '--version':
    case '-v':
      return void console.log(version());
    case 'help':
    case '--help':
    case '-h':
      return void console.log(HELP);
    default:
      console.error(`palette: unknown command "${cmd}"\n`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`palette: ${(err as Error).message}`);
  process.exit(1);
});
