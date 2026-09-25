import { gunzipSync } from "node:zlib";
import { localFetchTls } from "./site-scan-url";

// Read at most this many bytes of a response body. Real HTML pages are far
// smaller; the cap stops a linked PDF/ZIP/video from being buffered into memory.
const MAX_BODY_BYTES = 5 * 1024 * 1024;

export type RedirectHop = {
  url: string;
  status: number;
  location: string;
  targetUrl: string;
};

const redirectStatuses = new Set([301, 302, 303, 307, 308]);

// stopBefore: a redirect whose target it accepts is not followed; the trace
// ends with that target as finalUrl and `stoppedBefore` set, so the caller can
// reuse a response it already has for that exact URL.
export async function fetchWithRedirectTrace(
  url: string,
  init: RequestInit = {},
  maxRedirects = 128,
  stopBefore?: (targetUrl: string) => boolean,
) {
  let currentUrl = url;
  const redirectChain: RedirectHop[] = [];
  const seen = new Set([currentUrl]);

  while (true) {
    const response = await fetch(currentUrl, {
      ...init,
      redirect: "manual",
      ...localFetchTls(currentUrl),
    });
    const location = response.headers.get("location") || "";
    if (!redirectStatuses.has(response.status) || !location) {
      return {
        response,
        finalUrl: response.url || currentUrl,
        originalStatus: redirectChain[0]?.status ?? response.status,
        finalStatus: response.status,
        redirected: redirectChain.length > 0,
        redirectChain,
        redirectLoop: false,
        redirectError: "",
      };
    }

    let targetUrl = "";
    try {
      targetUrl = new URL(location, response.url || currentUrl).toString();
    } catch {
      redirectChain.push({
        url: response.url || currentUrl,
        status: response.status,
        location,
        targetUrl: "",
      });
      return {
        response,
        finalUrl: response.url || currentUrl,
        originalStatus: redirectChain[0]?.status ?? response.status,
        finalStatus: response.status,
        redirected: true,
        redirectChain,
        redirectLoop: false,
        redirectError: "Redirect location is invalid.",
      };
    }

    redirectChain.push({
      url: response.url || currentUrl,
      status: response.status,
      location,
      targetUrl,
    });
    // Browsers and crawlers only follow redirects to web URLs; never let a
    // Location header point the crawler at file:, data:, or other schemes.
    const targetProtocol = new URL(targetUrl).protocol;
    if (targetProtocol !== "http:" && targetProtocol !== "https:") {
      await response.body?.cancel().catch(() => undefined);
      return {
        response,
        finalUrl: response.url || currentUrl,
        originalStatus: redirectChain[0]?.status ?? response.status,
        finalStatus: response.status,
        redirected: true,
        redirectChain,
        redirectLoop: false,
        redirectError: `Redirect points to an unsupported ${targetProtocol} URL.`,
      };
    }
    if (seen.has(targetUrl)) {
      return {
        response,
        finalUrl: response.url || currentUrl,
        originalStatus: redirectChain[0]?.status ?? response.status,
        finalStatus: response.status,
        redirected: true,
        redirectChain,
        redirectLoop: true,
        redirectError: "Redirect loop detected.",
      };
    }
    if (redirectChain.length > maxRedirects) {
      return {
        response,
        finalUrl: response.url || currentUrl,
        originalStatus: redirectChain[0]?.status ?? response.status,
        finalStatus: response.status,
        redirected: true,
        redirectChain,
        redirectLoop: false,
        redirectError: `Redirect chain exceeds ${maxRedirects} hops.`,
      };
    }

    await response.body?.cancel().catch(() => undefined);
    if (stopBefore?.(targetUrl)) {
      return {
        response,
        finalUrl: targetUrl,
        originalStatus: redirectChain[0].status,
        finalStatus: response.status,
        redirected: true,
        redirectChain,
        redirectLoop: false,
        redirectError: "",
        stoppedBefore: targetUrl,
      };
    }
    seen.add(targetUrl);
    currentUrl = targetUrl;
  }
}

// A final response the caller already holds for an exact URL.
export type KnownResponse = {
  status: number;
  contentType: string;
  contentLength: number | null;
  contentEncoding: string;
  xRobotsTag: string;
};

