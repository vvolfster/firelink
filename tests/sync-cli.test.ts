/**
 * Unit tests for the `firelink sync` CLI command (syncAllCommand).
 *
 * All external I/O is mocked:
 *   - readFileSync  → returns a fake firelink.config.json
 *   - createDrizzleDb → returns a stub db
 *   - syncAll       → returns controllable results
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// ── Module mocks (hoisted) ────────────────────────────────────────────────────

vi.mock("node:fs", async importOriginal => {
    const actual = await importOriginal<typeof import("node:fs")>()
    return { ...actual, readFileSync: vi.fn() }
})

vi.mock("../src/server/db.js", () => ({
    createDrizzleDb: vi.fn()
}))

vi.mock("../src/server/migration-sync.js", () => ({
    syncAll: vi.fn(),
    syncCollectionToFirestore: vi.fn(),
    syncMigrationToFirestore: vi.fn()
}))

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { readFileSync } from "node:fs"
import { createDrizzleDb } from "../src/server/db.js"
import { syncAll } from "../src/server/migration-sync.js"
import { syncAllCommand } from "../src/cli/sync.js"

const mockReadFileSync = vi.mocked(readFileSync)
const mockCreateDrizzleDb = vi.mocked(createDrizzleDb)
const mockSyncAll = vi.mocked(syncAll)

// ── Helpers ───────────────────────────────────────────────────────────────────

const validConfig = {
    sql: { dialect: "sqlite" as const, filename: ":memory:" },
    firestore: { projectId: "test-project" },
    tables: ["users", "posts"],
    appName: "firelink-test"
}

function setupDefaults() {
    mockReadFileSync.mockReturnValue(JSON.stringify(validConfig) as any)
    mockCreateDrizzleDb.mockResolvedValue({} as any)
    mockSyncAll.mockResolvedValue([
        { collection: "users", synced: 3, errors: [] },
        { collection: "posts", synced: 5, errors: [] }
    ])
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("syncAllCommand", () => {
    let exitSpy: ReturnType<typeof vi.spyOn>
    let consoleSpy: ReturnType<typeof vi.spyOn>
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        setupDefaults()
        // Prevent process.exit from terminating the test runner
        exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never)
        consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
        consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    })

    afterEach(() => {
        vi.clearAllMocks()
        exitSpy.mockRestore()
        consoleSpy.mockRestore()
        consoleErrorSpy.mockRestore()
    })

    it("reads config from default path when no configPath provided", async () => {
        await syncAllCommand()
        expect(mockReadFileSync).toHaveBeenCalledWith(expect.stringContaining("firelink.config.json"), "utf8")
    })

    it("reads config from the provided path", async () => {
        await syncAllCommand("/custom/path/firelink.config.json")
        expect(mockReadFileSync).toHaveBeenCalledWith(expect.stringContaining("firelink.config.json"), "utf8")
    })

    it("throws when config file cannot be read", async () => {
        mockReadFileSync.mockImplementation(() => {
            throw new Error("ENOENT")
        })
        await expect(syncAllCommand()).rejects.toThrow(/Could not read config file/)
    })

    it("throws when config has no tables array", async () => {
        mockReadFileSync.mockReturnValue(JSON.stringify({ ...validConfig, tables: [] }) as any)
        await expect(syncAllCommand()).rejects.toThrow(/non-empty 'tables'/)
    })

    it("calls createDrizzleDb with config.sql", async () => {
        await syncAllCommand()
        expect(mockCreateDrizzleDb).toHaveBeenCalledWith(validConfig.sql)
    })

    it("calls syncAll with db and server config derived from file config", async () => {
        const stubDb = { _stub: true } as any
        mockCreateDrizzleDb.mockResolvedValue(stubDb)

        await syncAllCommand()

        expect(mockSyncAll).toHaveBeenCalledWith(
            stubDb,
            expect.objectContaining({
                sql: validConfig.sql,
                firestore: validConfig.firestore,
                tables: validConfig.tables,
                appName: validConfig.appName
            })
        )
    })

    it("logs per-collection results", async () => {
        await syncAllCommand()
        const logOutput = consoleSpy.mock.calls.flat().join("\n")
        expect(logOutput).toMatch(/users.*3 synced/)
        expect(logOutput).toMatch(/posts.*5 synced/)
    })

    it("does not call process.exit(1) when all syncs succeed", async () => {
        await syncAllCommand()
        expect(exitSpy).not.toHaveBeenCalledWith(1)
    })

    it("calls process.exit(1) when any collection has errors", async () => {
        mockSyncAll.mockResolvedValue([
            { collection: "users", synced: 2, errors: [{ id: "5", error: "write failed" }] },
            { collection: "posts", synced: 5, errors: [] }
        ])

        await syncAllCommand()

        expect(exitSpy).toHaveBeenCalledWith(1)
    })

    it("logs individual error details", async () => {
        mockSyncAll.mockResolvedValue([{ collection: "users", synced: 0, errors: [{ id: "99", error: "boom" }] }])

        await syncAllCommand()

        const errOutput = consoleErrorSpy.mock.calls.flat().join("\n")
        expect(errOutput).toMatch(/id=99/)
        expect(errOutput).toMatch(/boom/)
    })
})
