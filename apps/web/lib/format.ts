/** Display formatting. Turkish locale, because everything the team reads is. */

const DATE = new Intl.DateTimeFormat("tr-TR", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

const DATE_TIME = new Intl.DateTimeFormat("tr-TR", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  return DATE.format(new Date(value));
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  return DATE_TIME.format(new Date(value));
}

/**
 * Money arrives as a decimal string and stays one until the last moment.
 *
 * Number() here is for grouping digits only, and it happens after the value has
 * already been rounded to two places by the API. Parsing earlier -- in the
 * client, in a total, anywhere a second arithmetic step could follow -- is how
 * a budget loses a kurus.
 */
export function formatMoney(value: string | null | undefined): string {
  if (value === null || value === undefined) return "—";

  const amount = Number(value);
  if (!Number.isFinite(amount)) return value;

  return new Intl.NumberFormat("tr-TR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount) + " TL";
}

/** "yyyy-mm-dd" for a date input, which refuses anything else. */
export function toDateInput(value: string | Date | null | undefined): string {
  if (!value) return "";
  return new Date(value).toISOString().slice(0, 10);
}

const MONTH = new Intl.DateTimeFormat("tr-TR", { month: "short", year: "numeric" });
const MONTH_LONG = new Intl.DateTimeFormat("tr-TR", { month: "long", year: "numeric" });

/**
 * "Oca 2026" from either a Date or the "2026-01" key the finance API groups by.
 *
 * The bare key is parsed as the first of the month in local time rather than
 * through `new Date("2026-01")`, which JavaScript reads as UTC midnight -- east
 * of Greenwich that is still December, and the axis would be a month out.
 */
export function monthLabel(value: string | Date, long = false): string {
  const date =
    typeof value === "string"
      ? new Date(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, 1)
      : value;

  return (long ? MONTH_LONG : MONTH).format(date);
}
