// Boots a throwaway embedded Postgres, applies the Prisma schema to it, then
// runs the integration test suite against it. Tears the DB down afterwards.
//
// Usage: node scripts/with-test-db.cjs   (wired up as `npm run test:integration`)
//
// embedded-postgres downloads a real PG binary on first run, so there's no
// Docker dependency. The DB is ephemeral (persistent: false) in a temp dir, so
// each run starts clean. CommonJS (.cjs) so module resolution honours NODE_PATH.

const EmbeddedPostgresModule = require("embedded-postgres");
const { execSync, spawnSync } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const EmbeddedPostgres = EmbeddedPostgresModule.default || EmbeddedPostgresModule;

const PORT = Number(process.env.TEST_PG_PORT || 55433);
const DB = "lsp_test";
const dataDir = mkdtempSync(join(tmpdir(), "lsp-pg-"));
const DATABASE_URL = `postgresql://postgres:postgres@localhost:${PORT}/${DB}?schema=public`;

(async () => {
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "postgres",
    password: "postgres",
    port: PORT,
    persistent: false,
  });

  let exitCode = 1;
  try {
    console.log("▶ booting embedded Postgres…");
    await pg.initialise();
    await pg.start();
    await pg.createDatabase(DB);

    const env = { ...process.env, DATABASE_URL };

    console.log("▶ applying Prisma schema (db push)…");
    execSync("npx prisma db push --skip-generate --accept-data-loss", { stdio: "inherit", env });

    console.log("▶ running integration tests…");
    const res = spawnSync(
      "npx",
      ["vitest", "run", "--config", "vitest.integration.config.ts"],
      { stdio: "inherit", env },
    );
    exitCode = res.status == null ? 1 : res.status;
  } catch (err) {
    console.error("integration runner failed:", err);
    exitCode = 1;
  } finally {
    try {
      await pg.stop();
    } catch {
      /* ignore */
    }
    rmSync(dataDir, { recursive: true, force: true });
  }

  process.exit(exitCode);
})();
