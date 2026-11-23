import { readFile } from "node:fs/promises";

const migrations = ["002_workspace.sql", "003_appearance.sql", "004_workspace_personal.sql", "005_subscription_plans.sql", "006_calendar_details.sql", "007_crm_clients.sql"];
const migrationLock = 59047;

export async function migrateWorkspace(pool) {
  const db = await pool.connect();
  let failed = true;
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock($1)", [migrationLock]);
    for (const file of migrations) {
      const sql = await readFile(new URL("./migrations/" + file, import.meta.url), "utf8");
      // The SQL files also support standalone execution in the SQL editor.
      const body = sql.trim().match(/^BEGIN;\s*([\s\S]+)\s*COMMIT;$/);
      if (!body) throw new Error("Invalid migration transaction: " + file);
      await db.query(body[1]);
    }
    await db.query("COMMIT");
    failed = false;
  } finally {
    // Closing a failed connection rolls back its transaction.
    db.release(failed);
  }
}
