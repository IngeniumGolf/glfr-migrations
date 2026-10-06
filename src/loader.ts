import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { MigrationModule } from "./types";

const ESM_FALLBACK_CODES = new Set([
  "ERR_REQUIRE_ESM",
  "ERR_REQUIRE_ASYNC_MODULE",
  "ERR_UNKNOWN_FILE_EXTENSION",
]);
// require() parsed ESM/TypeScript syntax as plain CommonJS (no type stripping or loader available)
const UNPARSED_MODULE_SYNTAX =
  /Cannot use import statement|Unexpected token 'export'|Unexpected token ':'|Missing initializer/;

const shouldTryImport = (error: unknown): boolean =>
  (error instanceof SyntaxError &&
    UNPARSED_MODULE_SYNTAX.test(error.message)) ||
  ESM_FALLBACK_CODES.has(
    (error as NodeJS.ErrnoException | undefined)?.code ?? "",
  );

const describeLoadError = (filePath: string, error: unknown): Error => {
  const message = error instanceof Error ? error.message : String(error);
  const hint = /does not provide an export named/.test(message)
    ? " Use `import type` for type-only imports such as MigrationTask."
    : /\.[mc]?ts$/.test(filePath)
      ? " TypeScript migrations need Node >= 22.18 (native type stripping) or a TypeScript loader such as tsx or ts-node."
      : "";
  return new Error(`Could not load migration ${filePath}: ${message}.${hint}`, {
    cause: error,
  });
};

const importModule = async (
  filePath: string,
): Promise<Record<string, unknown>> => {
  try {
    // require() first so TypeScript loaders hooked into require (ts-node, tsx) handle .ts files
    return createRequire(filePath)(filePath) as Record<string, unknown>;
  } catch (requireError) {
    if (!shouldTryImport(requireError))
      throw describeLoadError(filePath, requireError);
    try {
      return (await import(pathToFileURL(filePath).href)) as Record<
        string,
        unknown
      >;
    } catch (importError) {
      throw describeLoadError(filePath, importError);
    }
  }
};

export const loadMigration = async (
  filePath: string,
): Promise<MigrationModule> => {
  const loaded = await importModule(filePath);
  const candidate = (
    typeof loaded.up === "function" ? loaded : loaded.default
  ) as Partial<MigrationModule> | undefined;

  if (typeof candidate?.up !== "function") {
    throw new Error(
      `Migration ${filePath} must export an async up(t) function`,
    );
  }
  if (candidate.down !== undefined && typeof candidate.down !== "function") {
    throw new Error(
      `Migration ${filePath} exports a down that is not a function`,
    );
  }

  return candidate as MigrationModule;
};
