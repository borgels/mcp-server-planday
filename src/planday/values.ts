/**
 * Value rules shared by tool schemas, handlers and the change resolution.
 *
 * Planday ids are 64-bit integers in the Open API (`int64` in the published
 * OpenAPI documents, e.g. https://openapi.planday.com/hr/swagger/v1.0/swagger.json);
 * dates are `YYYY-MM-DD`, times `HH:MM`.
 */

export function isRecordId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** A calendar date written YYYY-MM-DD that exists. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** A time of day written HH:MM (24-hour). */
export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isTime(value: unknown): value is string {
  return typeof value === 'string' && TIME_PATTERN.test(value);
}

/** Whole days from `from` to `to` (both YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** A local date and time written YYYY-MM-DDTHH:MM (24-hour, no offset), on a date that exists. */
export function isLocalDateTime(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(value) && isIsoDate(value.slice(0, 10));
}
