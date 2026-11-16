#!/usr/bin/env node
/* Tiny local CORS relay for the experimental LCSC/JLC part crawler (zero dependencies).
   Usage:  node tools/lcsc-proxy.js [port]          (default 8765, bound to 127.0.0.1)
   Then in the app: Experimental → Parts crawler → Proxy URL = http://localhost:8765/?url={url}
   Only the hosts below are relayed; everything else gets 403. */
"use strict";
const http = require("http"), https = require("https");
const PORT = parseInt(process.argv[2], 10) || 8765;
const ALLOW = new Set(["easyeda.com", "wmsc.lcsc.com", "assets.lcsc.com", "image.easyeda.com"]);

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" };

http.createServer((req, res) => {
  if (req.method === "OPTIONS"){ res.writeHead(204, cors); return res.end(); }
  let target;
  try { target = new URL(new URL(req.url, "http://x").searchParams.get("url")); } catch(e){ target = null; }
  if (!target || target.protocol !== "https:" || !ALLOW.has(target.hostname)){
    res.writeHead(403, cors); return res.end("host not allowed");
  }
  https.get(target, { headers: { "User-Agent": "pcb-reveng-crawler", Accept: "application/json" } }, up => {
    res.writeHead(up.statusCode || 502, { ...cors, "Content-Type": up.headers["content-type"] || "application/octet-stream" });
    up.pipe(res);
  }).on("error", err => { res.writeHead(502, cors); res.end(String(err.message)); });
}).on("error", e => { console.error("Cannot listen on " + PORT + ": " + e.message + " — try another port: node tools/lcsc-proxy.js 9000"); process.exit(1); })
  .listen(PORT, "127.0.0.1", () => console.log("LCSC proxy on http://localhost:" + PORT + "/?url={url}"));