function charsetFromContentType(contentType: string) {
  const match = /charset=([^;]+)/i.exec(contentType || "");
  return match ? match[1].trim().replace(/["']/g, "").toLowerCase() : "";
}

async function readCappedBody(response: Response, maxBytes: number) {
  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    return { bytes: buffer.slice(0, maxBytes), truncated: buffer.length > maxBytes };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.length;
      }
      if (total > maxBytes) {
        truncated = true;
        break;
      }
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  const merged = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= merged.length) break;
    const slice = chunk.subarray(0, merged.length - offset);
    merged.set(slice, offset);
    offset += slice.length;
  }
  return { bytes: merged, truncated };
}

// Gzip files served without Content-Encoding (e.g. sitemap.xml.gz) arrive as
// raw gzip bytes. Decompress them with the same size cap as plain bodies.
function gunzipBody(bytes: Uint8Array, maxBytes: number) {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return { bytes, truncated: false };
  try {
    return { bytes: new Uint8Array(gunzipSync(bytes, { maxOutputLength: maxBytes })), truncated: false };
  } catch (error) {
    if ((error as any)?.code === "ERR_BUFFER_TOO_LARGE") return { bytes: new Uint8Array(), truncated: true };
    throw new Error("Gzip body could not be decompressed.");
  }
}

function decodeBody(bytes: Uint8Array, contentType: string) {
  // Prefer the declared charset; fall back to a meta charset for HTML that
  // omits it in the header, then UTF-8. Guards against mojibake on legacy sites.
  let charset = charsetFromContentType(contentType);
  if (!charset) {
    const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 2048));
    const metaMatch = /<meta[^>]+charset=["']?\s*([\w-]+)/i.exec(head);
    if (metaMatch) charset = metaMatch[1].toLowerCase();
  }
  try {
    return new TextDecoder(charset || "utf-8", { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

type FetchTextOptions = {
  // Abort the request early, e.g. when the user cancels a running scan.
  signal?: AbortSignal;
  maxBytes?: number;
  // A response already held for a redirect target: the redirect is recorded
  // but the target is not downloaded again (the result has reused: true and
  // an empty text).
  knownResponse?: (url: string) => KnownResponse | undefined;
};

export async function fetchText(url: string, timeoutMs = 15000, options: FetchTextOptions = {}) {
  const maxBytes = options.maxBytes ?? MAX_BODY_BYTES;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal;
  const knownResponse = options.knownResponse;
  const trace = await fetchWithRedirectTrace(
    url,
    {
      signal,
      headers: {
        "User-Agent": "LocalSEO/0.1 (+https://localhost)",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    },
    undefined,
    knownResponse ? (targetUrl) => Boolean(knownResponse(targetUrl)) : undefined,
  );
  const known = trace.stoppedBefore ? knownResponse?.(trace.stoppedBefore) : undefined;
  if (known) {
    return {
      ok: known.status < 400,
      status: trace.originalStatus,
      finalStatus: known.status,
      url: trace.finalUrl,
      redirected: true,
      redirectChain: trace.redirectChain,
      redirectLoop: false,
      redirectError: "",
      contentType: known.contentType,
      contentLength: known.contentLength,
      contentEncoding: known.contentEncoding,
      xRobotsTag: known.xRobotsTag,
      retryAfter: "",
      truncated: false,
      text: "",
      reused: true,
    };
  }
  const { response } = trace;
  const contentType = response.headers.get("content-type") || "";
  const raw = await readCappedBody(response, maxBytes);
  const body = raw.truncated ? raw : gunzipBody(raw.bytes, maxBytes);
  return {
    ok: response.ok && !trace.redirectError,
    status: trace.originalStatus,
    finalStatus: trace.finalStatus,
    url: trace.finalUrl,
    redirected: trace.redirected,
    redirectChain: trace.redirectChain,
    redirectLoop: trace.redirectLoop,
    redirectError: trace.redirectError,
    contentType,
    contentLength: Number(response.headers.get("content-length") || 0) || null,
    contentEncoding: response.headers.get("content-encoding") || "",
    xRobotsTag: response.headers.get("x-robots-tag") || "",
    retryAfter: response.headers.get("retry-after") || "",
    // True when the body exceeded maxBytes; text then holds only a prefix.
    truncated: body.truncated,
    text: decodeBody(body.bytes, contentType),
    reused: false,
  };
}

export async function fetchJson(url: string, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "LocalSEO/0.1 (+https://localhost)",
        Accept: "application/json,text/plain,*/*",
      },
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      url: response.url,
      data: text ? JSON.parse(text) : null,
    };
  } finally {
    clearTimeout(timeout);
  }
}
