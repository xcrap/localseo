import { badRequest } from "./errors";

// Optional whole number from a query string, JSON body, or MCP argument:
// the fallback when absent, a 400 when present but out of range.
export function optionalInt(value: unknown, name: string, fallback: number, min: number, max: number) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw badRequest(`${name} must be a whole number from ${min} to ${max}.`);
  }
  return number;
}

// A calendar date (YYYY-MM-DD) that exists: 2026-02-31 or 2026-13-01 is a 400,
// not a date JavaScript would silently roll over into the next month.
export function requireDate(value: unknown, field: string) {
  const text = typeof value === "string" ? value.trim() : "";
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw badRequest(`${field} must be a real date like 2026-01-31.`);
  }
  return text;
}

// Optional choice from a fixed list: the fallback when absent, a 400 otherwise.
export function optionalChoice<T extends string>(value: unknown, name: string, choices: readonly T[], fallback: T): T {
  if (value === undefined || value === null || value === "") return fallback;
  if (!choices.includes(value as T)) throw badRequest(`${name} must be one of: ${choices.join(", ")}.`);
  return value as T;
}
