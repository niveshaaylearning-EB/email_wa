import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { formatDistanceToNowStrict } from "date-fns";

export const APP_TIMEZONE = "Asia/Kolkata";

type DateLike = Date | string | null | undefined;
const toDate = (d: Date | string) => (typeof d === "string" ? new Date(d) : d);

export function formatIST(date: DateLike, pattern = "dd MMM yyyy, hh:mm a"): string {
  if (!date) return "—";
  return formatInTimeZone(toDate(date), APP_TIMEZONE, pattern);
}

export function formatDateIST(date: DateLike): string {
  return formatIST(date, "dd MMM yyyy");
}

export function relativeTime(date: DateLike): string {
  if (!date) return "never";
  return `${formatDistanceToNowStrict(toDate(date))} ago`;
}

/** Convert an IST wall-clock "yyyy-MM-ddTHH:mm" (from a form input) to a UTC Date. */
export function istLocalToUtc(local: string): Date {
  return fromZonedTime(local, APP_TIMEZONE);
}

export function utcToIstLocalInput(date: Date): string {
  return formatInTimeZone(date, APP_TIMEZONE, "yyyy-MM-dd'T'HH:mm");
}

/** yyyy-MM-dd day key in IST, for daily aggregations. */
export function istDayKey(date: Date): string {
  return formatInTimeZone(date, APP_TIMEZONE, "yyyy-MM-dd");
}

export function istMonthKey(date: Date): string {
  return formatInTimeZone(date, APP_TIMEZONE, "yyyy-MM");
}

/** Date range covering the last `days` days up to now. */
export function lastDays(days: number): { from: Date; to: Date } {
  const to = new Date();
  return { from: new Date(to.getTime() - days * 86400_000), to };
}

export function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86400_000);
}
