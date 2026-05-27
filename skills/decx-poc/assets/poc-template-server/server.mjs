#!/usr/bin/env node

import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "public");
const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 8000);

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "application/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
]);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

function resolveFilePath(pathname) {
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = normalize(join(publicDir, relativePath));
  return filePath.startsWith(publicDir) ? filePath : null;
}

createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const filePath = resolveFilePath(url.pathname);

  if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...CORS_HEADERS });
    res.end("Not found");
    return;
  }

  const contentType = contentTypes.get(extname(filePath)) || "application/octet-stream";
  res.writeHead(200, { "Content-Type": contentType, ...CORS_HEADERS });
  createReadStream(filePath).pipe(res);
}).listen(port, host, () => {
  console.log(`PoC server listening on http://${host}:${port}`);
  console.log("  index.html    — trigger links, ADB commands, intent redirection");
  console.log("  payload.html  — hosted payload for target WebView (deep-link sink)");
});
