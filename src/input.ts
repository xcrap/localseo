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

// Optional choice from a fixed list: the fallback when absent, a 400 otherwise.
export function optionalChoice<T extends string>(value: unknown, name: string, choices: readonly T[], fallback: T): T {
  if (value === undefined || value === null || value === "") return fallback;
  if (!choices.includes(value as T)) throw badRequest(`${name} must be one of: ${choices.join(", ")}.`);
  return value as T;
}
