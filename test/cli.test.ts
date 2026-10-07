import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli";

const mocks = vi.hoisted(() => ({
  constructor: vi.fn(),
  status: vi.fn(async () => []),
  close: vi.fn(async () => {}),
}));

vi.mock("../src/migrator", () => ({
  Migrator: class {
    constructor(options: unknown) {
      mocks.constructor(options);
    }
    status = mocks.status;
    close = mocks.close;
  },
}));

let dir: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
  for (const key of [
    "DATABASE_URL",
    "PGHOST",
    "PGPORT",
    "PGDATABASE",
    "PGUSER",
    "PGPASSWORD",
    "DB_HOST",
    "DB_NAME",
    "DB_USER",
  ]) {
    delete process.env[key];
  }
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "glfr-cli-"));
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.clearAllMocks();
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const writeEnv = (filename: string, content: string): string => {
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, content);
  return filePath;
};

describe("CLI environment configuration", () => {
  it("loads .env from the current working directory by default", async () => {
    writeEnv(".env", "DATABASE_URL=postgres://test@default.example/glfr\n");
    expect(await runCli(["status"])).toBe(0);
    expect(mocks.constructor).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: "postgres://test@default.example/glfr",
      }),
    );
    expect(mocks.close).toHaveBeenCalled();
  });

  it("uses an explicit env file instead of .env", async () => {
    writeEnv(".env", "DATABASE_URL=postgres://test@default.example/glfr\n");
    const file = writeEnv(
      "custom.env",
      "DATABASE_URL=postgres://test@explicit.example/glfr\n",
    );
    await runCli(["status", "--env-file", file]);
    expect(mocks.constructor).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: "postgres://test@explicit.example/glfr",
      }),
    );
  });

  it("preserves shell variables over file values", async () => {
    process.env.DATABASE_URL = "postgres://test@shell.example/glfr";
    writeEnv(".env", "DATABASE_URL=postgres://test@file.example/glfr\n");
    await runCli(["status"]);
    expect(mocks.constructor).toHaveBeenCalledWith(
      expect.objectContaining({ connection: process.env.DATABASE_URL }),
    );
  });

  it("works without a file when CI supplies PG variables", async () => {
    Object.assign(process.env, {
      PGHOST: "ci.example",
      PGDATABASE: "glfr",
      PGUSER: "test",
    });
    await runCli(["status"]);
    expect(mocks.constructor).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: expect.objectContaining({
          host: "ci.example",
          database: "glfr",
          user: "test",
        }),
      }),
    );
  });

  it("loads the file before invoking the project's connection wrapper", async () => {
    writeEnv(".env", "DB_HOST=wrapper.example\nDB_NAME=glfr\nDB_USER=test\n");
    await runCli(["status"], {
      connection: () => ({
        host: process.env.DB_HOST,
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
      }),
    });
    expect(mocks.constructor).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: { host: "wrapper.example", database: "glfr", user: "test" },
      }),
    );
  });

  it("rejects a missing explicit file even if shell settings exist", async () => {
    process.env.DATABASE_URL = "postgres://test@shell.example/glfr";
    await expect(
      runCli(["status", "--env-file", path.join(dir, "missing.env")]),
    ).rejects.toThrow("Environment file not found");
    expect(mocks.constructor).not.toHaveBeenCalled();
  });

  it("fails before connecting when settings are absent", async () => {
    await expect(runCli(["status"])).rejects.toThrow(
      "Create a .env file, pass --env-file",
    );
    expect(mocks.constructor).not.toHaveBeenCalled();
  });

  it("validates wrapper settings instead of falling back to localhost", async () => {
    await expect(
      runCli(["status"], { connection: () => ({ database: "glfr" }) }),
    ).rejects.toThrow("host, user");
    expect(mocks.constructor).not.toHaveBeenCalled();
  });

  it.each([
    "not-a-url",
    "https://test@example.com/glfr",
    "postgres://localhost",
  ])("rejects an invalid connection URL without exposing it", async (url) => {
    await expect(runCli(["status", "--url", url])).rejects.toThrow(
      /connection URL|Connection URL/,
    );
    expect(mocks.constructor).not.toHaveBeenCalled();
  });

  it("does not need env configuration to create migrations or show help/version", async () => {
    const missing = path.join(dir, "missing.env");
    expect(await runCli(["create", "widgets", "--env-file", missing])).toBe(0);
    expect(await runCli(["--help", "--env-file", missing])).toBe(0);
    expect(await runCli(["--version", "--env-file", missing])).toBe(0);
    expect(fs.readdirSync(path.join(dir, "migrations"))).toHaveLength(1);
    expect(mocks.constructor).not.toHaveBeenCalled();
  });
});
