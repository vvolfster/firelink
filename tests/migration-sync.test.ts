/**
 * Tests for syncMigrationToFirestore and syncCollectionToFirestore.
 *
 * Unit tests mock firebase-admin (no emulator required).
 * Integration tests live in tests/integration.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Hoisted module mocks — must be top-level.
vi.mock("firebase-admin/app", () => ({
    initializeApp: vi.fn().mockReturnValue({ name: "firelink-test-runner" }),
    getApps: vi.fn().mockReturnValue([]),
    cert: vi.fn(),
    applicationDefault: vi.fn()
}))

vi.mock("firebase-admin/firestore", () => ({
    getFirestore: vi.fn()
}))

import { syncMigrationToFirestore, syncCollectionToFirestore, syncAll } from "../src/server/migration-sync.js"
import { createTestDb, createTestConfig } from "./helpers.js"
import type { AnyDrizzleDb } from "../src/server/db.js"

// ---------------------------------------------------------------------------
// Mock Firestore helpers
// ---------------------------------------------------------------------------

import { getFirestore } from "firebase-admin/firestore"

const mockGetFirestore = vi.mocked(getFirestore)

interface MockFirestore {
    // Used by syncMigrationToFirestore (individual doc ops)
    setFn: ReturnType<typeof vi.fn>
    deleteFn: ReturnType<typeof vi.fn>
    docFn: ReturnType<typeof vi.fn>
    collectionFn: ReturnType<typeof vi.fn>
    // Used by syncCollectionToFirestore (BulkWriter)
    bulkWriterSetFn: ReturnType<typeof vi.fn>
    bulkWriterDeleteFn: ReturnType<typeof vi.fn>
    bulkWriterCloseFn: ReturnType<typeof vi.fn>
    bulkWriterFn: ReturnType<typeof vi.fn>
    listDocumentsFn: ReturnType<typeof vi.fn>
}

function setupMockFirestore(): MockFirestore {
    // Individual doc ops (syncMigrationToFirestore)
    const setFn = vi.fn().mockResolvedValue(undefined)
    const deleteFn = vi.fn().mockResolvedValue(undefined)
    // docFn returns an object with id so orphan detection (ref.id) works
    const docFn = vi.fn().mockImplementation((id: string) => ({ id, set: setFn, delete: deleteFn }))

    // BulkWriter (syncCollectionToFirestore)
    const bulkWriterSetFn = vi.fn().mockResolvedValue(undefined)
    const bulkWriterDeleteFn = vi.fn().mockResolvedValue(undefined)
    const bulkWriterCloseFn = vi.fn().mockResolvedValue(undefined)
    const bulkWriterFn = vi.fn().mockReturnValue({
        set: bulkWriterSetFn,
        delete: bulkWriterDeleteFn,
        close: bulkWriterCloseFn
    })

    // listDocuments returns doc refs with id (default: no existing docs)
    const listDocumentsFn = vi.fn().mockResolvedValue([])

    const collectionFn = vi.fn().mockReturnValue({
        doc: docFn,
        listDocuments: listDocumentsFn
    })

    mockGetFirestore.mockReturnValue({
        collection: collectionFn,
        bulkWriter: bulkWriterFn
    } as any)

    return {
        setFn,
        deleteFn,
        docFn,
        collectionFn,
        bulkWriterSetFn,
        bulkWriterDeleteFn,
        bulkWriterCloseFn,
        bulkWriterFn,
        listDocumentsFn
    }
}

// ---------------------------------------------------------------------------
// Shared DB setup
// ---------------------------------------------------------------------------

let db: AnyDrizzleDb

function insertUser(email: string, name: string | null = null): number {
    const raw: any = (db as any).session.client
    const stmt = raw.prepare("INSERT INTO users (email, name, score) VALUES (?, ?, NULL)")
    return Number(stmt.run(email, name).lastInsertRowid)
}

// ---------------------------------------------------------------------------
// syncMigrationToFirestore — individual doc ops, with retry
// ---------------------------------------------------------------------------

describe("syncMigrationToFirestore (Firestore mocked)", () => {
    let mocks: MockFirestore

    beforeEach(() => {
        ;({ db } = createTestDb())
        mocks = setupMockFirestore()
    })

    afterEach(() => {
        vi.clearAllMocks()
    })

    it("does nothing when affectedIds is empty", async () => {
        const config = createTestConfig()
        await syncMigrationToFirestore(db, "users", [], "update", config)
        expect(mocks.setFn).not.toHaveBeenCalled()
        expect(mocks.deleteFn).not.toHaveBeenCalled()
    })

    it("throws when collection is not in config.tables", async () => {
        const config = createTestConfig()
        await expect(syncMigrationToFirestore(db, "nonexistent", ["1"], "update", config)).rejects.toThrow(/nonexistent/)
    })

    it("update: fetches each affected row from SQL and sets it in Firestore", async () => {
        const config = createTestConfig()
        const id1 = insertUser("a@test.com", "Alice")
        const id2 = insertUser("b@test.com", "Bob")

        await syncMigrationToFirestore(db, "users", [String(id1), String(id2)], "update", config)

        expect(mocks.setFn).toHaveBeenCalledTimes(2)
        expect(mocks.collectionFn).toHaveBeenCalledWith("users")
        expect(mocks.docFn).toHaveBeenCalledWith(String(id1))
        expect(mocks.docFn).toHaveBeenCalledWith(String(id2))
    })

    it("update: passes adapted row data to Firestore set", async () => {
        const config = createTestConfig()
        const id = insertUser("c@test.com", "Charlie")

        await syncMigrationToFirestore(db, "users", [String(id)], "update", config)

        const [calledData] = mocks.setFn.mock.calls[0]!
        expect(calledData).toMatchObject({ email: "c@test.com", name: "Charlie" })
        expect(typeof calledData.id).toBe("string")
    })

    it("update: treats IDs missing from SQL as implicit deletes in Firestore", async () => {
        const config = createTestConfig()
        const id = insertUser("d@test.com", null)

        await syncMigrationToFirestore(db, "users", [String(id), "999"], "update", config)

        expect(mocks.setFn).toHaveBeenCalledTimes(1)
        expect(mocks.deleteFn).toHaveBeenCalledTimes(1)
        expect(mocks.docFn).toHaveBeenCalledWith("999")
    })

    it("update: only syncs IDs that are in affectedIds, not all rows", async () => {
        const config = createTestConfig()
        const id1 = insertUser("e1@test.com", null)
        insertUser("e2@test.com", null) // not in affectedIds

        await syncMigrationToFirestore(db, "users", [String(id1)], "update", config)

        expect(mocks.setFn).toHaveBeenCalledTimes(1)
        expect(mocks.docFn).toHaveBeenCalledWith(String(id1))
    })

    it("delete: removes each document from Firestore without querying SQL", async () => {
        const config = createTestConfig()
        const id = insertUser("f@test.com", null)

        await syncMigrationToFirestore(db, "users", [String(id), "42"], "delete", config)

        expect(mocks.deleteFn).toHaveBeenCalledTimes(2)
        expect(mocks.setFn).not.toHaveBeenCalled()
        expect(mocks.docFn).toHaveBeenCalledWith(String(id))
        expect(mocks.docFn).toHaveBeenCalledWith("42")
    })

    it("retries a failed Firestore write up to 3 times then throws", async () => {
        const config = createTestConfig()
        const id = insertUser("g@test.com", null)

        mocks.setFn.mockRejectedValue(new Error("Firestore unavailable"))

        await expect(syncMigrationToFirestore(db, "users", [String(id)], "update", config)).rejects.toThrow(/failed after/i)

        expect(mocks.setFn).toHaveBeenCalledTimes(3)
    })

    it("retries a failed Firestore delete up to 3 times then throws", async () => {
        const config = createTestConfig()
        mocks.deleteFn.mockRejectedValue(new Error("Firestore unavailable"))

        await expect(syncMigrationToFirestore(db, "users", ["1"], "delete", config)).rejects.toThrow(/failed after/i)

        expect(mocks.deleteFn).toHaveBeenCalledTimes(3)
    })

    it("succeeds if Firestore write recovers before retries are exhausted", async () => {
        const config = createTestConfig()
        const id = insertUser("h@test.com", null)

        let calls = 0
        mocks.setFn.mockImplementation(async () => {
            if (++calls < 3) throw new Error("transient")
        })

        await syncMigrationToFirestore(db, "users", [String(id)], "update", config)
        expect(mocks.setFn).toHaveBeenCalledTimes(3)
    })
})

// ---------------------------------------------------------------------------
// syncCollectionToFirestore — BulkWriter + orphan cleanup
// ---------------------------------------------------------------------------

describe("syncCollectionToFirestore (Firestore mocked)", () => {
    let mocks: MockFirestore

    beforeEach(() => {
        ;({ db } = createTestDb())
        mocks = setupMockFirestore()
    })

    afterEach(() => {
        vi.clearAllMocks()
    })

    it("syncs all rows in the table to Firestore via BulkWriter", async () => {
        const config = createTestConfig()
        insertUser("i1@test.com", "User1")
        insertUser("i2@test.com", "User2")
        insertUser("i3@test.com", "User3")

        const result = await syncCollectionToFirestore(db, "users", config)

        expect(result.synced).toBe(3)
        expect(result.errors).toHaveLength(0)
        expect(mocks.bulkWriterSetFn).toHaveBeenCalledTimes(3)
        expect(mocks.bulkWriterCloseFn).toHaveBeenCalledTimes(1)
    })

    it("returns synced=0 and no errors when table is empty", async () => {
        const config = createTestConfig()
        const result = await syncCollectionToFirestore(db, "users", config)
        expect(result.synced).toBe(0)
        expect(result.errors).toHaveLength(0)
        expect(mocks.bulkWriterCloseFn).toHaveBeenCalledTimes(1)
    })

    it("collects errors and continues when a BulkWriter write fails", async () => {
        const config = createTestConfig()
        insertUser("j1@test.com", null)
        insertUser("j2@test.com", null)

        // First write fails, second succeeds
        mocks.bulkWriterSetFn.mockRejectedValueOnce(new Error("row 1 failed")).mockResolvedValue(undefined)

        const result = await syncCollectionToFirestore(db, "users", config)

        expect(result.errors).toHaveLength(1)
        expect(result.synced).toBe(1)
    })

    it("paginates correctly with small batchSize", async () => {
        const config = createTestConfig()
        for (let i = 0; i < 5; i++) insertUser(`page${i}@test.com`, null)

        const result = await syncCollectionToFirestore(db, "users", config, 2)

        expect(result.synced).toBe(5)
        expect(mocks.bulkWriterSetFn).toHaveBeenCalledTimes(5)
    })

    it("deletes Firestore docs whose IDs are no longer in SQL (orphan cleanup)", async () => {
        const config = createTestConfig()
        const id = insertUser("k@test.com", null)

        // Firestore has doc '999' that no longer exists in SQL
        mocks.listDocumentsFn.mockResolvedValue([
            { id: String(id) }, // still in SQL — should NOT be deleted
            { id: "999" } // orphan — should be deleted
        ])

        await syncCollectionToFirestore(db, "users", config)

        expect(mocks.bulkWriterDeleteFn).toHaveBeenCalledTimes(1)
        // The orphan BulkWriter gets its own close() call
        expect(mocks.bulkWriterCloseFn).toHaveBeenCalledTimes(2)
    })

    it("skips orphan BulkWriter when there are no orphans", async () => {
        const config = createTestConfig()
        insertUser("l@test.com", null) // id will be 1

        mocks.listDocumentsFn.mockResolvedValue([{ id: "1" }]) // matches SQL

        await syncCollectionToFirestore(db, "users", config)

        expect(mocks.bulkWriterDeleteFn).not.toHaveBeenCalled()
        expect(mocks.bulkWriterCloseFn).toHaveBeenCalledTimes(1) // only the write BulkWriter
    })

    it("throws when collection is not in config.tables", async () => {
        const config = createTestConfig()
        await expect(syncCollectionToFirestore(db, "nonexistent", config)).rejects.toThrow(/nonexistent/)
    })
})

// ---------------------------------------------------------------------------
// syncAll — iterates all tables in config
// ---------------------------------------------------------------------------

describe("syncAll (Firestore mocked)", () => {
    let mocks: MockFirestore

    beforeEach(() => {
        ;({ db } = createTestDb())
        mocks = setupMockFirestore()
    })

    afterEach(() => {
        vi.clearAllMocks()
    })

    it("syncs every table in config.tables and returns one result per collection", async () => {
        const config = createTestConfig() // tables: ['users', 'posts']
        insertUser("m1@test.com", "Mary")

        const results = await syncAll(db, config)

        expect(results).toHaveLength(2)
        expect(results[0]!.collection).toBe("users")
        expect(results[1]!.collection).toBe("posts")
        // users table has 1 row; posts table is empty
        expect(results[0]!.synced).toBe(1)
        expect(results[1]!.synced).toBe(0)
        expect(results[0]!.errors).toHaveLength(0)
        expect(results[1]!.errors).toHaveLength(0)
    })

    it("returns synced=0 for every collection when all tables are empty", async () => {
        const config = createTestConfig()
        const results = await syncAll(db, config)

        expect(results).toHaveLength(2)
        for (const r of results) {
            expect(r.synced).toBe(0)
            expect(r.errors).toHaveLength(0)
        }
    })

    it("accumulates errors from individual collections without stopping", async () => {
        const config = createTestConfig()
        insertUser("n1@test.com", null)

        // First write (users collection) fails
        mocks.bulkWriterSetFn.mockRejectedValueOnce(new Error("users write failed")).mockResolvedValue(undefined)

        const results = await syncAll(db, config)

        const usersResult = results.find(r => r.collection === "users")!
        expect(usersResult.errors).toHaveLength(1)
        expect(usersResult.synced).toBe(0)

        // posts should still succeed (empty table — no writes attempted)
        const postsResult = results.find(r => r.collection === "posts")!
        expect(postsResult.errors).toHaveLength(0)
    })

    it("calls bulkWriter.close() once per collection", async () => {
        const config = createTestConfig()
        await syncAll(db, config)
        // 2 tables × 1 close each (no orphans, so no second BulkWriter)
        expect(mocks.bulkWriterCloseFn).toHaveBeenCalledTimes(2)
    })
})
