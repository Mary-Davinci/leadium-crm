/** Instants stay in UTC in the API/database; the CRM calendar always uses Italian time. */
export const BUSINESS_TIME_ZONE = "Europe/Rome";
const partsFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
});
function parts(value: Date | string | number) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Data non valida.");
  const result: Record<string, string> = {};
  for (const part of partsFormatter.formatToParts(date)) result[part.type] = part.value;
  return result;
}
export function romeDateTimeInput(value: Date | string | number = new Date()) {
  const p = parts(value);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
/** Calendar-day key, not the instant of midnight. Differences are safe across DST changes. */
export function romeDayStamp(value: Date | string | number = new Date()) {
  if (!Number.isFinite(new Date(value).getTime())) return NaN;
  const p = parts(value);
  return Date.UTC(+p.year, +p.month - 1, +p.day);
}
/** Resolve a wall-clock input in Rome, independently of the operator's device timezone.
 * A skipped spring hour is rejected; an ambiguous autumn hour uses its first occurrence. */
export function romeInputToIso(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) throw new Error("Inserisci data e ora valide (fuso orario di Roma).");
  const [, y, m, d, h, min, sec = "00"] = match;
  const wall = Date.UTC(+y, +m - 1, +d, +h, +min, +sec);
  const offsets = new Set<number>();
  for (const delta of [-36, 0, 36]) {
    const instant = wall + delta * 3600000;
    const p = parts(instant);
    offsets.add(Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - instant);
  }
  const candidates = [...offsets].map(offset => wall - offset).filter(instant => {
    const p = parts(instant);
    return p.year === y && p.month === m && p.day === d && p.hour === h && p.minute === min && p.second === sec;
  }).sort((a, b) => a - b);
  if (!candidates.length) throw new Error("Questo orario non esiste nel fuso di Roma (cambio ora legale), oppure la data non e valida. Scegli un altro orario.");
  return new Date(candidates[0]).toISOString();
}
export function romeCalendarDate(value: Date | string | number, days = 0, hour?: number, minute = 0) {
  const p = parts(value);
  const day = new Date(Date.UTC(+p.year, +p.month - 1, +p.day + days)).toISOString().slice(0, 10);
  const local = `${day}T${hour === undefined ? `${p.hour}:${p.minute}:${p.second}` : `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`}`;
  try { return new Date(romeInputToIso(local)); }
  catch (error) {
    // A calendar snooze into the skipped spring hour moves forward by one hour.
    // Explicit user inputs still go through romeInputToIso and get a validation error.
    if (hour !== undefined) throw error;
    const shiftedWall = new Date(Date.parse(local + "Z") + 3600000).toISOString().slice(0, 19);
    return new Date(romeInputToIso(shiftedWall));
  }
}
