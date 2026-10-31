// Apart from settings.ts: the interface needs these two in its first bundle, and
// everything the settings module imports would come along (rule P11).

/** The owner's time zone until changed in Settings. */
export const DEFAULT_TIME_ZONE = "America/Sao_Paulo";

/** IANA names are short ASCII paths ("America/Sao_Paulo", "Etc/GMT+3", "UTC"). */
const TIME_ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/;

/** True when the runtime's Intl knows the zone; a typo would otherwise throw on every formatted date. */
export function isTimeZone(value: string): boolean {
  if (value.length > 64 || !TIME_ZONE_SHAPE.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
