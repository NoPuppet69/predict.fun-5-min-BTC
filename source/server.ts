import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { dash, type Mode } from "./config.js";
import type { Engine } from "./engine.js";

/** Local-only control server. Every /api call needs the token printed at startup. */
export function startServer(engine: Engine) {
  const page = () => fs.readFileSync(path.join(process.cwd(), "public", "index.html"), "utf8");

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const json = (code: number, body: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    try {
      if (url.pathname === "/") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(page()); }
      if (!url.pathname.startsWith("/api/")) return json(404, { error: "not found" });
      const tok = (req.headers["x-token"] as string | undefined) ?? url.searchParams.get("t");
      if (tok !== dash.token) return json(401, { error: "bad token" });

      if (req.method === "GET" && url.pathname === "/api/state") return json(200, engine.snapshot());
      if (req.method === "GET" && url.pathname === "/api/export") {
        const csv = url.searchParams.get("format") === "csv";
        res.writeHead(200, { "Content-Type": csv ? "text/csv" : "application/x-ndjson", "Content-Disposition": `attachment; filename="${engine.mode}-events.${csv ? "csv" : "jsonl"}"` });
        return res.end(csv ? engine.exportCsv() : engine.exportRaw());
      }
      if (req.method !== "POST") return json(405, { error: "method" });
      let raw = ""; for await (const c of req) raw += c;
      const body = raw ? JSON.parse(raw) : {};

      switch (url.pathname) {
        case "/api/settings": engine.updateSettings(body); return json(200, { ok: true });
        case "/api/mode": await engine.setMode(body.mode as Mode, body.confirm); return json(200, { ok: true });
        case "/api/start": engine.start(); return json(200, { ok: true });
        case "/api/stop": engine.stop(); return json(200, { ok: true });
        case "/api/halt": engine.halt("manual emergency halt"); return json(200, { ok: true });
        case "/api/claim": await engine.manualClaim(); return json(200, { ok: true });
        default: return json(404, { error: "not found" });
      }
    } catch (e) { json(400, { error: (e as Error).message }); }
  });

  server.listen(dash.port, "127.0.0.1", () =>
    console.log(`\n[dashboard] http://127.0.0.1:${dash.port}/?t=${dash.token}\n`));
}
