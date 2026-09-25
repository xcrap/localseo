import Papa from "papaparse";
import { badRequest } from "./errors";

// Shared CSV helpers for every import (keyword metrics, organic research,
// backlinks, Search Console). Tool exports differ in header spelling, locale,
// and number formatting, so all imports read cells through these helpers.

export type CsvRow = Map<string, unknown>;

export function parseCsvRows(csv: string, label: string) {
  const parsed = Papa.parse<Record<string, unknown>>(csv.replace(/^﻿/, ""), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (header) => header.trim(),
  });
  // Papa also reports an undetectable delimiter (a one-column list) and rows
  // with a missing/extra trailing cell. Those rows are still usable; only broken
  // quoting means cell boundaries cannot be trusted.
  const fatal = parsed.errors.find((error) => error.type === "Quotes");
  if (fatal) {
    const row = typeof fatal.row === "number" ? ` (row ${fatal.row + 1})` : "";
    throw badRequest(`${label} could not be parsed: ${fatal.message}${row}`);
  }
  return {
    fields: (parsed.meta.fields || []).filter(Boolean),
    rows: parsed.data.filter((row) => Object.values(row).some((value) => String(value ?? "").trim())),
  };
}

export function normalizeCsvHeader(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function csvRow(row: Record<string, unknown>): CsvRow {
  const normalized = new Map<string, unknown>();
  for (const [key, value] of Object.entries(row)) {
    normalized.set(normalizeCsvHeader(key), value);
  }
  return normalized;
}

export function csvHasColumn(row: CsvRow, aliases: string[]) {
  return aliases.some((alias) => row.has(normalizeCsvHeader(alias)));
}

export function csvText(row: CsvRow, aliases: string[]) {
  for (const alias of aliases) {
    const text = String(row.get(normalizeCsvHeader(alias)) ?? "").replace(/\s+/g, " ").trim();
    if (text) return text;
  }
  return "";
}

export function csvNumber(row: CsvRow, aliases: string[]) {
  return parseCsvNumber(csvText(row, aliases));
}

const currencyPattern = /R\$|[$€£¥₹]|USD|EUR|GBP|BRL|CAD|AUD|CHF|JPY|INR/gi;
const suffixMultipliers: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };

// Parses one exported number cell. Returns null instead of guessing when the
// cell is empty, a placeholder ("n/a", "-"), a bucket ("1K – 10K", "<10"), or
// text that merely contains digits ("Lost 2024-03-01").
//
// Separators: when both "," and "." appear, the last one is the decimal mark
// ("1.234,56", "1,234.56"). A repeated separator is thousands grouping
// ("1.234.567"). A single separator followed by exactly three digits after a
// non-zero 1–3 digit integer reads as thousands ("1,200", "1.200" → 1200);
// anything else reads as a decimal ("0,45" → 0.45, "3.25", "1,5"). Values with
// a K/M/B suffix always read the separator as a decimal ("1.2K" → 1200).
// Percent signs and currency symbols/codes are dropped: "45%" → 45, "$3.25" → 3.25.
export function parseCsvNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (/^[<>≤≥~]/.test(raw) || /\d\s*[kmb%]?\s*(?:[-–—~]|to)\s*[$€£]?\s*\d/i.test(raw)) return null;
  const text = raw.replace(currencyPattern, "").replace(/[\s  ']/g, "");
  const match = /^([+-]?)([\d.,]*\d[\d.,]*)([kmb])?%?$/i.exec(text);
  if (!match) return null;
  const [, sign, body, suffix] = match;
  const normalized = normalizeSeparators(body, Boolean(suffix));
  if (normalized === null) return null;
  const number = Number(normalized);
  if (!Number.isFinite(number)) return null;
  const scaled = suffix ? Number((number * suffixMultipliers[suffix.toLowerCase()]).toPrecision(12)) : number;
  return sign === "-" ? -scaled : scaled;
}

function normalizeSeparators(body: string, hasSuffix: boolean) {
  const lastDot = body.lastIndexOf(".");
  const lastComma = body.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = lastDot > lastComma ? "." : ",";
    const [integer, fraction, ...rest] = body.replaceAll(decimal === "." ? "," : ".", "").split(decimal);
    return rest.length ? null : `${integer}.${fraction}`;
  }
  const separator = lastDot >= 0 ? "." : lastComma >= 0 ? "," : "";
  if (!separator) return body;
  const parts = body.split(separator);
  if (parts.length > 2) {
    return parts.slice(1).every((part) => part.length === 3) && parts[0].length <= 3 ? parts.join("") : null;
  }
  const [integer, fraction] = parts;
  if (!hasSuffix && fraction.length === 3 && /^[1-9]\d{0,2}$/.test(integer)) return `${integer}${fraction}`;
  return `${integer || "0"}.${fraction}`;
}
