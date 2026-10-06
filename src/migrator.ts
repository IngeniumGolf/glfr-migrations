import pgPromise from "pg-promise";
import type { IDatabase, IMain } from "pg-promise";
import { checksumFile, discoverMigrations } from "./files";
import { loadMigration } from "./loader";
import type {
  AppliedMigration,
  Logger,
  MigrationFile,
  MigrationStatus,
  MigrationTask,
  MigratorOptions,
} from "./types";

const DEFAULT_TABLE = "glfr_migrations";
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const VERSION = /^\d{14}$/;

const consoleLogger: Logger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
};

interface AppliedRow {
  version: string;
  name: string;
  filename: string;
  checksum: string | null;
  applied_at: Date;
}

const toApplied = (row: AppliedRow): AppliedMigration => ({
  version: row.version,
  name: row.name,
  filename: row.filename,
  checksum: row.checksum,
  appliedAt: row.applied_at,
});

export class Migrator {
  private readonly pgp: IMain;
  private readonly db: IDatabase<unknown>;
  private readonly dir: string;
  private readonly table: string;
  private tableSql: string;
  private readonly qualified: boolean;
  private readonly logger: Logger;

  constructor(options: MigratorOptions) {
    this.table = options.table ?? DEFAULT_TABLE;
    const parts = this.table.split(".");
    if (parts.length > 2 || !parts.every((part) => IDENTIFIER.test(part))) {
      throw new Error(`Invalid migrations table name "${this.table}"`);
    }

    this.pgp = pgPromise();
    this.qualified = parts.length === 2;
    this.tableSql = parts.map((part) => this.pgp.as.name(part)).join(".");
    this.db = this.pgp(options.connection);
    this.dir = options.dir;
    this.logger = options.logger ?? consoleLogger;
  }

  /** Read-only: does not create the bookkeeping table or take the lock. */
  async status(): Promise<MigrationStatus[]> {
    const applied = await this.db.task(async (t) => {
      await this.qualifyTable(t);
      return this.readApplied(t);
    });
    const appliedByVersion = new Map(applied.map((m) => [m.version, m]));
    const files = discoverMigrations(this.dir);
    const fileVersions = new Set(files.map((f) => f.version));

    const statuses: MigrationStatus[] = files.map((file) => {
      const row = appliedByVersion.get(file.version);
      if (!row)
        return {
          version: file.version,
          name: file.name,
          filename: file.filename,
          state: "pending",
        };
      const modified =
        row.checksum !== null && row.checksum !== checksumFile(file.path);
      return {
        version: file.version,
        name: file.name,
        filename: file.filename,
        state: modified ? "modified" : "applied",
        appliedAt: row.appliedAt,
      };
    });

    for (const row of applied) {
      if (!fileVersions.has(row.version)) {
        statuses.push({
          version: row.version,
          name: row.name,
          filename: row.filename,
          state: "missing",
          appliedAt: row.appliedAt,
        });
      }
    }

    return statuses.sort((a, b) => a.version.localeCompare(b.version));
  }

  /** Applies pending migrations in version order. Returns the migrations that were applied. */
  async up(options: { step?: number } = {}): Promise<MigrationFile[]> {
    return this.withLock(async (t) => {
      const applied = await this.readApplied(t);
      const appliedVersions = new Set(applied.map((m) => m.version));
      const latestApplied = applied.at(-1)?.version;
      const pending = discoverMigrations(this.dir).filter(
        (m) => !appliedVersions.has(m.version),
      );
      const toRun =
        options.step === undefined ? pending : pending.slice(0, options.step);

      if (toRun.length === 0) {
        this.logger.info("No pending migrations");
        return [];
      }

      for (const migration of toRun) {
        const outOfOrder =
          latestApplied !== undefined && migration.version < latestApplied;
        this.logger.info(
          `Applying ${migration.filename}${outOfOrder ? " (out of order)" : ""}`,
        );
        const started = Date.now();
        const module = await loadMigration(migration.path);
        const checksum = checksumFile(migration.path);

        const apply = async (task: MigrationTask): Promise<void> => {
          await module.up(task);
          await this.recordApplied(task, migration, checksum);
        };

        if (module.transaction === false) {
          await apply(t);
        } else {
          await t.tx(apply);
        }
        this.logger.info(
          `  ✓ ${migration.filename} (${Date.now() - started} ms)`,
        );
      }

      return toRun;
    });
  }

