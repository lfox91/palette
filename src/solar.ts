/**
 * Solar math — ported from the personal `gnome-sun-theme` Python tool
 * (`solar_utc_hour` + the location-lookup chain). Pure CPU, offline, no deps.
 *
 * We resolve a coordinate the same way GNOME does: Night Light's last
 * coordinates first (via gsettings), then GeoClue (best-effort over gdbus),
 * then a timezone→coordinate fallback table. From a coordinate we compute
 * sunrise / solar-noon / sunset for a given date.
 *
 * The formula is the classic "Sunrise Equation" (Almanac / NOAA approximation);
 * all trig operates in degrees, so we convert at each call site exactly as the
 * Python original did.
 */

import { execFileSync } from 'node:child_process';

export interface Coordinates {
  lat: number;
  lon: number;
}

export interface SunTimes {
  /** absolute instants (UTC-based Date) for the requested calendar day */
  sunrise: Date;
  noon: Date;
  sunset: Date;
}

// --- trig helpers (degrees in, as the source used math.radians everywhere) ---
const toRad = (deg: number): number => (deg * Math.PI) / 180;
const toDeg = (rad: number): number => (rad * 180) / Math.PI;
const sinD = (deg: number): number => Math.sin(toRad(deg));
const cosD = (deg: number): number => Math.cos(toRad(deg));
const tanD = (deg: number): number => Math.tan(toRad(deg));
/** Synchronous sleep without spawning a process (for the GeoClue poll loop). */
const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
/** positive modulo, matching Python's `%` for a positive divisor */
const mod = (a: number, n: number): number => ((a % n) + n) % n;

function dayOfYear(day: Date): number {
  const start = Date.UTC(day.getUTCFullYear(), 0, 0);
  const current = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  return Math.round((current - start) / 86_400_000);
}

/**
 * UTC hour-of-day (0..24) of sunrise or sunset for `day` at (lat, lon).
 * Returns null for polar day/night (sun never crosses the horizon).
 * Direct port of the Python `solar_utc_hour`.
 */
export function solarUtcHour(day: Date, lat: number, lon: number, sunrise: boolean): number | null {
  const zenith = 90.833; // official sunrise/sunset (includes refraction + solar radius)
  const n = dayOfYear(day);
  const lngHour = lon / 15;
  const t = n + ((sunrise ? 6 : 18) - lngHour) / 24;

  const meanAnomaly = 0.9856 * t - 3.289;
  let trueLong = meanAnomaly + 1.916 * sinD(meanAnomaly) + 0.02 * sinD(2 * meanAnomaly) + 282.634;
  trueLong = mod(trueLong, 360);

  let rightAscension = mod(toDeg(Math.atan(0.91764 * tanD(trueLong))), 360);
  const longQuadrant = Math.floor(trueLong / 90) * 90;
  const raQuadrant = Math.floor(rightAscension / 90) * 90;
  rightAscension = (rightAscension + longQuadrant - raQuadrant) / 15;

  const sinDec = 0.39782 * sinD(trueLong);
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosHour = (cosD(zenith) - sinDec * sinD(lat)) / (cosDec * cosD(lat));
  if (cosHour > 1 || cosHour < -1) return null; // polar day/night

  let hour = sunrise ? 360 - toDeg(Math.acos(cosHour)) : toDeg(Math.acos(cosHour));
  hour /= 15;
  const localMeanTime = hour + rightAscension - 0.06571 * t - 6.622;
  return mod(localMeanTime - lngHour, 24);
}

// --- coordinate resolution: gsettings → GeoClue → timezone fallback ----------

function run(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function validCoords(lat: number, lon: number): Coordinates | null {
  if (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  ) {
    return { lat, lon };
  }
  return null; // rejects GNOME's (91, 181) "unset" sentinel
}

/** GNOME Night Light's last resolved coordinates. */
export function getGsettingsCoordinates(): Coordinates | null {
  const raw = run('gsettings', [
    'get',
    'org.gnome.settings-daemon.plugins.color',
    'night-light-last-coordinates',
  ]);
  if (!raw) return null;
  const m = raw.match(/\(?\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)?/);
  if (!m) return null;
  return validCoords(Number.parseFloat(m[1]!), Number.parseFloat(m[2]!));
}

/**
 * GeoClue2 over `gdbus`, best-effort. Creates a client, starts it, and polls
 * the Location object for lat/lon. Any failure (no GeoClue, no permission,
 * timeout) returns null and we fall through to the timezone table.
 */
export function getGeoclueCoordinates(): Coordinates | null {
  const D = 'org.freedesktop.GeoClue2';
  const call = (objectPath: string, method: string, args = '()'): string | null =>
    run('gdbus', [
      'call',
      '--system',
      '--dest',
      D,
      '--object-path',
      objectPath,
      '--method',
      method,
      ...(args === '()' ? [] : [args]),
    ]);

  const clientReply = call('/org/freedesktop/GeoClue2/Manager', `${D}.Manager.GetClient`);
  const clientPath = clientReply?.match(/objectpath '([^']+)'/)?.[1];
  if (!clientPath) return null;

  const setProp = (name: string, variant: string): void => {
    run('gdbus', [
      'call',
      '--system',
      '--dest',
      D,
      '--object-path',
      clientPath,
      '--method',
      'org.freedesktop.DBus.Properties.Set',
      `${D}.Client`,
      name,
      variant,
    ]);
  };
  setProp('DesktopId', "<'org.gnome.Settings'>");
  setProp('RequestedAccuracyLevel', '<uint32 4>');
  call(clientPath, `${D}.Client.Start`);

  let locationPath: string | null = null;
  for (let i = 0; i < 10; i++) {
    const reply = run('gdbus', [
      'call',
      '--system',
      '--dest',
      D,
      '--object-path',
      clientPath,
      '--method',
      'org.freedesktop.DBus.Properties.Get',
      `${D}.Client`,
      'Location',
    ]);
    const p =
      reply?.match(/objectpath '([^']+)'/)?.[1] ??
      reply?.match(/'(\/org\/freedesktop\/GeoClue2\/[^']+)'/)?.[1];
    if (p && p !== '/') {
      locationPath = p;
      break;
    }
    // brief bounded wait between polls without pulling in async
    sleepSync(300);
  }
  if (!locationPath) return null;

  const getNum = (name: string): number => {
    const reply = run('gdbus', [
      'call',
      '--system',
      '--dest',
      D,
      '--object-path',
      locationPath!,
      '--method',
      'org.freedesktop.DBus.Properties.Get',
      `${D}.Location`,
      name,
    ]);
    return Number.parseFloat(reply?.match(/-?\d+(?:\.\d+)?/)?.[0] ?? 'NaN');
  };
  return validCoords(getNum('Latitude'), getNum('Longitude'));
}

