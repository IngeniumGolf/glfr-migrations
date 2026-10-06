import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pgPromise from "pg-promise";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { Migrator } from "../src/migrator";
import type { Logger } from "../src/types";

const url = process.env.TEST_DATABASE_URL;
const silent: Logger = { info: () => {}, warn: () => {} };

describe.skipIf(!url)("Migrator (integration, needs TEST_DATABASE_URL)", () => {
  const pgp = pgPromise();
  const db = pgp(url ?? "");
  const migrators: Migrator[] = [];
  let dir: string;
  let schema: string;

  const write = (filename: string, content: string): void => {
    fs.writeFileSync(path.join(dir, filename), content);
  };

  // CommonJS migration creating <schema>.<table>
  const tableMigration = (table: string, extra = ""): string => `
    exports.up = async (t) => { await t.none("CREATE TABLE ${schema}.${table} (id INT)"); };
    exports.down = async (t) => { await t.none("DROP TABLE ${schema}.${table}"); };
    ${extra}
  `;

  const migrator = (): Migrator => {
    const m = new Migrator({
      connection: url ?? "",
      dir,
      table: `${schema}.glfr_migrations`,
      logger: silent,
    });
    migrators.push(m);
    return m;
  };

  const tables = async (): Promise<string[]> =>
    (
      await db.any<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name <> 'glfr_migrations' ORDER BY 1",
        [schema],
      )
    ).map((r) => r.table_name);

  beforeAll(async () => {
    await db.one("SELECT 1");
  });

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "glfr-migrations-it-"));
    schema = `it_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    await db.none("CREATE SCHEMA $1:name", [schema]);
  });

  afterEach(async () => {
    await Promise.all(migrators.splice(0).map((m) => m.close()));
    await db.none("DROP SCHEMA $1:name CASCADE", [schema]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await db.$pool.end();
  });

  it("applies pending migrations in order and reports status", async () => {
    write("20261001000000_create_a.cjs", tableMigration("a"));
    write("20261002000000_create_b.cjs", tableMigration("b"));

    const m = migrator();
    expect((await m.status()).map((s) => s.state)).toEqual([
      "pending",
      "pending",
    ]);

    const applied = await m.up();
    expect(applied.map((x) => x.version)).toEqual([
      "20261001000000",
      "20261002000000",
    ]);
    expect(await tables()).toEqual(["a", "b"]);
    expect((await m.status()).map((s) => s.state)).toEqual([
      "applied",
      "applied",
    ]);
    expect(await m.up()).toEqual([]);
  });

  it("limits up with step", async () => {
    write("20261001000000_create_a.cjs", tableMigration("a"));
    write("20261002000000_create_b.cjs", tableMigration("b"));

    await migrator().up({ step: 1 });
    expect(await tables()).toEqual(["a"]);
  });

  it("loads TypeScript and ES module migrations", async () => {
    write(
      "20261001000000_typescript.ts",
      `type Task = { none: (sql: string) => Promise<null> };
       export const up = async (t: Task): Promise<void> => { await t.none("CREATE TABLE ${schema}.from_ts (id INT)"); };`,
    );
    write(
      "20261002000000_esm.mjs",
      `export const up = async (t) => { await t.none("CREATE TABLE ${schema}.from_mjs (id INT)"); };`,
    );

    await migrator().up();
    expect(await tables()).toEqual(["from_mjs", "from_ts"]);
  });

  it("rolls back the latest migrations with down", async () => {
    write("20261001000000_create_a.cjs", tableMigration("a"));
    write("20261002000000_create_b.cjs", tableMigration("b"));
    const m = migrator();
    await m.up();

    const rolledBack = await m.down();
    expect(rolledBack.map((x) => x.version)).toEqual(["20261002000000"]);
    expect(await tables()).toEqual(["a"]);

    await m.down({ step: 5 });
    expect(await tables()).toEqual([]);
    expect((await m.status()).map((s) => s.state)).toEqual([
      "pending",
      "pending",
    ]);
  });

  it("refuses to roll back a migration without down()", async () => {
    write("20261001000000_irreversible.cjs", `exports.up = async () => {};`);
    const m = migrator();
    await m.up();
    await expect(m.down()).rejects.toThrow(/does not export down/);
  });

  it("rolls back a failed migration and does not record it", async () => {
    write("20261001000000_create_a.cjs", tableMigration("a"));
    write(
      "20261002000000_broken.cjs",
      `exports.up = async (t) => { await t.none("CREATE TABLE ${schema}.half (id INT)"); await t.none("SELECT * FROM missing_table"); };`,
    );

    const m = migrator();
    await expect(m.up()).rejects.toThrow(/missing_table/);
    expect(await tables()).toEqual(["a"]);
    expect((await m.status()).map((s) => s.state)).toEqual([
      "applied",
      "pending",
    ]);
  });

  it("runs migrations with transaction = false outside a transaction", async () => {
    write("20261001000000_create_a.cjs", tableMigration("a"));
    write(
      "20261002000000_concurrent_index.cjs",
      `exports.transaction = false;
       exports.up = async (t) => { await t.none("CREATE INDEX CONCURRENTLY a_id_idx ON ${schema}.a (id)"); };`,
    );

    await migrator().up();
    const index = await db.oneOrNone(
      "SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND indexname = 'a_id_idx'",
      [schema],
    );
    expect(index).not.toBeNull();
  });

  it("baselines without running migrations", async () => {
    write("20261001000000_create_a.cjs", tableMigration("a"));
    write("20261002000000_create_b.cjs", tableMigration("b"));
    write("20261003000000_create_c.cjs", tableMigration("c"));
    const m = migrator();

    const baselined = await m.baseline("20261002000000");
    expect(baselined.map((x) => x.version)).toEqual([
      "20261001000000",
      "20261002000000",
    ]);
    expect(await tables()).toEqual([]);

    await m.up();
    expect(await tables()).toEqual(["c"]);
    await expect(m.baseline("20261009000000")).rejects.toThrow(
      /No migration file/,
    );
  });

  it("flags modified and missing migrations in status", async () => {
    write("20261001000000_create_a.cjs", tableMigration("a"));
    write("20261002000000_create_b.cjs", tableMigration("b"));
    const m = migrator();
    await m.up();

    write(
      "20261001000000_create_a.cjs",
      tableMigration("a", "// edited after it ran"),
    );
    fs.rmSync(path.join(dir, "20261002000000_create_b.cjs"));

    expect((await m.status()).map((s) => [s.version, s.state])).toEqual([
      ["20261001000000", "modified"],
      ["20261002000000", "missing"],
    ]);
  });

  it("applies each migration exactly once when runs overlap", async () => {
    write(
      "20261001000000_slow.cjs",
      `exports.up = async (t) => { await t.one("SELECT pg_sleep(0.5)"); await t.none("CREATE TABLE ${schema}.slow (id INT)"); };`,
    );

    const results = await Promise.all([migrator().up(), migrator().up()]);
    expect(results.map((r) => r.length).sort()).toEqual([0, 1]);
    expect(await tables()).toEqual(["slow"]);
  });
});
