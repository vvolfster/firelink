/**
 * Shared test helpers: in-memory SQLite DB + Drizzle setup, Firestore admin client.
 */
import Database from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import type { AnyDrizzleDb } from "../src/server/db.js"
import type { FirelinkServerConfig } from "../src/shared/types.js"

// ---------------------------------------------------------------------------
// Raw DDL — no Drizzle table objects needed
// ---------------------------------------------------------------------------

const CREATE_USERS = `
  CREATE TABLE IF NOT EXISTS users (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT    NOT NULL,
    name  TEXT,
    score REAL
  )
`

const CREATE_POSTS = `
  CREATE TABLE IF NOT EXISTS posts (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    title   TEXT    NOT NULL,
    body    TEXT,
    user_id INTEGER NOT NULL
  )
`

// ---------------------------------------------------------------------------
// Factory: fresh in-memory SQLite DB per test
// ---------------------------------------------------------------------------

export function createTestDb(): { db: AnyDrizzleDb; sqlite: Database.Database } {
    const sqlite = new Database(":memory:")
    sqlite.exec(CREATE_USERS)
    sqlite.exec(CREATE_POSTS)
    const db = drizzle(sqlite) as AnyDrizzleDb
    return { db, sqlite }
}

// ---------------------------------------------------------------------------
// Firelink server config for tests
// ---------------------------------------------------------------------------

export const TEST_PROJECT = process.env["FIRELINK_TEST_PROJECT"] ?? "demo-firelink-test"
export const TEST_API_KEY = "test-api-key-123"

export function createTestConfig(overrides?: Partial<FirelinkServerConfig>): FirelinkServerConfig {
    return {
        sql: { dialect: "sqlite", filename: ":memory:" },
        firestore: { projectId: TEST_PROJECT },
        tables: ["users", "posts"],
        apiKey: TEST_API_KEY,
        allowAdminWrites: true,
        appName: "firelink-test-runner",
        ...overrides
    }
}

// ---------------------------------------------------------------------------
// Firestore Admin client pointed at the emulator
// ---------------------------------------------------------------------------

let _adminFirestore: import("firebase-admin/firestore").Firestore | null = null

export async function getTestFirestore(): Promise<import("firebase-admin/firestore").Firestore> {
    if (_adminFirestore) return _adminFirestore

    const { initializeApp, getApps } = await import("firebase-admin/app")
    const { getFirestore } = await import("firebase-admin/firestore")

    const existing = getApps().find(a => a.name === "firelink-test")
    const app = existing ?? initializeApp({ projectId: TEST_PROJECT }, "firelink-test")

    _adminFirestore = getFirestore(app)
    return _adminFirestore
}

/** Delete all documents in a collection (for test cleanup). */
export async function clearCollection(collectionName: string): Promise<void> {
    const fs = await getTestFirestore()
    const snap = await fs.collection(collectionName).get()
    const batch = fs.batch()
    snap.docs.forEach(doc => batch.delete(doc.ref))
    await batch.commit()
}

/** Read a single Firestore document (for assertions). */
export async function getDoc(collectionName: string, id: string): Promise<Record<string, unknown> | null> {
    const fs = await getTestFirestore()
    const doc = await fs.collection(collectionName).doc(id).get()
    return doc.exists ? (doc.data() as Record<string, unknown>) : null
}

/** Returns true if the emulator is available. */
export function emulatorAvailable(): boolean {
    return process.env["FIRESTORE_EMULATOR_AVAILABLE"] === "true"
}
