import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
const { Client } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const migrationsDir = path.join(rootDir, "migrations");

export async function runMigrations(dbUrl?: string): Promise<{ applied: string[]; skipped: string[] }> {
  const connectionString = dbUrl || process.env.DATABASE_URL || "postgresql://postgres@127.0.0.1:5432/ctx_db";
  const client = new Client({ connectionString });
  await client.connect();

  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    // 1. Create migration ledger table if not exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // 2. Fetch applied migrations
    const res = await client.query("SELECT version FROM schema_migrations ORDER BY version ASC");
    const appliedSet = new Set(res.rows.map((r: any) => r.version));

    // 3. Read migration files in deterministic alphabetical order
    const files = fs.readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      if (appliedSet.has(file)) {
        skipped.push(file);
        continue;
      }

      const sqlPath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(sqlPath, "utf-8");

      console.log(`Applying migration: ${file}...`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
        console.log(`✓ Applied ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`❌ Migration failed at ${file}:`, err);
        throw err;
      }
    }

    console.log(`Database migration complete. ${applied.length} applied, ${skipped.length} already up to date.`);
    return { applied, skipped };
  } finally {
    await client.end();
  }
}

// Run directly if invoked as script
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  runMigrations().catch((err) => {
    console.error("Migration error:", err);
    process.exit(1);
  });
}
