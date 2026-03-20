#!/usr/bin/env node
/**
 * Local HTTP proxy: ColorAI (Chrome extension) → this process → Ollama.
 *
 * Browser requests include `Origin: chrome-extension://…`, which Ollama may reject
 * with 403. This proxy forwards to Ollama using Node’s HTTP client (no browser
 * Origin), so you do not need `OLLAMA_ORIGINS` if you point ColorAI at this port.
 *
 * Usage:
 *   node scripts/colorai-ollama-proxy.mjs
 * Then in ColorAI options set Base URL to http://127.0.0.1:11435
 *
 * Env (optional):
 *   COLORAI_OLLAMA_UPSTREAM=http://127.0.0.1:11434
 *   COLORAI_LISTEN_PORT=11435
 */

import http from "node:http";
import { request as httpRequest } from "node:http";

const UPSTREAM = (process.env.COLORAI_OLLAMA_UPSTREAM || "http://127.0.0.1:11434").replace(/\/+$/, "");
const LISTEN_PORT = Number(process.env.COLORAI_LISTEN_PORT || "11435", 10);

const upstreamUrl = new URL(UPSTREAM);

const server = http.createServer((clientReq, clientRes) => {
  const headers = { ...clientReq.headers };
  delete headers.origin;
  delete headers.referer;
  delete headers["access-control-request-method"];
  delete headers["access-control-request-headers"];
  headers.host = `${upstreamUrl.hostname}:${upstreamUrl.port || (upstreamUrl.protocol === "https:" ? 443 : 80)}`;

  const opts = {
    hostname: upstreamUrl.hostname,
    port: upstreamUrl.port || 11434,
    path: clientReq.url,
    method: clientReq.method,
    headers,
  };

  const proxyReq = httpRequest(opts, (proxyRes) => {
    const outHeaders = { ...proxyRes.headers };
    clientRes.writeHead(proxyRes.statusCode || 502, outHeaders);
    proxyRes.pipe(clientRes);
  });

  proxyReq.on("error", (err) => {
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    }
    clientRes.end(`ColorAI Ollama proxy: upstream error: ${err.message}`);
  });

  clientReq.pipe(proxyReq);
});

server.listen(LISTEN_PORT, "127.0.0.1", () => {
  console.error(
    `[ColorAI] Ollama proxy listening http://127.0.0.1:${LISTEN_PORT} → ${UPSTREAM}`
  );
});
