import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { logWarn } from "../logger.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { canonicalizeBase64, estimateBase64DecodedBytes } from "./base64.js";
import { convertHeicToJpeg } from "./image-ops.js";
import {
  DEFAULT_INPUT_FILE_MAX_BYTES,
  DEFAULT_INPUT_FILE_MAX_CHARS,
  DEFAULT_INPUT_FILE_MIMES,
  DEFAULT_INPUT_IMAGE_MAX_BYTES,
  DEFAULT_INPUT_IMAGE_MIMES,
  DEFAULT_INPUT_MAX_REDIRECTS,
  DEFAULT_INPUT_PDF_MAX_PAGES,
  DEFAULT_INPUT_PDF_MAX_PIXELS,
  DEFAULT_INPUT_PDF_MIN_TEXT_CHARS,
  DEFAULT_INPUT_TIMEOUT_MS,
  normalizeMimeList,
  parseContentType,
  resolveInputFileLimits,
} from "./input-files-config.js";
import type {
  InputFileLimits,
  InputFileLimitsConfig,
  InputImageLimits,
  InputPdfLimits,
} from "./input-files-config.js";
import { detectMime } from "./mime.js";
import { extractPdfContent, type PdfExtractedImage } from "./pdf-extract.js";
import { readResponseWithLimit } from "./read-response-with-limit.js";

export type InputImageContent = PdfExtractedImage;

export type InputFileExtractResult = {
  filename: string;
  text?: string;
  images?: InputImageContent[];
};

export type InputImageSource =
  | {
      type: "base64";
      data: string;
      mediaType?: string;
    }
  | {
      type: "url";
      url: string;
      mediaType?: string;
    };

export type InputFileSource =
  | {
      type: "base64";
      data: string;
      mediaType?: string;
      filename?: string;
    }
  | {
      type: "url";
      url: string;
      mediaType?: string;
      filename?: string;
    };

export type InputFetchResult = {
  buffer: Buffer;
  mimeType: string;
  contentType?: string;
};

export type {
  InputFileLimits,
  InputFileLimitsConfig,
  InputImageLimits,
  InputPdfLimits,
} from "./input-files-config.js";
export {
  DEFAULT_INPUT_FILE_MAX_BYTES,
  DEFAULT_INPUT_FILE_MAX_CHARS,
  DEFAULT_INPUT_FILE_MIMES,
  DEFAULT_INPUT_IMAGE_MAX_BYTES,
  DEFAULT_INPUT_IMAGE_MIMES,
  DEFAULT_INPUT_MAX_REDIRECTS,
  DEFAULT_INPUT_PDF_MAX_PAGES,
  DEFAULT_INPUT_PDF_MAX_PIXELS,
  DEFAULT_INPUT_PDF_MIN_TEXT_CHARS,
  DEFAULT_INPUT_TIMEOUT_MS,
  normalizeMimeList,
  parseContentType,
  resolveInputFileLimits,
} from "./input-files-config.js";
const NORMALIZED_INPUT_IMAGE_MIME = "image/jpeg";
const HEIC_INPUT_IMAGE_MIMES = new Set(["image/heic", "image/heif"]);

function rejectOversizedBase64Payload(params: {
  data: string;
  maxBytes: number;
  label: "Image" | "File";
}): void {
  const estimated = estimateBase64DecodedBytes(params.data);
  if (estimated > params.maxBytes) {
    throw new Error(
      `${params.label} too large: ${estimated} bytes (limit: ${params.maxBytes} bytes)`,
    );
  }
}

export function normalizeMimeType(value: string | undefined): string | undefined {
  const [raw] = value?.split(";") ?? [];
  return normalizeOptionalLowercaseString(raw);
}

export async function fetchWithGuard(params: {
  url: string;
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
  policy?: SsrFPolicy;
  auditContext?: string;
}): Promise<InputFetchResult> {
  const { response, release } = await fetchWithSsrFGuard({
    url: params.url,
    maxRedirects: params.maxRedirects,
    timeoutMs: params.timeoutMs,
    policy: params.policy,
    auditContext: params.auditContext,
    init: { headers: { "User-Agent": "OpenClaw-Gateway/1.0" } },
  });

  try {
    if (!response.ok) {
      throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength) {
      const size = Number(contentLength);
      if (Number.isFinite(size) && size > params.maxBytes) {
        throw new Error(`Content too large: ${size} bytes (limit: ${params.maxBytes} bytes)`);
      }
    }

    const buffer = await readResponseWithLimit(response, params.maxBytes);

    const contentType = response.headers.get("content-type") || undefined;
    const parsed = parseContentType(contentType);
    const mimeType = parsed.mimeType ?? "application/octet-stream";
    return { buffer, mimeType, contentType };
  } finally {
    await release();
  }
}

function decodeTextContent(buffer: Buffer, charset: string | undefined): string {
  const encoding = normalizeOptionalLowercaseString(charset) || "utf-8";
  try {
    return new TextDecoder(encoding).decode(buffer);
  } catch {
    return new TextDecoder("utf-8").decode(buffer);
  }
}

function clampText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars);
}

