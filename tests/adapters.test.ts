import { describe, it, expect } from "vitest"
import { adaptRow, registerAdapter } from "../src/server/adapters.js"
import { SchemaError } from "../src/shared/errors.js"

describe("adaptRow", () => {
    it("passes strings through unchanged", () => {
        expect(adaptRow({ name: "Alice" })).toEqual({ name: "Alice" })
    })

    it("passes numbers through unchanged", () => {
        expect(adaptRow({ score: 42, ratio: 3.14 })).toEqual({ score: 42, ratio: 3.14 })
    })

    it("passes booleans through unchanged", () => {
        expect(adaptRow({ active: true })).toEqual({ active: true })
    })

    it("passes null through unchanged", () => {
        expect(adaptRow({ name: null })).toEqual({ name: null })
    })

    it("converts Date to Firestore Timestamp shape", () => {
        const date = new Date("2024-01-15T12:00:00.000Z")
        const result = adaptRow({ createdAt: date })
        expect(result["createdAt"]).toEqual({
            _seconds: Math.floor(date.getTime() / 1000),
            _nanoseconds: (date.getTime() % 1000) * 1_000_000
        })
    })

    it("converts BigInt to string", () => {
        expect(adaptRow({ bigId: BigInt("9007199254740993") })).toEqual({
            bigId: "9007199254740993"
        })
    })

    it("converts Buffer to base64 string", () => {
        const buf = Buffer.from("hello")
        const result = adaptRow({ data: buf })
        expect(result["data"]).toBe(buf.toString("base64"))
    })

    it("converts numeric id to string", () => {
        const result = adaptRow({ id: 7, email: "a@b.com" })
        expect(result["id"]).toBe("7")
    })

    it("leaves string id unchanged", () => {
        const result = adaptRow({ id: "abc-123", email: "a@b.com" })
        expect(result["id"]).toBe("abc-123")
    })

    it("recursively adapts nested objects", () => {
        const date = new Date("2024-06-01T00:00:00.000Z")
        const result = adaptRow({ meta: { createdAt: date, label: "test" } })
        expect((result["meta"] as Record<string, unknown>)["label"]).toBe("test")
        expect((result["meta"] as Record<string, unknown>)["createdAt"]).toMatchObject({
            _seconds: expect.any(Number),
            _nanoseconds: expect.any(Number)
        })
    })

    it("recursively adapts arrays", () => {
        const date = new Date("2024-06-01T00:00:00.000Z")
        const result = adaptRow({ tags: ["a", "b"], dates: [date] })
        expect(result["tags"]).toEqual(["a", "b"])
        expect((result["dates"] as unknown[])[0]).toMatchObject({ _seconds: expect.any(Number) })
    })

    it("handles deeply nested arrays of objects", () => {
        const buf = Buffer.from("x")
        const result = adaptRow({ items: [{ data: buf }] })
        expect(((result["items"] as unknown[])[0] as Record<string, unknown>)["data"]).toBe(buf.toString("base64"))
    })

    it("throws SchemaError for Symbol values", () => {
        expect(() => adaptRow({ sym: Symbol("x") })).toThrow(SchemaError)
    })

    it("throws SchemaError for Function values", () => {
        expect(() => adaptRow({ fn: () => {} })).toThrow(SchemaError)
    })
})

describe("registerAdapter", () => {
    it("registers a custom adapter that takes priority", () => {
        class Celsius {
            constructor(public value: number) {}
        }
        registerAdapter({
            canHandle: v => v instanceof Celsius,
            convert: v => `${(v as Celsius).value}°C`
        })
        const result = adaptRow({ temp: new Celsius(37) })
        expect(result["temp"]).toBe("37°C")
    })
})
