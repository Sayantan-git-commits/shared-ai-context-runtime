export function validateStartupConfig(env: NodeJS.ProcessEnv = process.env): { storeType: "postgres" | "memory"; databaseUrl?: string } {
  const isProd = env.NODE_ENV === "production";
  if (!env.DATABASE_URL) {
    if (isProd) {
      throw new Error("FATAL: Ephemeral in-memory storage is strictly prohibited in production mode. DATABASE_URL must be provided.");
    }
    if (env.CTX_STORE !== "memory") {
      throw new Error("FATAL: DATABASE_URL is required for durable persistence. For ephemeral in-memory test mode only, set CTX_STORE=memory.");
    }
    return { storeType: "memory" };
  }
  return { storeType: "postgres", databaseUrl: env.DATABASE_URL };
}
