/**
 * Periods — the sun-relative slots that drive the schedule. Five built-ins with
 * default triggers (built-ins soft-delete only; custom periods hard-delete),
 * a trigger-expression parser for the CLI ("1h after sunrise", "30m before
 * sunset", "7am", "13:30", "sunset"), and resolution of a trigger to a concrete
 * datetime for a given day using solar.ts.
 *
 * Triggers are stored as one of two shapes (see types.ts):
 *   { kind: "clock",  time: "HH:MM" }
 *   { kind: "solar",  anchor: sunrise|noon|sunset, offsetMin: ±N }
 *
 * The plan's default afternoon/evening are "fraction of day" offsets; since a
 * stored trigger carries a fixed offsetMin, we bake the fraction against a
 * nominal 12h day (720 min) — a tunable first cut the user can override.
 */

import type { Coordinates } from './solar.js';
import { sunTimes } from './solar.js';
import type { Period, SolarAnchor, Trigger } from './types.js';

const NOMINAL_DAY_MIN = 720; // 12h, used to bake fraction-of-day defaults to fixed offsets

/** The five built-in periods and their default triggers. */
export const BUILTIN_PERIODS: readonly Period[] = [
  { name: 'morning', trigger: { kind: 'clock', time: '06:00' }, builtin: true, enabled: true },
  { name: 'lunch', trigger: { kind: 'clock', time: '12:00' }, builtin: true, enabled: true },
  {
    name: 'afternoon',
    trigger: { kind: 'solar', anchor: 'noon', offsetMin: Math.round(0.1 * NOMINAL_DAY_MIN) }, // +72
    builtin: true,
    enabled: true,
  },
  {
    name: 'evening',
    trigger: { kind: 'solar', anchor: 'sunset', offsetMin: -Math.round(0.15 * NOMINAL_DAY_MIN) }, // -108
    builtin: true,
    enabled: true,
  },
  { name: 'owl', trigger: { kind: 'clock', time: '02:00' }, builtin: true, enabled: true },
];

export function defaultPeriods(): Period[] {
  return BUILTIN_PERIODS.map((p) => ({ ...p, trigger: { ...p.trigger } }));
}

// --- trigger parsing -------------------------------------------------------

const ANCHOR_WORDS: Record<string, SolarAnchor> = {
  sunrise: 'sunrise',
  dawn: 'sunrise',
  sunup: 'sunrise',
  sunset: 'sunset',
  dusk: 'sunset',
  sundown: 'sunset',
  noon: 'noon',
  midday: 'noon',
  'solar noon': 'noon',
  'solar-noon': 'noon',
};

