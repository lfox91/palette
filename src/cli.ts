#!/usr/bin/env node
/**
 * palette — sun-aware Ptyxis palette generator & scheduler.
 *
 * Command dispatch + guided dialogs. The two systemd entrypoints (`apply-period`
 * and `regen`) are strictly non-interactive; everything else may prompt via
 * @clack/prompts, honoring saved defaults so dialogs can be skipped.
 */

import * as p from '@clack/prompts';
import { hexToRgb } from './color.js';
import {
  ensureInitialized,
  loadConfig,
  loadSchedule,
  paths,
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
import { applyVersion, installManaged, resolveEnv } from './ptyxis.js';
import { applyTweaks, getReviewer } from './review/index.js';
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

function coordsOrExit(): Coordinates {
  const c = resolveCoordinates();
  if (!c) {
    p.log.error('No usable location (GNOME Night Light / GeoClue / timezone fallback).');
    process.exit(1);
  }
  return c;
}

/** The period whose trigger most recently passed (wrapping from last night). */
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

// --- generation + review + save --------------------------------------------

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
  p.log.message(previewPalette(palette));

  if (cfg.defaults.reviewMode === 'none') return palette;

  // optional post-generation review
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

// --- commands ---------------------------------------------------------------

async function cmdCreate(): Promise<void> {
  ensureInitialized();
  const cfg = loadConfig();
  const schedule = loadSchedule();
  p.intro('palette create');

  const d = cfg.defaults.mood;
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
    options: schedule.periods.map((per) => ({
      value: per.name,
      label: per.name,
      hint: describeTrigger(per.trigger),
    })),
  })) as string;
  if (cancelled(period)) return;

  const input: MoodInput = { energy, warmth, contrast, note: (note as string) || undefined };
  const palette = await generateReviewed(input, period);
  if (!palette) return;

  const name = (await p.text({
    message: 'Version name',
    placeholder: `${period}-${energy}`,
    defaultValue: `${period}-${energy}`,
  })) as string;
  if (cancelled(name)) return;

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
  p.outro(`Saved "${name}" and assigned it to ${period}.`);
}

async function cmdImmediate(): Promise<void> {
  ensureInitialized();
  const cfg = loadConfig();
  const schedule = loadSchedule();
  p.intro('palette');

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
    const coords = coordsOrExit();
    const period = currentPeriod(schedule, coords) ?? 'afternoon';
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
    version = schedule.versions[choice]!;
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
    const coords = coordsOrExit();
    const cur = currentPeriod(schedule, coords);
    if (cur) {
      if (choice === '__new__') schedule.versions[version.name] = version;
      schedule.assignments[cur] = version.name;
    }
    schedule.override = null;
  } else {
    schedule.override = { versionName: version.name, setAt: new Date().toISOString() };
  }
  saveSchedule(schedule);
  p.outro(
    scope === 'all-times'
      ? 'Applied and set as the standing choice.'
      : 'Applied until the next scheduled change.'
  );
}

function cmdApply(versionName: string): void {
  const schedule = loadSchedule();
  const version = schedule.versions[versionName];
  if (!version) fail(`no such version "${versionName}". See \`palette list\`.`);
  applyToPtyxis(version!);
  console.log(`Applied "${versionName}".`);
}

/** systemd entrypoint: apply the version assigned to a period (non-interactive). */
function cmdApplyPeriod(periodName: string): void {
  const schedule = loadSchedule();
  const versionName = schedule.assignments[periodName];
  if (!versionName) fail(`period "${periodName}" has no assigned version.`);
  const version = schedule.versions[versionName!];
  if (!version) fail(`assigned version "${versionName}" not found.`);
  // a scheduled boundary supersedes any temporary override
  if (schedule.override) {
    schedule.override = null;
    saveSchedule(schedule);
  }
  applyToPtyxis(version!);
  console.log(`Applied "${versionName}" for period ${periodName}.`);
}

function cmdList(): void {
  const schedule = loadSchedule();
  console.log('Periods → version:');
  for (const per of schedule.periods) {
    const flag = per.enabled ? '' : ' (disabled)';
    const v = schedule.assignments[per.name] ?? '—';
    console.log(
      `  ${per.name.padEnd(12)} ${describeTrigger(per.trigger).padEnd(20)} → ${v}${flag}`
    );
  }
  if (schedule.override) console.log(`\nTemporary override: ${schedule.override.versionName}`);
  console.log(`\nSaved versions: ${Object.keys(schedule.versions).join(', ')}`);
}

