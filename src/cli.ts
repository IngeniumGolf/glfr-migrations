#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { createMigrationFile } from "./files";
import { Migrator } from "./migrator";
import type { ConnectionOptions, MigrationStatus } from "./types";

const USAGE = `Usage: glfr-migrate <command> [options]

Commands:
  up                       Apply pending migrations
  down                     Roll back the latest migration
  status                   List applied, pending, modified and missing migrations
  create <description>     Create a new migration file
  baseline <version>       Mark migrations up to <version> as applied without running them

Options:
  --dir <path>        Migrations directory (default: ./migrations)
  --url <url>         Connection string (default: $DATABASE_URL, then PG* or DB_* variables)
  --table <name>      Bookkeeping table, optionally schema-qualified (default: glfr_migrations)
  --env-file <path>   Load environment variables (default: ./.env if present)
  --step <n>          up: apply at most n migrations. down: roll back n migrations (default 1)
  -h, --help          Show this help
  -v, --version       Show the package version
`;

export interface CliOptions {
  /** Connection used unless --url is given. Takes precedence over DATABASE_URL so wrappers can map project-specific env vars. */
  connection?: ConnectionOptions | (() => ConnectionOptions);
  /** Default migrations directory, relative to the working directory. */
  dir?: string;
  table?: string;
}

const STATE_ICONS: Record<MigrationStatus["state"], string> = {
  applied: "✓",
  pending: "○",
  modified: "!",
  missing: "?",
};

const parseStep = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const step = Number(value);
  if (!Number.isInteger(step) || step < 1)
    throw new Error(`--step must be a positive integer, got "${value}"`);
  return step;
};

const resolveConnection = (
  url: string | undefined,
  fallback: CliOptions["connection"],
): ConnectionOptions => {
  if (url) return url;
  if (fallback) return typeof fallback === "function" ? fallback() : fallback;
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const usePg = ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"].some(
    (key) => process.env[key] !== undefined,
  );
  if (!usePg) {
    return {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT ?? 5432),
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
    };
  }
  return {
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT ?? 5432),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
  };
};

const validateConnection = (connection: ConnectionOptions): void => {
  const guidance =
    "Create a .env file, pass --env-file <path>, or supply connection settings in the environment.";
  if (typeof connection === "string") {
    let parsed: URL;
    try {
      parsed = new URL(connection);
    } catch {
      throw new Error(`Invalid PostgreSQL connection URL. ${guidance}`);
    }
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      !parsed.hostname ||
      !parsed.username ||
      parsed.pathname.length < 2
    ) {
      throw new Error(
        `Connection URL must specify a PostgreSQL host, user and database. ${guidance}`,
      );
    }
    return;
  }
  const config = connection as {
    host?: string;
    database?: string;
    user?: string;
    port?: number;
  };
  const missing = ["host", "database", "user"].filter(
    (field) => !config[field as "host" | "database" | "user"]?.trim(),
  );
  if (missing.length) {
    throw new Error(
      `Missing database connection settings: ${missing.join(", ")}. Use DATABASE_URL, PGHOST/PGDATABASE/PGUSER, DB_HOST/DB_NAME/DB_USER, or your project's connection wrapper. ${guidance}`,
    );
  }
  if (
    config.port !== undefined &&
    (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
  ) {
    throw new Error("Database port must be an integer between 1 and 65535.");
  }
};

const loadEnvironment = (explicitPath: string | undefined): void => {
  const envFile = explicitPath ?? path.resolve(".env");
  if (!fs.existsSync(envFile)) {
    if (explicitPath) {
      throw new Error(
        "Environment file not found. Set --env-file to an existing file or create a .env file.",
      );
    }
    return;
  }
  process.loadEnvFile(envFile);
};

/** host:port/database without credentials, so every run shows which database it touches. */
const describeConnection = (connection: ConnectionOptions): string => {
  if (typeof connection === "string") {
    try {
      const parsed = new URL(connection);
      return `${parsed.hostname}:${parsed.port || 5432}${parsed.pathname}`;
    } catch {
      return "(connection string)";
    }
  }
  const config = connection as {
    host?: string;
    port?: number;
    database?: string;
  };
  const host = config.host ?? process.env.PGHOST ?? "localhost";
  const port = config.port ?? process.env.PGPORT ?? 5432;
  const database = config.database ?? process.env.PGDATABASE ?? "";
  return `${host}:${port}/${database}`;
};

const readPackageVersion = (): string => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  return pkg.version;
};

const printStatus = (statuses: MigrationStatus[]): void => {
  if (statuses.length === 0) {
    console.log("No migrations found");
    return;
  }
  for (const s of statuses) {
    const applied = s.appliedAt ? `  ${s.appliedAt.toISOString()}` : "";
    console.log(
      `${STATE_ICONS[s.state]} ${s.state.padEnd(8)} ${s.filename}${applied}`,
    );
  }
  const modified = statuses.filter((s) => s.state === "modified").length;
  const missing = statuses.filter((s) => s.state === "missing").length;
  if (modified > 0)
    console.warn(
      `\n${modified} applied migration(s) changed on disk since they ran`,
    );
  if (missing > 0)
    console.warn(
      `\n${missing} applied migration(s) have no file in the migrations directory`,
    );
};

/** Runs the CLI. Returns the process exit code. */
export const runCli = async (
  argv: string[] = process.argv.slice(2),
  options: CliOptions = {},
): Promise<number> => {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dir: { type: "string" },
      url: { type: "string" },
      table: { type: "string" },
      "env-file": { type: "string" },
      step: { type: "string" },
      all: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });

  if (values.version) {
    console.log(readPackageVersion());
    return 0;
  }

  const [command, ...rest] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }

  const dir = path.resolve(values.dir ?? options.dir ?? "migrations");

  if (command === "create" || command === "new" || command === "generate") {
    const filePath = createMigrationFile(dir, rest.join(" "));
    console.log(`Created ${path.relative(process.cwd(), filePath)}`);
    return 0;
  }

  if (!["up", "down", "status", "baseline"].includes(command)) {
    console.error(`Unknown command "${command}"\n`);
    console.log(USAGE);
    return 1;
  }
  loadEnvironment(values["env-file"]);
  const connection = resolveConnection(values.url, options.connection);
  validateConnection(connection);
  console.log(`Database: ${describeConnection(connection)}`);
  const migrator = new Migrator({
    connection,
    dir,
    table: values.table ?? options.table,
  });

  try {
    switch (command) {
      case "up":
        await migrator.up({ step: parseStep(values.step) });
        return 0;
      case "down":
        await migrator.down({ step: parseStep(values.step) });
        return 0;
      case "status":
        printStatus(await migrator.status());
        return 0;
      case "baseline":
        if (!rest[0]) throw new Error("Usage: glfr-migrate baseline <version>");
        await migrator.baseline(rest[0]);
        return 0;
      default:
        console.error(`Unknown command "${command}"\n`);
        console.log(USAGE);
        return 1;
    }
  } finally {
    await migrator.close();
  }
};

if (typeof require !== "undefined" && require.main === module) {
  runCli().then(
    (code) => {
      process.exit(code);
    },
    (error: unknown) => {
      console.error(
        error instanceof Error ? `Migration failed: ${error.message}` : error,
      );
      const cause = error instanceof Error ? error.cause : undefined;
      if (
        cause instanceof Error &&
        !(error as Error).message.includes(cause.message)
      )
        console.error(cause);
      process.exit(1);
    },
  );
}
