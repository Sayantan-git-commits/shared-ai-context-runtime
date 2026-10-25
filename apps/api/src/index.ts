import { buildServer } from "./server.js";
import { PostgresContextStore, MemoryContextStore } from "./store.js";

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";

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
