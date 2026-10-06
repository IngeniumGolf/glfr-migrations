import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMigration } from "../src/loader";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "glfr-migrations-loader-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const write = (filename: string, content: string): string => {
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, content);
  return filePath;
};

describe("loadMigration", () => {
  it.each([
    [
      "CommonJS",
      "m.cjs",
      "exports.up = async () => {}; exports.transaction = false;",
    ],
    [
      "ES module",
      "m.mjs",
      "export const up = async () => {}; export const transaction = false;",
    ],
    [
      "TypeScript",
      "m.ts",
      "export const up = async (_t: unknown): Promise<void> => {}; export const transaction = false;",
    ],
  ])("loads %s migrations", async (_kind, filename, content) => {
    const migration = await loadMigration(write(filename, content));
    expect(typeof migration.up).toBe("function");
    expect(migration.transaction).toBe(false);
  });

  it("requires an up function", async () => {
    await expect(
      loadMigration(write("m.cjs", "exports.down = async () => {};")),
    ).rejects.toThrow(/must export an async up/);
  });

  it("explains non-type imports of type-only names", async () => {
    const filePath = write(
      "m.ts",
      'import { NotThere } from "node:path";\nexport const up = async (_t: NotThere) => {};\n',
    );
    await expect(loadMigration(filePath)).rejects.toThrow(/Use `import type`/);
  });
});
