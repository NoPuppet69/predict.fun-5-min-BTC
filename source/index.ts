import { allowLive, type Mode } from "./config.js";
import { Engine } from "./engine.js";
import { startServer } from "./server.js";

const want = (process.env.START_MODE ?? "shadow") as Mode;
const mode: Mode = want === "live" && !allowLive ? "shadow" : (["shadow", "test", "live"].includes(want) ? want : "shadow");
const engine = new Engine(mode);
await engine.init();
startServer(engine);

const bye = async () => { await engine.teardown(); process.exit(0); };
process.on("SIGINT", () => void bye());
process.on("SIGTERM", () => void bye());