function cmdScheduleShow(): void {
  const schedule = loadSchedule();
  const coords = coordsOrExit();
  const now = new Date();
  console.log("Today's schedule:");
  const rows = schedule.periods
    .filter((per) => per.enabled)
    .map((per) => ({ per, dt: resolveTrigger(per.trigger, now, coords) }))
    .sort((a, b) => (a.dt?.getTime() ?? 0) - (b.dt?.getTime() ?? 0));
  for (const { per, dt } of rows) {
    const t = dt
      ? `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`
      : '—';
    console.log(`  ${t}  ${per.name.padEnd(12)} → ${schedule.assignments[per.name] ?? '—'}`);
  }
}

function cmdScheduleAssign(periodName: string, versionName: string): void {
  const schedule = loadSchedule();
  if (!schedule.periods.some((x) => x.name === periodName)) fail(`no such period "${periodName}".`);
  if (!schedule.versions[versionName]) fail(`no such version "${versionName}".`);
  schedule.assignments[periodName] = versionName;
  saveSchedule(schedule);
  console.log(`Assigned ${versionName} → ${periodName}.`);
}

function cmdPeriod(args: string[]): void {
  const [action, name, ...rest] = args;
  const schedule = loadSchedule();
  const find = (n: string) => schedule.periods.find((x) => x.name === n);
  switch (action) {
    case 'add': {
      if (!name || rest.length === 0) fail('usage: palette period add <name> <trigger>');
      if (find(name!)) fail(`period "${name}" already exists.`);
      const trigger = parseTrigger(rest.join(' '));
      schedule.periods.push({ name: name!, trigger, builtin: false, enabled: true });
      break;
    }
    case 'rm': {
      const per = find(name ?? '');
      if (!per) fail(`no such period "${name}".`);
      if (per!.builtin) fail(`"${name}" is built-in — use \`period disable\` instead.`);
      schedule.periods = schedule.periods.filter((x) => x.name !== name);
      delete schedule.assignments[name!];
      break;
    }
    case 'disable':
    case 'enable': {
      const per = find(name ?? '');
      if (!per) fail(`no such period "${name}".`);
      per!.enabled = action === 'enable';
      break;
    }
    default:
      fail('usage: palette period add|rm|disable|enable <name> [trigger]');
  }
  saveSchedule(schedule);
  regenQuietly(schedule);
  console.log('Updated periods.');
}

async function cmdConfigure(): Promise<void> {
  ensureInitialized();
  const cfg = loadConfig();
  p.intro('palette configure');
  const reviewMode = (await p.select({
    message: 'Default review mode',
    initialValue: cfg.defaults.reviewMode,
    options: [
      { value: 'none', label: 'none', hint: 'code only, offline' },
      { value: 'local', label: 'local', hint: 'node-llama-cpp + GGUF' },
      { value: 'remote', label: 'remote', hint: 'BYO API key' },
    ],
  })) as 'none' | 'local' | 'remote';
  if (cancelled(reviewMode)) return;
  cfg.defaults.reviewMode = reviewMode;

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
      placeholder: provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY',
      defaultValue: provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY',
    })) as string;
    if (cancelled(apiKeyEnv)) return;
    cfg.remote = { provider, apiKeyEnv };
  }

  const scope = (await p.select({
    message: 'Default apply-scope for bare `palette`',
    initialValue: cfg.defaults.applyScope,
    options: [
      { value: 'until-next-change', label: 'until the next scheduled change' },
      { value: 'all-times', label: 'all times' },
    ],
  })) as 'all-times' | 'until-next-change';
  if (cancelled(scope)) return;
  cfg.defaults.applyScope = scope;

  saveConfig(cfg);
  p.outro('Saved configuration.');
}

