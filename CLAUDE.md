# Firelink — Claude Context

## What this project is

`firelink` is a TypeScript npm package that adds a **relational integrity layer on top of Firebase Firestore**. It intercepts writes, validates them against a SQL database first (PostgreSQL, MySQL, or SQLite), then forwards to Firestore. SQL is the source of truth. Both databases are kept in parity.

Firelink does **not** require Drizzle ORM or any specific migration tool. You can use Drizzle, Flyway, raw SQL, Prisma migrate, or anything else — firelink only needs the table names.

## Architecture at a glance

```
┌─────────────────────────────────────────────────────────────┐
│  User's app                                                 │
│                                                             │
│  const users = new UsersModel(client)  ← same on server    │
│  await users.add({ email: 'alice@example.com' })            │
└───────────────────────┬─────────────────────────────────────┘
                        │ HTTP POST /firelink/users
                        ▼
┌─────────────────────────────────────────────────────────────┐
│  Firelink Server  (Node.js, Express)                        │
│                                                             │
│  1. Validate API key                                        │
│  2. BEGIN SQL transaction (pg/mysql) or manual BEGIN        │
│     (sqlite — see SQLite transaction note below)            │
│  3. Raw SQL INSERT/UPDATE/DELETE → get back full row        │
│  4. Adapt types (Date→Timestamp, BigInt→string, etc.)       │
│  5. Write to Firestore (retry 3x, 200/400/800ms backoff)   │
│     - With user token → REST API (enforces security rules) │
│     - Without token  → Admin SDK (bypasses rules)          │
│  6. COMMIT SQL / ROLLBACK if Firestore exhausted retries   │
└───────────┬─────────────────────────┬───────────────────────┘
            │                         │
            ▼                         ▼
      SQL Database              Firestore
   (source of truth)         (kept in parity)
```

## Key files

| File | Role |
|---|---|
| `src/server/writer.ts` | Core write logic: SQL tx + Firestore write + retry/rollback |
| `src/server/routes.ts` | Express router: POST/PUT/PATCH/DELETE /firelink/:collection/:id |
| `src/server/admin.ts` | Shared Firebase Admin Firestore getter (uses `config.appName`) |
| `src/server/adapters.ts` | SQL→Firestore type conversion pipeline |
| `src/server/firestore-rest.ts` | Firestore REST client for user-token writes |
| `src/server/migration-sync.ts` | Post-migration Firestore sync (BulkWriter + orphan cleanup) |
| `src/server/db.ts` | Drizzle factory (pg / sqlite / mysql2 via dynamic import) |
| `src/client/index.ts` | createClient() — HTTP-based collection interface |
| `src/server/index.ts` | createServer() — Express router + direct collection access |
| `src/cli/generate.ts` | Introspects SQL schema → emits firelink.types.ts |
| `src/shared/types.ts` | All shared interfaces including FirelinkInstance |
| `src/shared/errors.ts` | Error class hierarchy |

## Critical implementation detail: SQLite transactions

`better-sqlite3` transactions are **synchronous** and cannot wrap async callbacks. Drizzle's `db.transaction(async tx => {...})` throws "Transaction function cannot return a promise" for SQLite.

The fix is in `writer.ts` via `withTransaction()`:
- **PostgreSQL/MySQL**: uses `db.transaction(async tx => {...})` — full ACID atomicity spanning the Firestore write
- **SQLite**: issues raw `BEGIN` / `COMMIT` / `ROLLBACK` via `db.run(sql\`...\`)` — Node.js single-threaded execution means no interleaving risk

## Raw SQL (no Drizzle table objects)

`writer.ts` and `migration-sync.ts` use Drizzle's `sql` template tag for raw parameterized SQL instead of the Drizzle query builder. This means:
- `config.tables` is `string[]` (just table names), not `Record<string, DrizzleTable>`
- No Drizzle schema objects are needed at runtime
- Users can use any migration tool

Internally, Drizzle is still used for connection pooling and transaction management, but users never see it.

Raw SQL helpers used:
- SQLite: `(db as any).run(sql\`...\`)` (sync, returns `{ lastInsertRowid, changes }`)
- SQLite: `(db as any).all(sql\`...\`)` / `(db as any).get(sql\`...\`)` (sync, returns rows)
- pg/mysql: `(db as any).execute(sql\`...\`)` (async, returns `{ rows }` or `[rows]`)

## User-token vs Admin writes

- **User token present** (client sends `Authorization: Bearer <token>`): server writes via **Firestore REST API** with that token. Security Rules are enforced.
- **No user token**: server writes via **Firebase Admin SDK**. Bypasses Security Rules. Requires `allowAdminWrites: true` (default).

The `FIRESTORE_EMULATOR_HOST` env var is respected by both paths.

## Firebase Admin SDK app name

