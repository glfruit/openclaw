import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";

export type InputPdfLimits = {
  maxPages: number;
  maxPixels: number;
  minTextChars: number;
};

export type InputFileLimits = {
  allowUrl: boolean;
  urlAllowlist?: string[];
  allowedMimes: Set<string>;
  maxBytes: number;
  maxChars: number;
  maxRedirects: number;
  timeoutMs: number;
  pdf: InputPdfLimits;
};

export type InputFileLimitsConfig = {
  allowUrl?: boolean;
  allowedMimes?: string[];
  maxBytes?: number;
  maxChars?: number;
  maxRedirects?: number;
  timeoutMs?: number;
  pdf?: {
    maxPages?: number;
    maxPixels?: number;
    minTextChars?: number;
  };
};

export type InputImageLimits = {
  allowUrl: boolean;
  urlAllowlist?: string[];
  allowedMimes: Set<string>;
  maxBytes: number;
  maxRedirects: number;
  timeoutMs: number;
};

export const DEFAULT_INPUT_IMAGE_MIMES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
];
export const DEFAULT_INPUT_FILE_MIMES = [
  "text/plain",
  "text/markdown",
  "text/html",
  "text/csv",
  "application/json",
  "application/pdf",
];
export const DEFAULT_INPUT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_INPUT_FILE_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_INPUT_FILE_MAX_CHARS = 60_000;
export const DEFAULT_INPUT_MAX_REDIRECTS = 3;
export const DEFAULT_INPUT_TIMEOUT_MS = 10_000;
export const DEFAULT_INPUT_PDF_MAX_PAGES = 4;
export const DEFAULT_INPUT_PDF_MAX_PIXELS = 4_000_000;
export const DEFAULT_INPUT_PDF_MIN_TEXT_CHARS = 200;

function normalizeMimeType(value: string | undefined): string | undefined {
  const [raw] = value?.split(";") ?? [];
  return normalizeOptionalLowercaseString(raw);
}

export function parseContentType(value: string | undefined): {
  mimeType?: string;
  charset?: string;
} {
  if (!value) {
    return {};
  }
  const parts = value.split(";").map((part) => part.trim());
  const mimeType = normalizeMimeType(parts[0]);
  const charset = parts
    .map((part) => normalizeOptionalString(part.match(/^charset=(.+)$/i)?.[1]))
    .find((part) => part && part.length > 0);
  return { mimeType, charset };
}

export function normalizeMimeList(values: string[] | undefined, fallback: string[]): Set<string> {
  const input = values && values.length > 0 ? values : fallback;
  return new Set(input.map((value) => normalizeMimeType(value)).filter(Boolean) as string[]);
}

export function resolveInputFileLimits(config?: InputFileLimitsConfig): InputFileLimits {
  return {
    allowUrl: config?.allowUrl ?? true,
    allowedMimes: normalizeMimeList(config?.allowedMimes, DEFAULT_INPUT_FILE_MIMES),
    maxBytes: config?.maxBytes ?? DEFAULT_INPUT_FILE_MAX_BYTES,
    maxChars: config?.maxChars ?? DEFAULT_INPUT_FILE_MAX_CHARS,
    maxRedirects: config?.maxRedirects ?? DEFAULT_INPUT_MAX_REDIRECTS,
    timeoutMs: config?.timeoutMs ?? DEFAULT_INPUT_TIMEOUT_MS,
    pdf: {
      maxPages: config?.pdf?.maxPages ?? DEFAULT_INPUT_PDF_MAX_PAGES,
      maxPixels: config?.pdf?.maxPixels ?? DEFAULT_INPUT_PDF_MAX_PIXELS,
      minTextChars: config?.pdf?.minTextChars ?? DEFAULT_INPUT_PDF_MIN_TEXT_CHARS,
    },
  };
}
