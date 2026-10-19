import fs from "node:fs";
import path from "node:path";

/** Append-only JSONL record. Survives restarts; the dashboard and stats are rebuilt from it. */
export class Ledger {
  readonly file: string;
  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "events.jsonl");
  }
  append(ev: Record<string, unknown>) {
    fs.appendFileSync(this.file, JSON.stringify({ ts: Date.now(), ...ev }) + "\n");
  }
  readAll(): any[] {
    if (!fs.existsSync(this.file)) return [];
    return fs.readFileSync(this.file, "utf8").split("\n").filter(Boolean).flatMap((l) => {
      try { return [JSON.parse(l)]; } catch { return []; }
    });
  }
  raw(): string {
    return fs.existsSync(this.file) ? fs.readFileSync(this.file, "utf8") : "";
  }
  csv(): string {
    const rows = this.readAll();
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    return [cols.join(","), ...rows.map((r) => cols.map((c) => q(r[c])).join(","))].join("\n");
  }
}
