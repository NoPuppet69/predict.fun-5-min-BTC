import WebSocket from "ws";

type Handler = (topic: string, data: any) => void;

/** Echoes heartbeats (server probes every 15 s), reconnects with backoff, re-subscribes. */
export class PredictWs {
  private ws?: WebSocket;
  private topics = new Set<string>();
  private reqId = 1;
  private backoff = 1000;
  private closed = false;
  private lastMsg = 0;
  constructor(private url: string, private apiKey: string, private onMessage: Handler) {}

  connect() {
    const ws = new WebSocket(this.url, { headers: this.apiKey ? { "x-api-key": this.apiKey } : {} });
    this.ws = ws;
    ws.on("open", () => {
      this.backoff = 1000; this.lastMsg = Date.now();
      for (const t of this.topics) this.send("subscribe", t);
    });
    ws.on("message", (raw) => {
      this.lastMsg = Date.now();
      let m: any;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === "M" && m.topic === "heartbeat") ws.send(JSON.stringify({ method: "heartbeat", data: m.data }));
      else if (m.type === "M") this.onMessage(m.topic, m.data);
      else if (m.type === "R" && m.success === false) console.warn("[ws] rejected", JSON.stringify(m.error));
    });
    ws.on("close", () => {
      if (this.closed) return;
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    });
    ws.on("error", (e) => console.warn("[ws] error", e.message));
  }
  private send(method: "subscribe" | "unsubscribe", topic: string) {
    this.ws?.send(JSON.stringify({ method, requestId: this.reqId++, params: [topic] }));
  }
  subscribe(t: string) { this.topics.add(t); if (this.ws?.readyState === WebSocket.OPEN) this.send("subscribe", t); }
  unsubscribe(t: string) { this.topics.delete(t); if (this.ws?.readyState === WebSocket.OPEN) this.send("unsubscribe", t); }
  healthy() { return this.ws?.readyState === WebSocket.OPEN && Date.now() - this.lastMsg < 25_000; }
  close() { this.closed = true; this.ws?.close(); }
}
