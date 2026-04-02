# firelink

A relational integrity layer on top of Firebase Firestore.

Firelink sits between your application and Firestore. Every write goes through a SQL database first — if the SQL write succeeds, it's forwarded to Firestore. If Firestore fails after retries, the SQL write is rolled back. Both databases are always kept in parity, with SQL as the source of truth.

```
your app → firelink → SQL (source of truth)
                   → Firestore (kept in sync)
```

**Why?** Firestore is schemaless and has no foreign keys, constraints, or relational integrity. Firelink lets you enforce all of that via SQL while still using Firestore's realtime subscriptions and client SDKs on the frontend.

---

## How it works

1. Your app calls `users.add({ email: 'alice@example.com' })`
2. Firelink opens a SQL transaction and inserts the row
3. It gets the full row back (including auto-generated ID), adapts types, and writes to Firestore
4. If Firestore succeeds → SQL commits
5. If Firestore fails after 3 retries → SQL rolls back, error is thrown
6. Reads go directly to Firestore — subscriptions work as normal

---

## Installation

```bash
npm install firelink

# Add your SQL driver (pick one)
npm install pg          # PostgreSQL
npm install better-sqlite3  # SQLite
npm install mysql2      # MySQL

# Firebase (peer deps)
npm install firebase-admin  # server
npm install firebase        # client
```

---

## Quick start

### 1. Create your SQL tables

Use any migration tool you like — Drizzle, Flyway, raw SQL, Prisma migrate, or anything else. Firelink only needs the table names; it doesn't care how they were created.

```sql
-- example migration (raw SQL, Drizzle, or whatever you prefer)
CREATE TABLE users (
  id    SERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  name  TEXT,
  score REAL
);

CREATE TABLE posts (
  id      SERIAL PRIMARY KEY,
  title   TEXT NOT NULL,
  body    TEXT,
  user_id INTEGER NOT NULL
);
```

### 2. Configure firelink

```json
// firelink.config.json
{
  "sql": {
    "dialect": "postgresql",
    "connectionString": "postgresql://user:pass@localhost:5432/mydb"
  },
  "firestore": {
    "projectId": "my-firebase-project",
    "serviceAccountPath": "./service-account.json"
  },
  "tables": ["users", "posts"],
  "output": {
    "typesFile": "./firelink.types.ts"
  },
  "apiKey": "your-secret-api-key"
}
```

### 3. Generate typed model classes

```bash
npx firelink --schema
```

This introspects your SQL database and generates `firelink.types.ts`:

```ts
// firelink.types.ts — AUTO-GENERATED, do not edit
export interface UsersTable {
  id: number
  email: string
  name: string | null
  score: number | null
}

export class UsersModel {
  constructor(client: import('firelink').FirelinkInstance) { ... }

  add(doc: Omit<UsersTable, 'id'>): Promise<{ id: string; data: UsersTable }>
  set(id: string, doc: UsersTable): Promise<{ id: string; data: UsersTable }>
  update(id: string, doc: Partial<Omit<UsersTable, 'id'>>): Promise<{ id: string; data: UsersTable }>
  delete(id: string): Promise<{ id: string }>
}

export type FirelinkModels = {
  users: UsersTable
  posts: PostsTable
}
```

### 4. Start the server

```ts
// server.ts
import express from 'express'
import { createServer } from 'firelink/server'
import { UsersModel } from './firelink.types'

const app = express()
app.use(express.json())

const server = await createServer({
  sql: {
    dialect: 'postgresql',
    connectionString: process.env.DATABASE_URL,
  },
  firestore: {
    projectId: 'my-firebase-project',
    serviceAccountPath: './service-account.json',
  },
  tables: ['users', 'posts'],
  apiKey: process.env.FIRELINK_API_KEY,
})

app.use(server.router)
app.listen(3001)

// Server-side writes use the same model class interface as the client
const users = new UsersModel(server)
await users.add({ email: 'server@example.com', name: null, score: null })
```

### 5. Use the client

```ts
// client.ts (browser, React, Next.js, etc.)
import { createClient } from 'firelink/client'
import { getAuth } from 'firebase/auth'
import { UsersModel } from './firelink.types'

const firelinkClient = createClient({
  serverAddr: 'https://api.myapp.com',
  apiKey: process.env.NEXT_PUBLIC_FIRELINK_KEY,
  // Attach the current user's Firebase ID token to every write request.
  // The server uses this token to write to Firestore on the user's behalf,
  // so Firestore Security Rules are enforced as normal.
  getToken: () => getAuth().currentUser?.getIdToken(),
})

// Fully typed — no generics to get wrong
const users = new UsersModel(firelinkClient)

const { id, data } = await users.add({ email: 'alice@example.com', name: 'Alice', score: null })
// id: "1" (SQL auto-generated ID, stringified)
// data: { id: "1", email: "alice@example.com", name: "Alice", score: null }

await users.update(id, { score: 9.5 })

await users.delete(id)
```

### 6. Reads go directly to Firestore

Firelink only intercepts writes. For reads and realtime subscriptions, use the Firebase SDK directly as you normally would:

```ts
import { getFirestore, collection, onSnapshot } from 'firebase/firestore'

const db = getFirestore()

// Realtime subscription — works exactly as before
onSnapshot(collection(db, 'users'), (snapshot) => {
  snapshot.docs.forEach(doc => console.log(doc.data()))
})
```

