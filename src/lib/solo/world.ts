import { formatter } from "@/lib/presence/time";

/* The real world, for characters who live in it: the festival coming up and the
 * weather where the user is, so "it's pouring there, right?" and "Diwali's in
 * three days" can come up the way they would between friends.
 *
 * The weather needs a place, which the user gives (a city name, on the Account
 * screen) -- it is never read from the device. The coordinates stay on this
 * device; the model is only told the result ("29 degrees, light rain").
 * Weather comes from Open-Meteo, which needs no key.
 */

/* ------------------------------------------------------------- festivals */

type Festival = { on: string; name: string; /** Lunar and moon-sighted dates can be a day off. */ approx?: boolean; india?: boolean };

/* ponytail: a hand-kept table for the next year or so, from published calendars.
   Lunar dates (Diwali, Holi, Eid...) can be a day out, so they are marked approx and
   spoken of as "around". Extend each year; a computed calendar is the upgrade. */
export const FESTIVALS: Festival[] = [
  { on: "2026-10-29", name: "Karwa Chauth", approx: true, india: true },
  { on: "2026-10-31", name: "Halloween" },
  { on: "2026-11-06", name: "Dhanteras", approx: true, india: true },
  { on: "2026-11-08", name: "Diwali", approx: true, india: true },
  { on: "2026-11-11", name: "Bhai Dooj", approx: true, india: true },
  { on: "2026-12-24", name: "Christmas Eve" },
  { on: "2026-12-25", name: "Christmas" },
  { on: "2026-12-31", name: "New Year's Eve" },
  { on: "2027-01-01", name: "New Year's Day" },
  { on: "2027-01-13", name: "Lohri", approx: true, india: true },
  { on: "2027-01-14", name: "Makar Sankranti", approx: true, india: true },
  { on: "2027-01-26", name: "Republic Day", india: true },
  { on: "2027-02-14", name: "Valentine's Day" },
  { on: "2027-03-10", name: "Eid al-Fitr", approx: true },
  { on: "2027-03-22", name: "Holi", approx: true, india: true },
  { on: "2027-05-17", name: "Eid al-Adha", approx: true },
  { on: "2027-08-15", name: "Independence Day", india: true },
  { on: "2027-08-17", name: "Raksha Bandhan", approx: true, india: true },
  { on: "2027-09-04", name: "Ganesh Chaturthi", approx: true, india: true },
  { on: "2027-10-29", name: "Diwali", approx: true, india: true },
  { on: "2027-10-31", name: "Halloween" },
  { on: "2027-12-25", name: "Christmas" },
];

const DAY = 86_400_000;
/** The calendar day of `ts` where the user is, as a day number. */
function dayNumber(ts: number, tz?: string): number {
  const [y, m, d] = formatter("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ts)).split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY);
}
const isIndia = (tz?: string) => tz === "Asia/Kolkata" || tz === "Asia/Calcutta";

/** Festivals from yesterday to a week ahead, nearest first, as a sentence each. */
export function festivalsNear(now: number, tz?: string): string[] {
  const today = dayNumber(now, tz);
  return FESTIVALS
    .filter((f) => !f.india || isIndia(tz))
    .map((f) => ({ f, days: Math.round(Date.parse(`${f.on}T00:00:00Z`) / DAY) - today }))
    .filter(({ days }) => days >= -1 && days <= 7)
    .sort((a, b) => a.days - b.days)
    .slice(0, 2)
    .map(({ f, days }) => {
      const around = f.approx ? "around " : "";
      if (days === 0) return f.approx ? `${f.name} is today or very nearly` : `It is ${f.name} today`;
      if (days === -1) return `${f.name} was yesterday${f.approx ? ", more or less" : ""}`;
      return `${f.name} is ${around}${days === 1 ? "tomorrow" : `${days} days away`}`;
    });
}

/* --------------------------------------------------------------- weather */

/** Open-Meteo's weather codes, in words. */
export function describeWeather(code: number): string {
  if (code === 0) return "clear";
  if (code <= 2) return "mostly clear";
  if (code === 3) return "overcast";
  if (code === 45 || code === 48) return "foggy";
  if (code >= 51 && code <= 57) return "drizzling";
  if (code >= 61 && code <= 67) return code >= 65 ? "raining hard" : "raining";
  if (code >= 71 && code <= 77) return "snowing";
  if (code >= 80 && code <= 82) return "rain showers";
  if (code >= 95) return "thunderstorms";
  return "cloudy";
}

export type Place = { name: string; lat: number; lon: number };

/** A city name to a place, or null. */
export async function findPlace(name: string): Promise<Place | null> {
  try {
    const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&name=${encodeURIComponent(name.trim())}`);
    if (!res.ok) return null;
    const r = (await res.json()).results?.[0];
    if (!r || typeof r.latitude !== "number") return null;
    return { name: [r.name, r.admin1].filter((x: unknown) => typeof x === "string" && x).slice(0, 2).join(", ").slice(0, 80), lat: r.latitude, lon: r.longitude };
  } catch { return null; }
}

/* Weather barely changes in half an hour, and a turn should not wait on it. */
const cache = new Map<string, { at: number; text: string | null }>();

/** "29°C, light rain" for the place, or null if it cannot be had quickly. */
export async function weatherNow(place: Place, now = Date.now()): Promise<string | null> {
  const key = `${place.lat.toFixed(2)},${place.lon.toFixed(2)}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < 30 * 60_000) return hit.text;
  let text: string | null = null;
  try {
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}&current=temperature_2m,weather_code&timezone=auto`,
      { signal: AbortSignal.timeout(1500) }
    );
    const c = res.ok ? (await res.json()).current : null;
    if (c && typeof c.temperature_2m === "number") text = `${Math.round(c.temperature_2m)}°C, ${describeWeather(Number(c.weather_code))}`;
  } catch { /* no weather this turn */ }
  cache.set(key, { at: now, text });
  return text;
}

/** What goes to the model: the festival and the weather, in words. Null when there is nothing. */
export async function worldFor(place: Place | undefined, now: number, tz?: string): Promise<{ place?: string; weather?: string; festivals: string[] } | null> {
  const festivals = festivalsNear(now, tz);
  const weather = place ? await weatherNow(place, now) : null;
  if (!festivals.length && !weather) return null;
  return { ...(place && weather ? { place: place.name } : {}), ...(weather ? { weather } : {}), festivals };
}