The Admin SDK app is keyed by `config.appName` (defaults to `'firelink'`). All three uses (writer, syncMigration, syncCollection) share one app instance via `src/server/admin.ts::getAdminFirestore()`. If you run multiple firelink instances in the same process with different Firestore projects, give each a distinct `appName`.

## Generated types (firelink --schema)

Running `firelink --schema` reads `firelink.config.json`, introspects the SQL database (using `information_schema` for pg/mysql, `PRAGMA table_info` for sqlite), and emits a TypeScript file containing:

1. **One interface per table** — e.g. `UsersTable`
2. **One model class per table** — e.g. `UsersModel`, which accepts `FirelinkInstance` (satisfied by both server and client) and exposes typed `add/set/update/delete` methods
3. **`FirelinkModels` type map** — `{ users: UsersTable, posts: PostsTable, ... }`

Both `createServer()` and `createClient()` return objects satisfying `FirelinkInstance`, so `new UsersModel(server)` and `new UsersModel(client)` work identically.

## Test structure

```
tests/
├── adapters.test.ts        # Unit: type adapter pipeline
├── writer.test.ts          # Unit: write logic (firebase-admin mocked)
├── routes.test.ts          # Unit: HTTP routes (writer mocked via vi.spyOn)
├── generate.test.ts        # Unit: CLI schema generation (real SQLite :memory:)
├── migration-sync.test.ts  # Unit: migration sync (firebase-admin mocked)
├── integration.test.ts     # Integration: real Firestore emulator (no mocks)
├── global-setup.ts         # Starts Firestore emulator, sets FIRESTORE_EMULATOR_HOST
└── helpers.ts              # Shared: createTestDb(), createTestConfig(), getDoc(), clearCollection()
```

**IMPORTANT**: Unit test files that mock `firebase-admin` must NOT contain integration tests. The file-level `vi.mock('firebase-admin/...')` intercepts ALL imports from that module within the file — including `helpers.ts`'s `getTestFirestore()`. Integration tests belong in `integration.test.ts` which has no mocks.

The mock for `syncCollectionToFirestore` must include `bulkWriter()` on the Firestore mock and `listDocuments()` on the collection mock — both are used by the BulkWriter path and orphan cleanup.

## Migration sync

### Targeted sync (known IDs)
```ts
await syncMigrationToFirestore(db, 'users', affectedIds, 'update', config)
await syncMigrationToFirestore(db, 'users', deletedIds, 'delete', config)
```
Uses individual `doc().set()` / `doc().delete()` calls with retry. IDs in `affectedIds` missing from SQL are treated as implicit deletes.

### Full collection sync
```ts
const { synced, errors } = await syncCollectionToFirestore(db, 'users', config)
```
Uses `BulkWriter` for maximum throughput. After writing all SQL rows, calls `listDocuments()` to find Firestore docs not present in SQL (orphans) and deletes them via a second `BulkWriter`. This is the correct approach after a migration that may have deleted rows.

## Running tests

```bash
npm test              # run all tests (starts Firestore emulator automatically)
npm run test:watch    # watch mode
npm run test:coverage # coverage report
npm run lint          # prettier + eslint --fix
npm run lint:check    # prettier + eslint (CI, no writes)
```

Requires Java 11+ for the Firestore emulator. On Windows, the global setup probes common JDK install paths and injects the Java bin directory into PATH before spawning the emulator process.

## Type adapters

The pipeline in `adapters.ts` handles:
- `null` / `undefined` → `null`
- `Date` → `{ _seconds, _nanoseconds }` (Firestore Timestamp shape)
- `BigInt` → `string`
- `Buffer` / `Uint8Array` → base64 string
- numeric `id` column → `string` (Firestore doc IDs are always strings)
- plain objects and arrays → recursively adapted
- `Symbol` / `Function` → throws `SchemaError`

Custom adapters can be registered: `import { registerAdapter } from 'firelink/server'`.

## Error hierarchy

```
FirelinkError
├── SqlWriteError              — SQL INSERT/UPDATE/DELETE failed
├── FirestoreWriteError        — Single Firestore write attempt failed
│   └── FirestoreRetryExhaustedError  — All 3 retries failed (triggers SQL rollback)
├── AuthError                  — Bad/missing API key or token
├── BadRequestError            — Malformed request body
└── SchemaError                — Unmappable type or missing id column
```

HTTP status mapping in `routes.ts::sendError()`:
- `AuthError` → status from `err.statusCode` (401 or 403)
- `BadRequestError` → 400
- `FirestoreRetryExhaustedError` → 503
- `SqlWriteError` matching `/no row found/i` → 404
- All other `FirelinkError` → 500

## Package exports

```
firelink           → src/index.ts  (shared types + errors)
firelink/server    → src/server/index.ts  (createServer, registerAdapter, error classes)
firelink/client    → src/client/index.ts  (createClient)
```

CLI binary: `firelink` → `src/cli/index.ts`
