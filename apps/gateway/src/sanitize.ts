// Provider-key hygiene helpers for the gateway.
//
// The customer's Anthropic credential (authorization / x-api-key) and the
// Provable org key (x-provable-key) ride the request through to Anthropic but
// must NEVER be persisted, logged, or queued. Anything that builds a loggable
// view of a request, its headers, or an error object routes it through here
// first.

// Lower-cased header names that must never appear in a log line or stored row.
export const SENSITIVE_HEADERS = ["authorization", "x-api-key", "x-provable-key"] as const;

// pino redact paths — defence in depth so even an accidental `{ req }` /
// `{ headers }` log drops these keys before serialization. `remove: true`
// deletes them outright rather than printing "[Redacted]".
export const LOG_REDACT_PATHS = [
  ...SENSITIVE_HEADERS.flatMap((h) => [
    `req.headers["${h}"]`,
    `headers["${h}"]`,
    `request.headers["${h}"]`,
  ]),
];

// Return a shallow copy of a headers bag with every sensitive header removed
// (case-insensitive). Safe to log.
export function sanitizeHeaders(headers: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!headers) return out;
  for (const [k, v] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.includes(k.toLowerCase() as (typeof SENSITIVE_HEADERS)[number])) continue;
    out[k] = v;
  }
  return out;
}

// Build a log-safe view of an error. Network/abort errors from fetch don't carry
// auth headers, but if anything ever attaches a request/headers/config to an
// error we strip it here before it can reach a log sink.
export function sanitizeError(err: unknown): unknown {
  if (!err || typeof err !== "object") return err;
  const e = err as Record<string, unknown>;
  return {
    name: e.name,
    message: e.message,
    code: e.code,
    // deliberately NOT spreading the error — no headers/config/request copied through
  };
}