async function normalizeInputImage(params: {
  buffer: Buffer;
  mimeType?: string;
  limits: InputImageLimits;
}): Promise<InputImageContent> {
  const declaredMime = normalizeMimeType(params.mimeType) ?? "application/octet-stream";
  const detectedMime = normalizeMimeType(
    await detectMime({ buffer: params.buffer, headerMime: params.mimeType }),
  );
  if (declaredMime.startsWith("image/") && detectedMime && !detectedMime.startsWith("image/")) {
    throw new Error(`Unsupported image MIME type: ${detectedMime}`);
  }
  const sourceMime =
    (detectedMime && HEIC_INPUT_IMAGE_MIMES.has(detectedMime)) ||
    (HEIC_INPUT_IMAGE_MIMES.has(declaredMime) && !detectedMime)
      ? (detectedMime ?? declaredMime)
      : declaredMime;
  if (!params.limits.allowedMimes.has(sourceMime)) {
    throw new Error(`Unsupported image MIME type: ${sourceMime}`);
  }

  if (!HEIC_INPUT_IMAGE_MIMES.has(sourceMime)) {
    return {
      type: "image",
      data: params.buffer.toString("base64"),
      mimeType: sourceMime,
    };
  }

  const normalizedBuffer = await convertHeicToJpeg(params.buffer);
  if (normalizedBuffer.byteLength > params.limits.maxBytes) {
    throw new Error(
      `Image too large after HEIC conversion: ${normalizedBuffer.byteLength} bytes (limit: ${params.limits.maxBytes} bytes)`,
    );
  }
  return {
    type: "image",
    data: normalizedBuffer.toString("base64"),
    mimeType: NORMALIZED_INPUT_IMAGE_MIME,
  };
}

export async function extractImageContentFromSource(
  source: InputImageSource,
  limits: InputImageLimits,
): Promise<InputImageContent> {
  if (source.type === "base64") {
    rejectOversizedBase64Payload({ data: source.data, maxBytes: limits.maxBytes, label: "Image" });
    const canonicalData = canonicalizeBase64(source.data);
    if (!canonicalData) {
      throw new Error("input_image base64 source has invalid 'data' field");
    }
    const buffer = Buffer.from(canonicalData, "base64");
    if (buffer.byteLength > limits.maxBytes) {
      throw new Error(
        `Image too large: ${buffer.byteLength} bytes (limit: ${limits.maxBytes} bytes)`,
      );
    }
    return await normalizeInputImage({
      buffer,
      mimeType: normalizeMimeType(source.mediaType) ?? "image/png",
      limits,
    });
  }

  if (source.type === "url") {
    if (!limits.allowUrl) {
      throw new Error("input_image URL sources are disabled by config");
    }
    const result = await fetchWithGuard({
      url: source.url,
      maxBytes: limits.maxBytes,
      timeoutMs: limits.timeoutMs,
      maxRedirects: limits.maxRedirects,
      policy: {
        allowPrivateNetwork: false,
        hostnameAllowlist: limits.urlAllowlist,
      },
      auditContext: "openresponses.input_image",
    });
    return await normalizeInputImage({
      buffer: result.buffer,
      mimeType: result.mimeType,
      limits,
    });
  }

  throw new Error(`Unsupported input_image source type: ${(source as { type: string }).type}`);
}

export async function extractFileContentFromSource(params: {
  source: InputFileSource;
  limits: InputFileLimits;
}): Promise<InputFileExtractResult> {
  const { source, limits } = params;
  const filename = source.filename || "file";

  let buffer: Buffer;
  let mimeType: string | undefined;
  let charset: string | undefined;

  if (source.type === "base64") {
    rejectOversizedBase64Payload({ data: source.data, maxBytes: limits.maxBytes, label: "File" });
    const canonicalData = canonicalizeBase64(source.data);
    if (!canonicalData) {
      throw new Error("input_file base64 source has invalid 'data' field");
    }
    const parsed = parseContentType(source.mediaType);
    mimeType = parsed.mimeType;
    charset = parsed.charset;
    buffer = Buffer.from(canonicalData, "base64");
  } else {
    if (!limits.allowUrl) {
      throw new Error("input_file URL sources are disabled by config");
    }
    const result = await fetchWithGuard({
      url: source.url,
      maxBytes: limits.maxBytes,
      timeoutMs: limits.timeoutMs,
      maxRedirects: limits.maxRedirects,
      policy: {
        allowPrivateNetwork: false,
        hostnameAllowlist: limits.urlAllowlist,
      },
      auditContext: "openresponses.input_file",
    });
    const parsed = parseContentType(result.contentType);
    mimeType = parsed.mimeType ?? normalizeMimeType(result.mimeType);
    charset = parsed.charset;
    buffer = result.buffer;
  }

  if (buffer.byteLength > limits.maxBytes) {
    throw new Error(`File too large: ${buffer.byteLength} bytes (limit: ${limits.maxBytes} bytes)`);
  }

  if (!mimeType) {
    throw new Error("input_file missing media type");
  }
  if (!limits.allowedMimes.has(mimeType)) {
    throw new Error(`Unsupported file MIME type: ${mimeType}`);
  }

  if (mimeType === "application/pdf") {
    const extracted = await extractPdfContent({
      buffer,
      maxPages: limits.pdf.maxPages,
      maxPixels: limits.pdf.maxPixels,
      minTextChars: limits.pdf.minTextChars,
      onImageExtractionError: (err) => {
        logWarn(`media: PDF image extraction skipped, ${String(err)}`);
      },
    });
    const text = extracted.text ? clampText(extracted.text, limits.maxChars) : "";
    return {
      filename,
      text,
      images: extracted.images.length > 0 ? extracted.images : undefined,
    };
  }

  const text = clampText(decodeTextContent(buffer, charset), limits.maxChars);
  return { filename, text };
}
