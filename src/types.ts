import type { IMain, ITask } from "pg-promise";

/** The pg-promise task a migration runs on. Inside a transaction unless the migration opts out. */
export type MigrationTask = ITask<unknown>;

export type ConnectionOptions = Parameters<IMain>[0];

export interface MigrationModule {
  up: (t: MigrationTask) => Promise<void>;
  down?: (t: MigrationTask) => Promise<void>;
  /** Set to `false` for statements that cannot run in a transaction, e.g. `CREATE INDEX CONCURRENTLY`. */
  transaction?: boolean;
}

export interface MigrationFile {
  /** 14-digit UTC timestamp, `YYYYMMDDHHMMSS`. */
  version: string;
  name: string;
  filename: string;
  path: string;
}

export interface AppliedMigration {
  version: string;
  name: string;
  filename: string;
  checksum: string | null;
  appliedAt: Date;
}

export type MigrationState = "applied" | "pending" | "modified" | "missing";

export interface MigrationStatus {
  version: string;
  name: string;
  filename: string;
  state: MigrationState;
  appliedAt?: Date;
}

export interface Logger {
  info: (message: string) => void;
  warn: (message: string) => void;
}

export interface MigratorOptions {
  /** Connection string or pg-promise connection object. */
  connection: ConnectionOptions;
  /** Directory containing the migration files. */
  dir: string;
  /** Bookkeeping table, optionally schema-qualified. Defaults to `glfr_migrations`. */
  table?: string;
  logger?: Logger;
}
