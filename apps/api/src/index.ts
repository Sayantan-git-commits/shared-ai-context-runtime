import { buildServer } from "./server.js";
import { PostgresContextStore, MemoryContextStore } from "./store.js";
import { validateStartupConfig } from "./config.js";

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";

let startupConfig: { storeType: "postgres" | "memory"; databaseUrl?: string };
try {
  startupConfig = validateStartupConfig(process.env);
  if (startupConfig.storeType === "memory") {
    console.warn("[WARN] Starting with ephemeral in-memory store (CTX_STORE=memory). All checkpoints will be lost on exit.");
  }
} catch (err: any) {
  console.error(err.message);
  process.exit(1);
}

const store = startupConfig.databaseUrl
  ? new PostgresContextStore(startupConfig.databaseUrl)
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
