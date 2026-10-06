import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MigrationFile } from "./types";

const MIGRATION_EXTENSIONS = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"];
const FILENAME_PATTERN = /^(\d{14})_([a-z0-9_]+)\.(?:ts|mts|cts|js|mjs|cjs)$/;

const isIgnored = (filename: string): boolean =>
  filename.startsWith(".") ||
  /\.d\.[mc]?ts$/.test(filename) ||
  /\.(test|spec)\.[mc]?[jt]s$/.test(filename) ||
  !MIGRATION_EXTENSIONS.includes(path.extname(filename));

export const parseMigrationFilename = (
  filename: string,
): Omit<MigrationFile, "path"> | null => {
  const match = FILENAME_PATTERN.exec(filename);
  if (!match) return null;
  return { version: match[1], name: match[2].replace(/_/g, " "), filename };
};

/** Lists migration files sorted by version. Throws on malformed names and duplicate versions. */
export const discoverMigrations = (dir: string): MigrationFile[] => {
  if (!fs.existsSync(dir)) return [];

  const migrations: MigrationFile[] = [];
  const seen = new Map<string, string>();

  for (const filename of fs.readdirSync(dir).sort()) {
    if (isIgnored(filename)) continue;

    const parsed = parseMigrationFilename(filename);
    if (!parsed) {
      throw new Error(
        `Invalid migration filename "${filename}" in ${dir}. Expected YYYYMMDDHHMMSS_snake_case_name.ts`,
      );
    }

    const duplicate = seen.get(parsed.version);
    if (duplicate) {
      throw new Error(
        `Duplicate migration version ${parsed.version}: ${duplicate} and ${filename}`,
      );
    }
    seen.set(parsed.version, filename);
    migrations.push({ ...parsed, path: path.resolve(dir, filename) });
  }

  return migrations.sort((a, b) => a.version.localeCompare(b.version));
};

export const checksumFile = (filePath: string): string =>
  createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");

export const formatVersion = (date: Date): string =>
  date.toISOString().replace(/\D/g, "").slice(0, 14);

export const toSnakeCase = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

const TEMPLATE = `import type { MigrationTask } from "@ingeniumgolf/migrations";

export const up = async (t: MigrationTask): Promise<void> => {
  await t.none(\`--sql
    -- TODO
  \`);
};

export const down = async (t: MigrationTask): Promise<void> => {
  await t.none(\`--sql
    -- TODO
  \`);
};
`;

/** Writes a new migration file and returns its path. Bumps the timestamp if the version is taken. */
export const createMigrationFile = (
  dir: string,
  description: string,
  now: Date = new Date(),
): string => {
  const name = toSnakeCase(description);
  if (!name)
    throw new Error(
      "Migration description must contain at least one letter or digit",
    );

  fs.mkdirSync(dir, { recursive: true });
  const taken = new Set(discoverMigrations(dir).map((m) => m.version));

  let timestamp = now.getTime();
  while (taken.has(formatVersion(new Date(timestamp)))) timestamp += 1000;

  const filePath = path.resolve(
    dir,
    `${formatVersion(new Date(timestamp))}_${name}.ts`,
  );
  fs.writeFileSync(filePath, TEMPLATE, { flag: "wx" });
  return filePath;
};