/**
 * Timezone → approximate coordinate table. Keyed by IANA zone; values are the
 * zone's representative city. Not exhaustive, but covers the common zones so a
 * fresh install without GeoClue still schedules sensibly.
 */
const TIMEZONE_COORDINATE_FALLBACKS: Record<string, Coordinates> = {
  'America/Los_Angeles': { lat: 34.0522, lon: -118.2437 },
  'America/Denver': { lat: 39.7392, lon: -104.9903 },
  'America/Phoenix': { lat: 33.4484, lon: -112.074 },
  'America/Chicago': { lat: 41.8781, lon: -87.6298 },
  'America/New_York': { lat: 40.7128, lon: -74.006 },
  'America/Toronto': { lat: 43.6532, lon: -79.3832 },
  'America/Vancouver': { lat: 49.2827, lon: -123.1207 },
  'America/Mexico_City': { lat: 19.4326, lon: -99.1332 },
  'America/Sao_Paulo': { lat: -23.5505, lon: -46.6333 },
  'America/Bogota': { lat: 4.711, lon: -74.0721 },
  'America/Argentina/Buenos_Aires': { lat: -34.6037, lon: -58.3816 },
  'Europe/London': { lat: 51.5074, lon: -0.1278 },
  'Europe/Dublin': { lat: 53.3498, lon: -6.2603 },
  'Europe/Paris': { lat: 48.8566, lon: 2.3522 },
  'Europe/Madrid': { lat: 40.4168, lon: -3.7038 },
  'Europe/Berlin': { lat: 52.52, lon: 13.405 },
  'Europe/Amsterdam': { lat: 52.3676, lon: 4.9041 },
  'Europe/Rome': { lat: 41.9028, lon: 12.4964 },
  'Europe/Stockholm': { lat: 59.3293, lon: 18.0686 },
  'Europe/Warsaw': { lat: 52.2297, lon: 21.0122 },
  'Europe/Moscow': { lat: 55.7558, lon: 37.6173 },
  'Africa/Cairo': { lat: 30.0444, lon: 31.2357 },
  'Africa/Lagos': { lat: 6.5244, lon: 3.3792 },
  'Africa/Johannesburg': { lat: -26.2041, lon: 28.0473 },
  'Asia/Dubai': { lat: 25.2048, lon: 55.2708 },
  'Asia/Kolkata': { lat: 22.5726, lon: 88.3639 },
  'Asia/Bangkok': { lat: 13.7563, lon: 100.5018 },
  'Asia/Singapore': { lat: 1.3521, lon: 103.8198 },
  'Asia/Shanghai': { lat: 31.2304, lon: 121.4737 },
  'Asia/Hong_Kong': { lat: 22.3193, lon: 114.1694 },
  'Asia/Tokyo': { lat: 35.6762, lon: 139.6503 },
  'Asia/Seoul': { lat: 37.5665, lon: 126.978 },
  'Australia/Sydney': { lat: -33.8688, lon: 151.2093 },
  'Australia/Perth': { lat: -31.9523, lon: 115.8613 },
  'Pacific/Auckland': { lat: -36.8485, lon: 174.7633 },
};

export function getTimezoneFallbackCoordinates(): Coordinates | null {
  const tz = run('timedatectl', ['show', '-p', 'Timezone', '--value']);
  if (!tz) return null;
  return TIMEZONE_COORDINATE_FALLBACKS[tz] ?? null;
}

/** Resolve a coordinate using the GNOME-first chain. Null if nothing usable. */
export function resolveCoordinates(): Coordinates | null {
  return getGsettingsCoordinates() ?? getGeoclueCoordinates() ?? getTimezoneFallbackCoordinates();
}

/**
 * Sunrise / solar-noon / sunset as absolute instants for `date`'s calendar day
 * (UTC), at the given coordinate. Solar noon is the midpoint of sunrise and
 * sunset. Returns null on polar day/night.
 */
export function sunTimes(date: Date, coords: Coordinates): SunTimes | null {
  const sr = solarUtcHour(date, coords.lat, coords.lon, true);
  const ss = solarUtcHour(date, coords.lat, coords.lon, false);
  if (sr === null || ss === null) return null;

  const atUtcHour = (h: number): Date => {
    const base = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    return new Date(base + h * 3_600_000);
  };
  // If sunset's hour-of-day wraps before sunrise's (high longitudes), push it a day.
  const sunset = ss >= sr ? atUtcHour(ss) : new Date(atUtcHour(ss).getTime() + 86_400_000);
  const sunrise = atUtcHour(sr);
  const noon = new Date((sunrise.getTime() + sunset.getTime()) / 2);
  return { sunrise, noon, sunset };
}
