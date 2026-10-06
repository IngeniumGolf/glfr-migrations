# @ingeniumgolf/migrations

Small, SQL-first PostgreSQL migration runner built on [pg-promise](https://github.com/vitaly-t/pg-promise). Migrations are TypeScript (or JavaScript) files exporting `up` and optionally `down`.

- Timestamped versions (`YYYYMMDDHHMMSS`), so parallel branches don't collide
- One transaction per migration, with an opt-out for statements like `CREATE INDEX CONCURRENTLY`
- Postgres advisory lock, so overlapping deploys never run a migration twice
- Checksums: `status` flags applied migrations that were edited afterwards
- `baseline` to adopt the runner on an existing database

## Install

```sh
pnpm add @ingeniumgolf/migrations
```

Requires Node.js 22.18 or newer, which runs `.ts` migrations natively. Projects that already use `tsx` or `ts-node` can load migrations through those instead.

## Usage

```sh
glfr-migrate create add users table   # migrations/20261006120000_add_users_table.ts
glfr-migrate up                        # apply all pending migrations
glfr-migrate up --step 1               # apply the next migration only
glfr-migrate status
glfr-migrate down                      # roll back the latest migration
glfr-migrate down --step 3
glfr-migrate baseline 20261006120000   # mark everything up to this version as applied
```

| Option              | Default                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| `--dir <path>`      | `./migrations`                                                                                        |
| `--url <url>`       | `$DATABASE_URL`, then libpq `PG*` env vars (`PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`) |
| `--table <name>`    | `glfr_migrations`, may be schema-qualified (`ops.glfr_migrations`)                                    |
| `--env-file <path>` | none; loads a `.env` file before connecting                                                           |

Typical `package.json` scripts:

```json
{
  "scripts": {
    "migrate": "glfr-migrate --env-file .env",
    "migrate:create": "glfr-migrate create"
  }
}
```

### Migration files

```ts
import type { MigrationTask } from "@ingeniumgolf/migrations";

export const up = async (t: MigrationTask): Promise<void> => {
  await t.none(`--sql
    CREATE TABLE widgets (id SERIAL PRIMARY KEY, name TEXT NOT NULL);
  `);
};

export const down = async (t: MigrationTask): Promise<void> => {
  await t.none(`--sql
    DROP TABLE widgets;
  `);
};
```

- `t` is a pg-promise task (`t.none`, `t.any`, `t.one`, …) running inside a transaction.
- Omit `down` for irreversible migrations; `glfr-migrate down` will refuse to roll them back.
- Export `transaction = false` for statements that cannot run in a transaction:

  ```ts
  export const transaction = false;
  ```

- Use `import type` for type-only imports. Node's type stripping removes them; a plain `import { MigrationTask }` would fail at runtime.
- Never edit a migration after it has run on a shared database; add a new one instead. `status` marks edited migrations as `modified`.

### Custom connection settings

If your project names its connection variables differently, wrap the CLI:

```ts
// scripts/migrate.ts
import { runCli } from "@ingeniumgolf/migrations";

runCli(process.argv.slice(2), {
  dir: "db/migrations",
  connection: () => ({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
  }),
}).then((code) => {
  process.exitCode = code;
});
```

Precedence: `--url`, then the wrapper's `connection`, then `DATABASE_URL`, then the libpq `PG*` variables. Every database command prints the target (`Database: host:port/name`) before it runs.

`--env-file` uses Node's `process.loadEnvFile`, which does not override variables already set in your shell.

### Programmatic API

```ts
import { Migrator } from "@ingeniumgolf/migrations";

const migrator = new Migrator({
  connection: process.env.DATABASE_URL!,
  dir: "migrations",
});
try {
  await migrator.up();
} finally {
  await migrator.close();
}
```

### Adopting an existing database

1. Add a first migration that recreates the current schema, e.g. from `pg_dump --schema-only`.
2. On databases that already have that schema, run `glfr-migrate baseline <its version>` once. This records it as applied without running it.
3. Fresh databases run it normally with `glfr-migrate up`.

## Development

```sh
pnpm install
pnpm test:db   # starts Postgres 18 on localhost:54329 via Docker
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:54329/postgres pnpm test
```

Integration tests are skipped when `TEST_DATABASE_URL` is unset.

## Releasing

Releases are published to npm by the [release workflow](.github/workflows/release.yml) when a `v*` tag is pushed, using npm trusted publishing (no npm tokens stored anywhere):

```sh
npm version patch   # or minor / major: bumps package.json, commits, tags
git push --follow-tags
```

The workflow checks that the tag matches `package.json`, runs the tests, and publishes with provenance. See [RELEASE.md](RELEASE.md) for logging in to npm, troubleshooting, and package settings.

## License

MIT
