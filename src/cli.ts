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
  --url <url>         Connection string (default: $DATABASE_URL, then libpq PG* variables)
  --table <name>      Bookkeeping table, optionally schema-qualified (default: glfr_migrations)
  --env-file <path>   Load environment variables from a .env file first
  --step <n>          up: apply at most n migrations. down: roll back n migrations (default 1)
  -h, --help          Show this help
  -v, --version       Show the package version
`;

export interface CliOptions {
  /** Connection used when --url and DATABASE_URL are not set. Lets wrappers map project-specific env vars. */
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
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (fallback) return typeof fallback === "function" ? fallback() : fallback;
  // node-postgres fills in PGHOST, PGPORT, PGDATABASE, PGUSER and PGPASSWORD
  return {};
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

  if (values["env-file"]) process.loadEnvFile(values["env-file"]);
  const dir = path.resolve(values.dir ?? options.dir ?? "migrations");

  if (command === "create" || command === "new" || command === "generate") {
    const filePath = createMigrationFile(dir, rest.join(" "));
    console.log(`Created ${path.relative(process.cwd(), filePath)}`);
    return 0;
  }

  const migrator = new Migrator({
    connection: resolveConnection(values.url, options.connection),
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
      process.exitCode = code;
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
      process.exitCode = 1;
    },
  );
}