  /** Rolls back the most recently applied migrations. Returns the migrations that were rolled back. */
  async down(options: { step?: number } = {}): Promise<AppliedMigration[]> {
    const step = options.step ?? 1;

    return this.withLock(async (t) => {
      const applied = await this.readApplied(t);
      const toRollback = applied.slice(-step).reverse();

      if (toRollback.length === 0) {
        this.logger.info("No migrations to roll back");
        return [];
      }

      const filesByVersion = new Map(
        discoverMigrations(this.dir).map((m) => [m.version, m]),
      );

      for (const migration of toRollback) {
        const file = filesByVersion.get(migration.version);
        if (!file)
          throw new Error(
            `Cannot roll back ${migration.filename}: migration file not found`,
          );

        const module = await loadMigration(file.path);
        const down = module.down;
        if (!down)
          throw new Error(
            `Cannot roll back ${file.filename}: it does not export down()`,
          );

        this.logger.info(`Rolling back ${file.filename}`);
        const revert = async (task: MigrationTask): Promise<void> => {
          await down(task);
          await task.none(`DELETE FROM ${this.tableSql} WHERE version = $1`, [
            migration.version,
          ]);
        };

        if (module.transaction === false) {
          await revert(t);
        } else {
          await t.tx(revert);
        }
        this.logger.info(`  ✓ ${file.filename}`);
      }

      return toRollback;
    });
  }

  /**
   * Records every migration up to and including `version` as applied without running it.
   * Use when adopting the runner on a database whose schema already exists.
   */
  async baseline(version: string): Promise<MigrationFile[]> {
    if (!VERSION.test(version))
      throw new Error(`Invalid version "${version}", expected YYYYMMDDHHMMSS`);

    const files = discoverMigrations(this.dir);
    if (!files.some((m) => m.version === version)) {
      throw new Error(
        `No migration file with version ${version} in ${this.dir}`,
      );
    }

    return this.withLock(async (t) => {
      const appliedVersions = new Set(
        (await this.readApplied(t)).map((m) => m.version),
      );
      const toRecord = files.filter(
        (m) => m.version <= version && !appliedVersions.has(m.version),
      );

      await t.tx(async (tx) => {
        for (const migration of toRecord) {
          await this.recordApplied(tx, migration, checksumFile(migration.path));
          this.logger.info(`  ✓ Baselined ${migration.filename}`);
        }
      });

      if (toRecord.length === 0) this.logger.info("Nothing to baseline");
      return toRecord;
    });
  }

  /** Closes this migrator's connection pool. */
  async close(): Promise<void> {
    await this.db.$pool.end();
  }

  private async withLock<T>(fn: (t: MigrationTask) => Promise<T>): Promise<T> {
    const lockKey = `glfr-migrations:${this.table}`;

    return this.db.task(async (t) => {
      // Session-level lock: concurrent runs (e.g. parallel deploys) wait instead of racing
      await t.one("SELECT pg_advisory_lock(hashtext($1))", [lockKey]);
      try {
        await this.qualifyTable(t);
        await t.none(`
          CREATE TABLE IF NOT EXISTS ${this.tableSql} (
            version VARCHAR(14) PRIMARY KEY,
            name TEXT NOT NULL,
            filename TEXT NOT NULL,
            checksum CHAR(64),
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
          )
        `);
        return await fn(t);
      } finally {
        await t.one("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]);
      }
    });
  }

  /**
   * Pins an unqualified table to the session's current schema before any migration runs, so a
   * migration that changes search_path (e.g. a pg_dump restore) can't redirect the bookkeeping.
   */
  private async qualifyTable(t: MigrationTask): Promise<void> {
    if (this.qualified || this.tableSql.includes(".")) return;
    const { schema } = await t.one<{ schema: string | null }>(
      "SELECT current_schema() AS schema",
    );
    if (!schema)
      throw new Error(
        "No current schema: set search_path or use a schema-qualified --table",
      );
    this.tableSql = `${this.pgp.as.name(schema)}.${this.tableSql}`;
  }

  private async readApplied(t: MigrationTask): Promise<AppliedMigration[]> {
    const exists = await t.one<{ exists: boolean }>(
      "SELECT to_regclass($1) IS NOT NULL AS exists",
      [this.tableSql],
    );
    if (!exists.exists) return [];

    const rows = await t.any<AppliedRow>(
      `SELECT version, name, filename, checksum, applied_at FROM ${this.tableSql} ORDER BY version`,
    );
    return rows.map(toApplied);
  }

  private async recordApplied(
    t: MigrationTask,
    migration: MigrationFile,
    checksum: string,
  ): Promise<void> {
    await t.none(
      `INSERT INTO ${this.tableSql} (version, name, filename, checksum) VALUES ($1, $2, $3, $4)`,
      [migration.version, migration.name, migration.filename, checksum],
    );
  }
}
