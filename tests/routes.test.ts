import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import express from "express"
import request from "supertest"
import { createFirelinkRouter } from "../src/server/routes.js"
import * as writer from "../src/server/writer.js"
import { createTestDb, createTestConfig, TEST_API_KEY } from "./helpers.js"
import { SqlWriteError, FirestoreRetryExhaustedError } from "../src/shared/errors.js"

function buildApp(overrides?: Parameters<typeof createTestConfig>[0]) {
    const { db } = createTestDb()
    const config = createTestConfig(overrides)
    const router = createFirelinkRouter(config, db)
    const app = express()
    app.use(express.json())
    app.use(router)
    return { app, db, config }
}

describe("POST /firelink/:collection (add)", () => {
    let executeWriteSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        executeWriteSpy = vi.spyOn(writer, "executeWrite").mockResolvedValue({
            id: "42",
            data: { id: "42", email: "alice@test.com", name: "Alice", score: null }
        })
    })

    afterEach(() => vi.restoreAllMocks())

    it("returns 201 with id and data on success", async () => {
        const { app } = buildApp()
        const res = await request(app).post("/firelink/users").set("X-Firelink-Key", TEST_API_KEY).send({ email: "alice@test.com", name: "Alice" })

        expect(res.status).toBe(201)
        expect(res.body).toMatchObject({ success: true, id: "42" })
        expect(executeWriteSpy).toHaveBeenCalledWith(
            "add",
            "users",
            null,
            { email: "alice@test.com", name: "Alice" },
            expect.anything(),
            expect.anything(),
            undefined
        )
    })

    it("returns 401 when API key is wrong", async () => {
        const { app } = buildApp()
        const res = await request(app).post("/firelink/users").set("X-Firelink-Key", "wrong-key").send({ email: "x@x.com" })

        expect(res.status).toBe(401)
        expect(executeWriteSpy).not.toHaveBeenCalled()
    })

    it("returns 401 when API key is missing", async () => {
        const { app } = buildApp()
        const res = await request(app).post("/firelink/users").send({ email: "x@x.com" })

        expect(res.status).toBe(401)
    })

    it("passes no apiKey validation when apiKey is not configured", async () => {
        const { app } = buildApp({ apiKey: undefined })
        const res = await request(app).post("/firelink/users").send({ email: "open@test.com" })

        expect(res.status).toBe(201)
    })

    it("extracts and forwards Authorization Bearer token", async () => {
        const { app } = buildApp()
        await request(app)
            .post("/firelink/users")
            .set("X-Firelink-Key", TEST_API_KEY)
            .set("Authorization", "Bearer my-id-token")
            .send({ email: "token@test.com" })

        const callArgs = executeWriteSpy.mock.calls[0]
        expect(callArgs?.[6]).toBe("my-id-token")
    })

    it("returns 400 when body is an array", async () => {
        const { app } = buildApp()
        const res = await request(app)
            .post("/firelink/users")
            .set("X-Firelink-Key", TEST_API_KEY)
            .send([{ email: "x@x.com" }])

        expect(res.status).toBe(400)
    })

    it("returns 500 with error message on SqlWriteError", async () => {
        executeWriteSpy.mockRejectedValue(new SqlWriteError("constraint violation"))
        const { app } = buildApp()
        const res = await request(app).post("/firelink/users").set("X-Firelink-Key", TEST_API_KEY).send({ email: "err@test.com" })

        expect(res.status).toBe(500)
        expect(res.body).toMatchObject({
            success: false,
            error: expect.stringContaining("constraint")
        })
    })

    it("returns 503 on FirestoreRetryExhaustedError", async () => {
        executeWriteSpy.mockRejectedValue(new FirestoreRetryExhaustedError("Firestore gave up", 3, 503))
        const { app } = buildApp()
        const res = await request(app).post("/firelink/users").set("X-Firelink-Key", TEST_API_KEY).send({ email: "retry@test.com" })

        expect(res.status).toBe(503)
    })
})

describe("PUT /firelink/:collection/:id (set)", () => {
    let executeWriteSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        executeWriteSpy = vi.spyOn(writer, "executeWrite").mockResolvedValue({
            id: "1",
            data: { id: "1", email: "set@test.com", name: null, score: null }
        })
    })

    afterEach(() => vi.restoreAllMocks())

    it("returns 200 on success", async () => {
        const { app } = buildApp()
        const res = await request(app)
            .put("/firelink/users/1")
            .set("X-Firelink-Key", TEST_API_KEY)
            .send({ id: 1, email: "set@test.com", name: null, score: null })

        expect(res.status).toBe(200)
        expect(executeWriteSpy).toHaveBeenCalledWith("set", "users", "1", expect.anything(), expect.anything(), expect.anything(), undefined)
    })
})

describe("PATCH /firelink/:collection/:id (update)", () => {
    let executeWriteSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        executeWriteSpy = vi.spyOn(writer, "executeWrite").mockResolvedValue({
            id: "1",
            data: { id: "1", email: "patch@test.com", name: "Updated", score: null }
        })
    })

    afterEach(() => vi.restoreAllMocks())

    it("returns 200 on success", async () => {
        const { app } = buildApp()
        const res = await request(app).patch("/firelink/users/1").set("X-Firelink-Key", TEST_API_KEY).send({ name: "Updated" })

        expect(res.status).toBe(200)
        expect(executeWriteSpy).toHaveBeenCalledWith("update", "users", "1", { name: "Updated" }, expect.anything(), expect.anything(), undefined)
    })
})

describe("DELETE /firelink/:collection/:id (delete)", () => {
    let executeWriteSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        executeWriteSpy = vi.spyOn(writer, "executeWrite").mockResolvedValue({ id: "1" })
    })

    afterEach(() => vi.restoreAllMocks())

    it("returns 200 on success", async () => {
        const { app } = buildApp()
        const res = await request(app).delete("/firelink/users/1").set("X-Firelink-Key", TEST_API_KEY)

        expect(res.status).toBe(200)
        expect(res.body).toMatchObject({ success: true, id: "1" })
        expect(executeWriteSpy).toHaveBeenCalledWith("delete", "users", "1", null, expect.anything(), expect.anything(), undefined)
    })

    it('returns 404 when SqlWriteError mentions "not found"', async () => {
        executeWriteSpy.mockRejectedValue(new SqlWriteError('No row found with id "99"'))
        const { app } = buildApp()
        const res = await request(app).delete("/firelink/users/99").set("X-Firelink-Key", TEST_API_KEY)

        expect(res.status).toBe(404)
    })
})
