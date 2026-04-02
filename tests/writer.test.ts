import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Must be at top level — Vitest hoists vi.mock calls before any imports.
vi.mock("firebase-admin/firestore", () => ({
    getFirestore: vi.fn().mockReturnValue({
        collection: vi.fn().mockReturnValue({
            doc: vi.fn().mockReturnValue({
                set: vi.fn().mockResolvedValue(undefined),
                delete: vi.fn().mockResolvedValue(undefined)
            })
        })
    })
}))

vi.mock("firebase-admin/app", () => ({
    initializeApp: vi.fn().mockReturnValue({ name: "firelink" }),
    getApps: vi.fn().mockReturnValue([{ name: "firelink" }]),
    cert: vi.fn(),
    applicationDefault: vi.fn()
}))

import { executeWrite } from "../src/server/writer.js"
import * as firestoreRest from "../src/server/firestore-rest.js"
import { FirestoreRetryExhaustedError, SqlWriteError } from "../src/shared/errors.js"
import { createTestDb, createTestConfig } from "./helpers.js"
import type { AnyDrizzleDb } from "../src/server/db.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb() {
    return createTestDb()
}

function rowCount(db: AnyDrizzleDb, table: string): number {
    // Use raw sqlite for simple assertions
    return (db as any).session.client.prepare(`SELECT COUNT(*) as n FROM ${table}`).get().n as number
}

// ---------------------------------------------------------------------------
// Unit tests — Firestore writes are mocked
// ---------------------------------------------------------------------------

describe("executeWrite (Firestore mocked)", () => {
    let db: AnyDrizzleDb
    let writeDocSpy: ReturnType<typeof vi.spyOn>
    let deleteDocSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        ;({ db } = makeDb())

        // Mock the REST write path (user-token)
        writeDocSpy = vi.spyOn(firestoreRest, "writeDocument").mockResolvedValue(undefined)
        deleteDocSpy = vi.spyOn(firestoreRest, "deleteDocument").mockResolvedValue(undefined)
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    // --- add ---

    it("add: inserts row into SQL and calls Firestore write", async () => {
        const config = createTestConfig()
        const result = await executeWrite("add", "users", null, { email: "alice@test.com", name: "Alice", score: null }, db, config)

        expect(result.id).toBe("1")
        expect(result.data).toMatchObject({ email: "alice@test.com", name: "Alice" })
        expect(rowCount(db, "users")).toBe(1)
    })

    it("add: uses REST write when userToken is provided", async () => {
        const config = createTestConfig()
        await executeWrite("add", "users", null, { email: "b@test.com", name: null, score: null }, db, config, "user-id-token")
        expect(writeDocSpy).toHaveBeenCalledTimes(1)
        expect(writeDocSpy.mock.calls[0]?.[4]).toBe("user-id-token")
    })

    it("add: rolls back SQL transaction when Firestore fails after all retries", async () => {
        writeDocSpy.mockRejectedValue(new Error("Firestore unavailable"))

        const config = createTestConfig()
        await expect(executeWrite("add", "users", null, { email: "c@test.com", name: null, score: null }, db, config, "token")).rejects.toThrow(
            FirestoreRetryExhaustedError
        )

        // Row must NOT be committed
        expect(rowCount(db, "users")).toBe(0)
    })

    it("add: retries Firestore write 3 times before giving up", async () => {
        writeDocSpy.mockRejectedValue(new Error("flaky"))

        const config = createTestConfig()
        await expect(executeWrite("add", "users", null, { email: "d@test.com", name: null, score: null }, db, config, "token")).rejects.toThrow(
            FirestoreRetryExhaustedError
        )

        expect(writeDocSpy).toHaveBeenCalledTimes(3)
    })

    it("add: succeeds on the third attempt (flaky Firestore)", async () => {
        let calls = 0
        writeDocSpy.mockImplementation(async () => {
            calls++
            if (calls < 3) throw new Error("transient")
        })

        const config = createTestConfig()
        const result = await executeWrite("add", "users", null, { email: "e@test.com", name: null, score: null }, db, config, "token")
        expect(result.id).toBe("1")
        expect(writeDocSpy).toHaveBeenCalledTimes(3)
        expect(rowCount(db, "users")).toBe(1)
    })

    // --- set ---

    it("set: upserts row and writes to Firestore", async () => {
        const config = createTestConfig()
        const result = await executeWrite("set", "users", "1", { id: 1, email: "alice@test.com", name: "Alice", score: 9.5 }, db, config, "token")
        expect(result.id).toBe("1")
        expect(rowCount(db, "users")).toBe(1)
    })

    // --- update ---

    it("update: updates existing row and writes to Firestore", async () => {
        const config = createTestConfig()
        // Insert a row first
        await executeWrite("add", "users", null, { email: "f@test.com", name: "Old", score: null }, db, config, "token")
        expect(writeDocSpy).toHaveBeenCalledTimes(1)

        const result = await executeWrite("update", "users", "1", { name: "New" }, db, config, "token")
        expect(result.data).toMatchObject({ name: "New", email: "f@test.com" })
        expect(writeDocSpy).toHaveBeenCalledTimes(2)
    })

    it("update: throws SqlWriteError when row does not exist", async () => {
        const config = createTestConfig()
        await expect(executeWrite("update", "users", "999", { name: "Ghost" }, db, config, "token")).rejects.toThrow(SqlWriteError)
    })

    // --- delete ---

    it("delete: removes row from SQL and calls Firestore delete", async () => {
        const config = createTestConfig()
        await executeWrite("add", "users", null, { email: "g@test.com", name: null, score: null }, db, config, "token")

        const result = await executeWrite("delete", "users", "1", null, db, config, "token")
        expect(result.id).toBe("1")
        expect(rowCount(db, "users")).toBe(0)
        expect(deleteDocSpy).toHaveBeenCalledTimes(1)
    })

    it("delete: rolls back SQL when Firestore delete fails", async () => {
        const config = createTestConfig()
        await executeWrite("add", "users", null, { email: "h@test.com", name: null, score: null }, db, config, "token")
        expect(rowCount(db, "users")).toBe(1)

        deleteDocSpy.mockRejectedValue(new Error("delete failed"))
        await expect(executeWrite("delete", "users", "1", null, db, config, "token")).rejects.toThrow(FirestoreRetryExhaustedError)

        // Row must still be present after rollback
        expect(rowCount(db, "users")).toBe(1)
    })

    // --- validation ---

    it("throws SqlWriteError for unknown collection", async () => {
        const config = createTestConfig()
        await expect(executeWrite("add", "nonexistent", null, { foo: "bar" }, db, config)).rejects.toThrow(SqlWriteError)
    })

    it("throws SqlWriteError when data is missing for add", async () => {
        const config = createTestConfig()
        await expect(executeWrite("add", "users", null, null, db, config)).rejects.toThrow(SqlWriteError)
    })
})

// Integration tests live in tests/integration.test.ts (no firebase-admin mocks).