---

## User-token writes vs admin writes

By default, the server writes to Firestore using the **Firebase Admin SDK**, which bypasses Security Rules. This is suitable for trusted server-side code.

When a client sends a Firebase ID token (`getToken` in the client config), the server instead writes to Firestore using the **Firestore REST API** with that token as a Bearer header. This enforces Security Rules exactly as if the user made the write directly.

```
Client sends Authorization: Bearer <firebase-id-token>
                                    │
                                    ▼
Server verifies token via Admin SDK, then writes via REST API
→ Firestore Security Rules are enforced
```

---

## Migrations

Use any migration tool you prefer. After running a migration that modifies existing rows, call `syncMigrationToFirestore` to propagate the changes to Firestore:

```ts
import { syncMigrationToFirestore, syncCollectionToFirestore } from 'firelink/server'

// After a migration that updated specific rows:
await syncMigrationToFirestore(db, 'users', affectedIds, 'update', config)

// After a migration that deleted rows:
await syncMigrationToFirestore(db, 'users', deletedIds, 'delete', config)

// After a full schema migration — sync the entire collection:
const { synced, errors } = await syncCollectionToFirestore(db, 'users', config)
console.log(`Synced ${synced} documents, ${errors.length} errors`)
```

`syncMigrationToFirestore` is for targeted syncs where you know which IDs changed. If an ID appears in `affectedIds` but no longer exists in SQL, it is automatically deleted from Firestore.

`syncCollectionToFirestore` does a full table sync using Firestore's `BulkWriter` for maximum throughput. It also performs **orphan cleanup** — any Firestore document whose ID no longer exists in SQL is deleted. This handles rows that were removed by the migration without you having to track which IDs were deleted.

---

## Type adapters

Firelink automatically converts SQL types to Firestore-compatible values:

| SQL type | Firestore value |
|---|---|
| `Date` | Firestore Timestamp `{ _seconds, _nanoseconds }` |
| `BigInt` | `string` |
| `Buffer` / `Uint8Array` | base64 string |
| numeric `id` column | string (Firestore doc IDs are always strings) |
| `null` / `undefined` | `null` |
| `number`, `string`, `boolean` | passed through |
| nested objects | recursively adapted |

### Custom adapters

```ts
import { registerAdapter } from 'firelink/server'

registerAdapter({
  canHandle: (value) => value instanceof Decimal,
  convert: (value) => (value as Decimal).toFixed(4),
})
```

Custom adapters are checked before built-ins.

---

## Configuration reference

### Server (`createServer`)

```ts
interface FirelinkServerConfig {
  sql: {
    dialect: 'postgresql' | 'mysql' | 'sqlite'
    connectionString?: string   // or provide individual fields:
    host?: string
    port?: number
    database?: string
    username?: string
    password?: string
    filename?: string           // SQLite only
  }
  firestore: {
    projectId: string
    serviceAccountPath?: string // path to service account JSON
    serviceAccount?: object     // inline service account
  }
  tables: string[]              // SQL table names firelink manages
  apiKey?: string               // if set, clients must send X-Firelink-Key header
  allowAdminWrites?: boolean    // default true — allow writes without user token
  appName?: string              // Firebase Admin SDK app name, defaults to 'firelink'
}
```

### Client (`createClient`)

```ts
interface FirelinkClientConfig {
  serverAddr: string            // e.g. "https://api.myapp.com"
  apiKey?: string               // sent as X-Firelink-Key header
  getToken?: () => Promise<string | null | undefined>  // Firebase ID token getter
}
```

### `firelink.config.json` (for CLI)

```json
{
  "sql": {
    "dialect": "postgresql",
    "connectionString": "postgresql://..."
  },
  "firestore": {
    "projectId": "my-project"
  },
  "tables": ["users", "posts"],
  "appName": "firelink",
  "output": {
    "typesFile": "./firelink.types.ts",
    "firelinkPackage": "firelink"
  }
}
```

---

## Error handling

```ts
import {
  SqlWriteError,
  FirestoreRetryExhaustedError,
  SchemaError,
} from 'firelink/server'

try {
  await users.add({ email: 'alice@example.com', name: null, score: null })
} catch (err) {
  if (err instanceof FirestoreRetryExhaustedError) {
    // SQL was rolled back. Both databases are consistent.
    console.error('Firestore unreachable after 3 attempts:', err.message)
  }
  if (err instanceof SqlWriteError) {
    // SQL constraint violation, missing row, etc.
    console.error('SQL write failed:', err.message)
  }
}
```

HTTP status codes from the server:

| Error | Status |
|---|---|
| Bad API key / missing token | 401 |
| Admin writes disabled | 403 |
| Malformed request body | 400 |
| Row not found (update/delete) | 404 |
| Firestore unreachable | 503 |
| SQL error | 500 |

---

## Supported SQL dialects

| Dialect | Driver | Async transactions |
|---|---|---|
| PostgreSQL | `pg` | Yes — full ACID spanning Firestore write |
| MySQL | `mysql2` | Yes — full ACID spanning Firestore write |
| SQLite | `better-sqlite3` | Manual BEGIN/COMMIT/ROLLBACK |

---

## License

MIT
