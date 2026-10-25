import { buildServer } from "./server.js";
import { PostgresContextStore, MemoryContextStore } from "./store.js";

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";

if (!process.env.DATABASE_URL) {
  if (process.env.CTX_STORE !== "memory") {
    console.error("FATAL: DATABASE_URL is required for durable persistence.");
    console.error("Set DATABASE_URL=postgresql://user:pass@host:5432/ctx_db");
    console.error("For ephemeral in-memory test mode only, explicitly pass CTX_STORE=memory.");
    process.exit(1);
  }
  console.warn("[WARN] Starting with ephemeral in-memory store (CTX_STORE=memory). All checkpoints will be lost on exit.");
}

const store = process.env.DATABASE_URL
  ? new PostgresContextStore(process.env.DATABASE_URL)
  : new MemoryContextStore();

const server = buildServer({
  store,
  authToken: process.env.CTX_AUTH_TOKEN,
  enableRateLimit: process.env.ENABLE_RATE_LIMIT === "true" || process.env.NODE_ENV === "production",
});

server.listen({ port, host }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`ctx API listening at ${address} (store: ${process.env.DATABASE_URL ? "PostgreSQL" : "Memory"})`);
});

// Graceful shutdown and database pool draining
async function gracefulShutdown(signal: string) {
  console.log(`[INFO] Received ${signal}, starting graceful shutdown...`);
  try {
    await server.close();
    if (typeof store.close === "function") {
      await store.close();
    }
    console.log("[INFO] Graceful shutdown completed.");
    process.exit(0);
  } catch (err) {
    console.error("[ERROR] Failed to shut down gracefully:", err);
    process.exit(1);
  }
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
