import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMigrationFile,
  discoverMigrations,
  formatVersion,
  parseMigrationFilename,
  toSnakeCase,
} from "../src/files";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "glfr-migrations-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const touch = (filename: string): void =>
  fs.writeFileSync(path.join(dir, filename), "");

describe("parseMigrationFilename", () => {
  it("parses version and name", () => {
    expect(parseMigrationFilename("20261006120000_add_users_table.ts")).toEqual(
      {
        version: "20261006120000",
        name: "add users table",
        filename: "20261006120000_add_users_table.ts",
      },
    );
  });

  it("rejects the old api-gateway <n>_<date>_<time>_name format", () => {
    expect(
      parseMigrationFilename("0_20260915_000000_create_api_keys.ts"),
    ).toBeNull();
  });
});

describe("discoverMigrations", () => {
  it("returns an empty list for a missing directory", () => {
    expect(discoverMigrations(path.join(dir, "nope"))).toEqual([]);
  });

  it("sorts by version and ignores non-migration files", () => {
    touch("20261006120000_second.ts");
    touch("20261001120000_first.js");
    touch("README.md");
    touch("helpers.d.ts");
    touch("20261006120000_second.test.ts");
    touch(".DS_Store");

    expect(discoverMigrations(dir).map((m) => m.filename)).toEqual([
      "20261001120000_first.js",
      "20261006120000_second.ts",
    ]);
  });

  it("throws on malformed migration filenames", () => {
    touch("2026_add_users.ts");
    expect(() => discoverMigrations(dir)).toThrow(/Invalid migration filename/);
  });

  it("throws on duplicate versions", () => {
    touch("20261006120000_one.ts");
    touch("20261006120000_two.ts");
    expect(() => discoverMigrations(dir)).toThrow(
      /Duplicate migration version/,
    );
  });
});

describe("createMigrationFile", () => {
  const now = new Date("2026-10-06T12:34:56.789Z");

  it("writes a UTC-timestamped file from the description", () => {
    const filePath = createMigrationFile(dir, "Add Users & Roles", now);
    expect(path.basename(filePath)).toBe("20261006123456_add_users_roles.ts");
    expect(fs.readFileSync(filePath, "utf8")).toContain("export const up");
  });

  it("bumps the timestamp when the version is taken", () => {
    createMigrationFile(dir, "first", now);
    const second = createMigrationFile(dir, "second", now);
    expect(path.basename(second)).toBe("20261006123457_second.ts");
  });

  it("rejects descriptions without letters or digits", () => {
    expect(() => createMigrationFile(dir, "---", now)).toThrow();
  });
});

describe("helpers", () => {
  it("formats versions in UTC", () => {
    expect(formatVersion(new Date("2026-01-02T03:04:05Z"))).toBe(
      "20260102030405",
    );
  });

  it("snake-cases descriptions", () => {
    expect(toSnakeCase("  Add GIN index: users.email ")).toBe(
      "add_gin_index_users_email",
    );
  });
});