/** Parse a duration like "1h", "30m", "90", "1h30m", "1.5h" into minutes. */
export function parseDurationMin(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (/^\d+(?:\.\d+)?$/.test(s)) return Math.round(Number.parseFloat(s)); // bare number = minutes
  let total = 0;
  let matched = false;
  // Longest unit first so "30min" consumes "min", not just "m".
  const re = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
  while ((m = re.exec(s)) !== null) {
    matched = true;
    const n = Number.parseFloat(m[1]!);
    total += /^h/.test(m[2]!) ? n * 60 : n;
  }
  return matched ? Math.round(total) : null;
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Word-bounded so "noon" never matches inside "afternoon" and "solar noon"
// matches as one unit rather than as a bare "noon".
const ANCHOR_RE = new RegExp(`\\b(${Object.keys(ANCHOR_WORDS).map(escapeReg).join('|')})\\b`);

function findAnchor(s: string): SolarAnchor | null {
  const m = s.match(ANCHOR_RE);
  return m ? (ANCHOR_WORDS[m[1]!] ?? null) : null;
}

/**
 * Parse a trigger expression into a Trigger.
 * Solar: "sunset", "1h after sunrise", "30m before sunset", "noon + 90m",
 *        "sunrise-15". Clock: "7am", "7:30pm", "13:30", "06:00".
 * Throws on unparseable input (the CLI surfaces the message).
 */
export function parseTrigger(input: string): Trigger {
  const s = input.trim().toLowerCase();
  const anchor = findAnchor(s);

  if (anchor) {
    // exact anchor (no offset words/digits beyond the anchor itself)
    const withoutAnchor = s.replace(ANCHOR_RE, '').trim();
    if (withoutAnchor === '') return { kind: 'solar', anchor, offsetMin: 0 };

    // direction: "after"/"+" => positive, "before"/"-" => negative
    let sign = 1;
    if (/\bbefore\b|-/.test(withoutAnchor)) sign = -1;
    else if (/\bafter\b|\+/.test(withoutAnchor)) sign = 1;

    const dur = parseDurationMin(withoutAnchor.replace(/before|after|\+|-/g, ' '));
    if (dur === null)
      throw new Error(`could not parse the offset in "${input}" (try "1h after sunrise")`);
    return { kind: 'solar', anchor, offsetMin: sign * dur };
  }

  // clock forms
  const clock = parseClock(s);
  if (clock) return { kind: 'clock', time: clock };

  throw new Error(
    `could not parse trigger "${input}" — use a time ("7am", "13:30") or a solar expression ("sunset", "30m before sunset")`
  );
}

/** Parse a clock expression into canonical "HH:MM" (24h), or null. */
export function parseClock(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, '');
  // 12h with am/pm: 7am, 7:30pm, 12am
  let m = s.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/);
  if (m) {
    let h = Number.parseInt(m[1]!, 10);
    const min = m[2] ? Number.parseInt(m[2]!, 10) : 0;
    if (h < 1 || h > 12 || min > 59) return null;
    if (m[3] === 'am') h = h === 12 ? 0 : h;
    else h = h === 12 ? 12 : h + 12;
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  }
  // 24h: 13:30, 06:00, 6:00
  m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const h = Number.parseInt(m[1]!, 10);
    const min = Number.parseInt(m[2]!, 10);
    if (h > 23 || min > 59) return null;
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  }
  return null;
}

// --- resolution to a concrete datetime -------------------------------------

/**
 * Resolve a trigger to a concrete datetime on the given local `day`.
 * Clock triggers use local wall-clock time; solar triggers anchor to that day's
 * sun times (± offset). Returns null only for solar triggers on polar days.
 */
export function resolveTrigger(trigger: Trigger, day: Date, coords: Coordinates): Date | null {
  if (trigger.kind === 'clock') {
    const [h, m] = trigger.time.split(':').map((n) => Number.parseInt(n, 10));
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h!, m!, 0, 0);
  }
  // Anchor solar times to the LOCAL calendar day of `day`: compute sun times
  // from local noon so sunTimes' internal UTC date matches the local date
  // (avoids an off-by-one near the UTC-midnight boundary vs. clock triggers).
  const localNoon = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12, 0, 0, 0);
  const t = sunTimes(localNoon, coords);
  if (!t) return null;
  const base =
    trigger.anchor === 'sunrise' ? t.sunrise : trigger.anchor === 'sunset' ? t.sunset : t.noon;
  return new Date(base.getTime() + trigger.offsetMin * 60_000);
}

/**
 * The next time this trigger fires at or after `now`. Today's occurrence if it
 * is still in the future, otherwise tomorrow's. Null for solar polar days.
 */
export function nextOccurrence(trigger: Trigger, now: Date, coords: Coordinates): Date | null {
  const today = resolveTrigger(trigger, now, coords);
  if (today && today.getTime() > now.getTime()) return today;
  // Advance the LOCAL calendar date, not a fixed 24h: on a DST transition
  // now+86_400_000 can land on the same calendar day and resolve to a past time.
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 12, 0, 0, 0);
  return resolveTrigger(trigger, tomorrow, coords);
}

/** Human-readable trigger description for `schedule show` / listings. */
export function describeTrigger(trigger: Trigger): string {
  if (trigger.kind === 'clock') return trigger.time;
  const { anchor, offsetMin } = trigger;
  if (offsetMin === 0) return anchor;
  const dir = offsetMin > 0 ? 'after' : 'before';
  const mag = Math.abs(offsetMin);
  const h = Math.floor(mag / 60);
  const m = mag % 60;
  const dur = h > 0 ? (m > 0 ? `${h}h${m}m` : `${h}h`) : `${m}m`;
  return `${dur} ${dir} ${anchor}`;
}
