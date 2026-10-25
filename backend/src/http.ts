export type ErrorDetails = Record<string, string | number | boolean | null>;

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: ErrorDetails | undefined;
  readonly retryAfter: number | undefined;
  readonly allow: string | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    options: { details?: ErrorDetails; retryAfter?: number; allow?: string } = {},
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = options.details;
    this.retryAfter = options.retryAfter;
    this.allow = options.allow;
  }
}

export function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

export function errorBody(error: HttpError, requestId: string): unknown {
  return {
    error: {
      code: error.code,
      message: error.message,
      requestId,
      ...(error.details ? { details: error.details } : {}),
    },
  };
}

export function errorResponse(error: HttpError, requestId: string): Response {
  const headers: Record<string, string> = { "x-request-id": requestId };
  if (error.retryAfter !== undefined) headers["retry-after"] = String(error.retryAfter)
  if (error.allow !== undefined) headers["allow"] = error.allow
  return json(errorBody(error, requestId), error.status, headers)
}

/**
 * Read at most `maxBytes` of a JSON body. Content-Length is only a hint; the stream itself is
 * bounded so a chunked request cannot force the Worker to buffer an unbounded payload.
 */
export async function readJsonBody(
  request: Request,
  maxBytes: number,
  options: { allowEmpty?: boolean } = {},
): Promise<{ raw: string; value: unknown }> {
  const declared = Number(request.headers.get("content-length") ?? "0")
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", `Body exceeds ${maxBytes} bytes`, {
      details: { maxBytes },
    })
  }

  const bytes = await readBounded(request, maxBytes)
  if (bytes.byteLength === 0) {
    if (options.allowEmpty) return { raw: "", value: {} }
    throw new HttpError(400, "INVALID_JSON", "A JSON body is required")
  }

  const type = (request.headers.get("content-type") ?? "").toLowerCase()
  if (!type.includes("application/json")) {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json")
  }

  const raw = new TextDecoder().decode(bytes)
  try {
    return { raw, value: JSON.parse(raw) as unknown }
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Body is not valid JSON")
  }
}

export function structuredLog(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, at: new Date().toISOString(), ...fields }))
}

export function structuredError(event: string, fields: Record<string, unknown>): void {
  console.error(JSON.stringify({ event, at: new Date().toISOString(), ...fields }))
}

async function readBounded(request: Request, maxBytes: number): Promise<Uint8Array> {
  const body = request.body
  if (!body) return new Uint8Array(0)
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new HttpError(413, "PAYLOAD_TOO_LARGE", `Body exceeds ${maxBytes} bytes`, {
        details: { maxBytes },
      })
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  return bytes
}
