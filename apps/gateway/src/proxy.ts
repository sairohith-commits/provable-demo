import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { Readable } from "node:stream";
import { orgFromKey } from "./org.js";
import { captureFromStream } from "./capture.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

// Headers forwarded to Anthropic untouched. Notably includes the agent's own
// x-api-key / authorization — the gateway never substitutes its own key.
const FORWARD_HEADERS = ["content-type", "x-api-key", "authorization", "anthropic-version", "anthropic-beta"];

// Hop-by-hop / framing headers we must not relay back to the caller verbatim.
const STRIP_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection"]);

export async function registerProxyRoutes(app: FastifyInstance) {
  // Accept the raw body as a Buffer so the request reaches Anthropic byte-for-byte
  // unchanged, regardless of what the agent sent.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

  app.post("/v1/messages", async (req: FastifyRequest, reply: FastifyReply) => {
    const org = await orgFromKey(req);
    if (!org) return reply.code(401).send({ error: "missing or invalid x-provable-key" });

    const agentNameHeader = req.headers["x-provable-agent"];
    const agentName = typeof agentNameHeader === "string" && agentNameHeader.length > 0 ? agentNameHeader : null;

    const rawBody = req.body as Buffer;

    let parsedBody: any = null;
    try {
      parsedBody = rawBody && rawBody.length > 0 ? JSON.parse(rawBody.toString("utf8")) : null;
    } catch {
      // Malformed JSON — still forward as-is; Anthropic will return its own error.
    }

    const upstreamHeaders = new Headers();
    for (const h of FORWARD_HEADERS) {
      const v = req.headers[h];
      if (typeof v === "string") upstreamHeaders.set(h, v);
    }

    const startedAt = Date.now();
    let upstream: Response;
    try {
      upstream = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: upstreamHeaders,
        body: new Uint8Array(rawBody),
      });
    } catch (err) {
      // Network failure talking to Anthropic — surface as a 502, nothing to capture.
      app.log.error({ err }, "gateway: upstream fetch failed");
      return reply.code(502).send({ error: "upstream request to Anthropic failed" });
    }

    reply.code(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) reply.header(key, value);
    });

    if (!upstream.body) {
      return reply.send();
    }

    // Tee the body: one branch streams to the caller untouched, the other is
    // consumed asynchronously (best-effort) for telemetry.
    const [clientBody, captureBody] = upstream.body.tee();

    const isStream = parsedBody?.stream === true;
    const requestModel = typeof parsedBody?.model === "string" ? parsedBody.model : null;

    void captureFromStream(captureBody, {
      orgId: org.id,
      agentName,
      requestModel,
      startedAt,
      isStream,
      status: upstream.status,
    });

    return reply.send(Readable.fromWeb(clientBody as any));
  });
}