async function cmdModel(args: string[]): Promise<void> {
  const [action, arg] = args;
  switch (action) {
    case 'scan': {
      const found = scanModels();
      if (found.length === 0) return void console.log('No GGUF models found on this machine.');
      for (const m of found)
        console.log(`  ${m.source.padEnd(10)} ${humanSize(m.sizeBytes).padStart(8)}  ${m.path}`);
      break;
    }
    case 'list': {
      console.log('Suggested (permissively licensed):');
      for (const m of SUGGESTED_MODELS)
        console.log(
          `  ${m.id.padEnd(14)} ${humanSize(m.sizeBytes).padStart(7)}  ${m.license}  ${m.name}`
        );
      console.log('\nDiscovered on machine:');
      for (const m of scanModels())
        console.log(`  ${humanSize(m.sizeBytes).padStart(8)}  ${m.path}`);
      const cur = loadConfig().modelPath;
      console.log(`\nActive model: ${cur ?? '(none)'}`);
      break;
    }
    case 'pull': {
      if (!arg) fail('usage: palette model pull <id>');
      const m = suggestedById(arg!);
      if (!m) fail(`unknown model "${arg}". See \`palette model list\`.`);
      p.intro('palette model pull');
      const ok = await p.confirm({
        message: `Download ${m!.name} (${humanSize(m!.sizeBytes)}, ${m!.license}) from Hugging Face?`,
      });
      if (cancelled(ok) || !ok) return;
      const s = p.spinner();
      s.start('Downloading');
      const dest = await pullModel(arg!, (r, t) =>
        s.message(`Downloading ${humanSize(r)} / ${humanSize(t)}`)
      );
      s.stop(`Saved to ${dest}`);
      useModel(dest);
      p.outro('Model pulled and set active.');
      break;
    }
    case 'use': {
      if (!arg) fail('usage: palette model use <path|id>');
      console.log(`Active model: ${useModel(arg!)}`);
      break;
    }
    default:
      fail('usage: palette model scan|list|pull|use');
  }
}

function cmdInstall(): void {
  ensureInitialized();
  const schedule = loadSchedule();
  const coords = coordsOrExit();
  const cur = currentPeriod(schedule, coords) ?? 'afternoon';
  const versionName = schedule.assignments[cur] ?? 'Day';
  const version = schedule.versions[versionName] ?? schedule.versions.Day!;
  const env = resolveEnv();
  installManaged(env, version);
  installUnits();
  const r = regen(schedule, { force: true, coords });
  console.log(
    `Installed. Managed palette selected (${env.install}); ${r.timers.length} period timers scheduled.`
  );
}

function cmdUninstall(): void {
  uninstallUnits();
  console.log('Removed palette systemd units. Config left in place at', paths().base);
}

function cmdRegen(): void {
  const schedule = loadSchedule();
  const r = regen(schedule);
  console.log(
    r.regenerated
      ? `Regenerated ${r.timers.length} timers (${r.reason}).`
      : `No change (${r.reason}).`
  );
}

// --- shared side effects ----------------------------------------------------

function applyToPtyxis(version: PaletteVersion): void {
  const check = validatePalette(version.palette);
  if (!check.ok)
    fail(`refusing to apply "${version.name}" — it fails validation:\n${formatIssues(check)}`);
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

// --- dispatch ---------------------------------------------------------------

const HELP = `palette — sun-aware Ptyxis palette generator & scheduler

  palette                     apply a palette now (choose + scope)
  palette create              generate + review + assign to a period
  palette apply <version>     apply a stored version now
  palette apply-period <name> [systemd] apply a period's version
  palette list                show period→version map + versions
  palette schedule show       today's trigger times
  palette schedule <p> <v>    assign version v to period p
  palette period add|rm|disable|enable <name> [trigger]
  palette configure           review mode, defaults, remote key
  palette regen               [systemd] refresh period timers
  palette model scan|list|pull|use
  palette install|uninstall   set up / remove systemd units`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case undefined:
    case 'apply-now':
      return cmdImmediate();
    case 'create':
      return cmdCreate();
    case 'apply':
      return void cmdApply(rest[0] ?? fail('usage: palette apply <version>'));
    case 'apply-period':
      return void cmdApplyPeriod(rest[0] ?? fail('usage: palette apply-period <name>'));
    case 'list':
      return void cmdList();
    case 'schedule':
      if (rest[0] === 'show' || rest.length === 0) return void cmdScheduleShow();
      return void cmdScheduleAssign(
        rest[0]!,
        rest[1] ?? fail('usage: palette schedule <period> <version>')
      );
    case 'period':
      return void cmdPeriod(rest);
    case 'configure':
      return cmdConfigure();
    case 'model':
      return cmdModel(rest);
    case 'regen':
      return void cmdRegen();
    case 'install':
      return void cmdInstall();
    case 'uninstall':
      return void cmdUninstall();
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
