/**
 * Integration tests — require the real Firestore emulator.
 * No firebase-admin mocks in this file so helpers can use the real SDK.
 * All tests are skipped automatically when the emulator is unavailable.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { executeWrite } from "../src/server/writer.js"
import { syncMigrationToFirestore, syncCollectionToFirestore } from "../src/server/migration-sync.js"
import { createTestDb, createTestConfig, clearCollection, getDoc, emulatorAvailable } from "./helpers.js"
import type { AnyDrizzleDb } from "../src/server/db.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let db: AnyDrizzleDb

function insertUser(email: string, name: string | null = null): number {
    const raw: any = (db as any).session.client
    return Number(raw.prepare("INSERT INTO users (email, name, score) VALUES (?, ?, NULL)").run(email, name).lastInsertRowid)
}

function deleteUser(id: number): void {
    ;(db as any).session.client.prepare("DELETE FROM users WHERE id = ?").run(id)
}

// ---------------------------------------------------------------------------
// executeWrite — Firestore emulator round-trips
// ---------------------------------------------------------------------------

describe.skipIf(!emulatorAvailable())("executeWrite (emulator)", () => {
    beforeEach(async () => {
        ;({ db } = createTestDb())
        await clearCollection("users")
    })

    afterEach(async () => {
        await clearCollection("users")
    })

    it("add: document appears in Firestore with correct fields", async () => {
        const config = createTestConfig()
        const result = await executeWrite("add", "users", null, { email: "emulator@test.com", name: "Emulator User", score: null }, db, config)

        const doc = await getDoc("users", result.id)
        expect(doc).not.toBeNull()
        expect(doc?.["email"]).toBe("emulator@test.com")
        expect(doc?.["name"]).toBe("Emulator User")
    })

    it("update: Firestore document reflects updated fields", async () => {
        const config = createTestConfig()
        const { id } = await executeWrite("add", "users", null, { email: "x@test.com", name: "Before", score: null }, db, config)
        await executeWrite("update", "users", id, { name: "After" }, db, config)

        const doc = await getDoc("users", id)
        expect(doc?.["name"]).toBe("After")
        expect(doc?.["email"]).toBe("x@test.com")
    })

    it("delete: document is removed from Firestore", async () => {
        const config = createTestConfig()
        const { id } = await executeWrite("add", "users", null, { email: "del@test.com", name: null, score: null }, db, config)
        await executeWrite("delete", "users", id, null, db, config)

        expect(await getDoc("users", id)).toBeNull()
    })

    it("set: creates document when it does not exist", async () => {
        const config = createTestConfig()
        await executeWrite("set", "users", "99", { id: 99, email: "set@test.com", name: "Set", score: 1.0 }, db, config)

        const doc = await getDoc("users", "99")
        expect(doc?.["email"]).toBe("set@test.com")
    })
})

// ---------------------------------------------------------------------------
// syncMigrationToFirestore — emulator round-trips
// ---------------------------------------------------------------------------

describe.skipIf(!emulatorAvailable())("syncMigrationToFirestore (emulator)", () => {
    beforeEach(async () => {
        ;({ db } = createTestDb())
        await clearCollection("users")
    })

    afterEach(async () => {
        await clearCollection("users")
    })

    it("update: Firestore document matches current SQL row", async () => {
        const config = createTestConfig()
        const id = insertUser("sync@test.com", "SyncUser")

        await syncMigrationToFirestore(db, "users", [String(id)], "update", config)

        const doc = await getDoc("users", String(id))
        expect(doc).not.toBeNull()
        expect(doc?.["email"]).toBe("sync@test.com")
        expect(doc?.["name"]).toBe("SyncUser")
    })

    it("update: syncs multiple rows in one call", async () => {
        const config = createTestConfig()
        const id1 = insertUser("m1@test.com", "One")
        const id2 = insertUser("m2@test.com", "Two")

        await syncMigrationToFirestore(db, "users", [String(id1), String(id2)], "update", config)

        expect(await getDoc("users", String(id1))).toMatchObject({ email: "m1@test.com" })
        expect(await getDoc("users", String(id2))).toMatchObject({ email: "m2@test.com" })
    })

    it("delete: Firestore document is removed", async () => {
        const config = createTestConfig()
        const id = insertUser("del2@test.com", null)

        await syncMigrationToFirestore(db, "users", [String(id)], "update", config)
        expect(await getDoc("users", String(id))).not.toBeNull()

        await syncMigrationToFirestore(db, "users", [String(id)], "delete", config)
        expect(await getDoc("users", String(id))).toBeNull()
    })

    it("update: ID absent from SQL is deleted from Firestore (row deleted by migration)", async () => {
        const config = createTestConfig()
        const id = insertUser("ghost@test.com", null)

        // First sync to Firestore
        await syncMigrationToFirestore(db, "users", [String(id)], "update", config)
        expect(await getDoc("users", String(id))).not.toBeNull()

        // Simulate migration deleting the row from SQL
        deleteUser(id)

        // update sync should detect the row is gone and delete the Firestore doc
        await syncMigrationToFirestore(db, "users", [String(id)], "update", config)
        expect(await getDoc("users", String(id))).toBeNull()
    })
})

// ---------------------------------------------------------------------------
// syncCollectionToFirestore — emulator round-trips
// ---------------------------------------------------------------------------

describe.skipIf(!emulatorAvailable())("syncCollectionToFirestore (emulator)", () => {
    beforeEach(async () => {
        ;({ db } = createTestDb())
        await clearCollection("users")
    })

    afterEach(async () => {
        await clearCollection("users")
    })

    it("syncs all rows from SQL to Firestore", async () => {
        const config = createTestConfig()
        const ids = [insertUser("full1@test.com", "One"), insertUser("full2@test.com", "Two"), insertUser("full3@test.com", "Three")]

        const result = await syncCollectionToFirestore(db, "users", config)

        expect(result.synced).toBe(3)
        expect(result.errors).toHaveLength(0)
        for (const id of ids) {
            expect(await getDoc("users", String(id))).not.toBeNull()
        }
    })

    it("paginates correctly (batchSize=2) and syncs all rows", async () => {
        const config = createTestConfig()
        for (let i = 0; i < 5; i++) insertUser(`p${i}@test.com`, null)

        const result = await syncCollectionToFirestore(db, "users", config, 2)

        expect(result.synced).toBe(5)
        expect(result.errors).toHaveLength(0)
    })

    it("returns synced=0 for an empty table", async () => {
        const config = createTestConfig()
        const result = await syncCollectionToFirestore(db, "users", config)
        expect(result.synced).toBe(0)
        expect(result.errors).toHaveLength(0)
    })
})
