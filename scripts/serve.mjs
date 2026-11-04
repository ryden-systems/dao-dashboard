// Local preview of the built site: node scripts/serve.mjs [port]  (serves dist/)
// POST /__rebuild runs the full build (what Update now does on the local page), one at a time.
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./lib/util.mjs";

const dist = path.join(ROOT, "dist");
const port = Number(process.argv[2]) || 8787;
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

let building = null;
function rebuild() {
  building ??= new Promise((resolve) => {
    const t0 = Date.now();
    let out = "";
    const p = spawn(process.execPath, [path.join(ROOT, "scripts", "build.mjs")], { cwd: ROOT });
    p.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
    p.stderr.on("data", (d) => { out += d; process.stderr.write(d); });
    p.on("close", (code) => {
      building = null;
      resolve(code === 0 ? { ok: true, ms: Date.now() - t0 } : { error: out.trim().split("\n").slice(-3).join(" ") || `build exited with ${code}` });
    });
  });
  return building;
}

http.createServer(async (req, res) => {
  const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (url === "/__rebuild") {
    // Only from this server's own page: a POST from any other site carries a foreign Origin.
    const origin = req.headers.origin;
    if (req.method !== "POST" || (origin && origin !== `http://localhost:${port}` && origin !== `http://127.0.0.1:${port}`)) { res.writeHead(403); return res.end(); }
    const r = await rebuild();
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(r));
  }
  let file = path.normalize(path.join(dist, url === "/" ? "index.html" : url));
  if (!file.startsWith(dist)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end("Not found"); }
  res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
  fs.createReadStream(file).pipe(res);
}).listen(port, "127.0.0.1", () => console.log(`Serving dist/ at http://localhost:${port}`));
