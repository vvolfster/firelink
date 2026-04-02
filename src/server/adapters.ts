import { SchemaError } from "../shared/errors.js"
import type { TypeAdapter } from "../shared/types.js"

/** Firestore Timestamp representation for the REST API */
export interface FirestoreTimestamp {
    _seconds: number
    _nanoseconds: number
}

/**
 * Convert a Date to a Firestore REST API timestamp object.
 */
function dateToFirestoreTimestamp(date: Date): FirestoreTimestamp {
    const ms = date.getTime()
    const seconds = Math.floor(ms / 1000)
    const nanoseconds = (ms % 1000) * 1_000_000
    return { _seconds: seconds, _nanoseconds: nanoseconds }
}

/**
 * Built-in type adapters, applied in order.
 */
const builtinAdapters: TypeAdapter[] = [
    // null passthrough
    {
        canHandle: v => v === null,
        convert: () => null
    },
    // undefined → null
    {
        canHandle: v => v === undefined,
        convert: () => null
    },
    // Date → Firestore Timestamp
    {
        canHandle: v => v instanceof Date,
        convert: v => dateToFirestoreTimestamp(v as Date)
    },
    // BigInt → string
    {
        canHandle: v => typeof v === "bigint",
        convert: v => (v as bigint).toString()
    },
    // Buffer → base64 string
    {
        canHandle: v => Buffer.isBuffer(v),
        convert: v => (v as Buffer).toString("base64")
    },
    // Uint8Array → base64 string
    {
        canHandle: v => v instanceof Uint8Array,
        convert: v => Buffer.from(v as Uint8Array).toString("base64")
    },
    // number → as-is (primitive)
    {
        canHandle: v => typeof v === "number",
        convert: v => v
    },
    // boolean → as-is
    {
        canHandle: v => typeof v === "boolean",
        convert: v => v
    },
    // string → as-is
    {
        canHandle: v => typeof v === "string",
        convert: v => v
    },
    // plain object → recurse
    {
        canHandle: v => typeof v === "object" && v !== null && !Array.isArray(v),
        convert: v => adaptRow(v as Record<string, unknown>)
    },
    // array → recurse each element
    {
        canHandle: v => Array.isArray(v),
        convert: v => (v as unknown[]).map(item => adaptValue(item))
    }
]

/** Registry of user-registered adapters (checked before built-ins) */
const customAdapters: TypeAdapter[] = []

/**
 * Register a custom type adapter. Custom adapters are checked before built-in ones.
 */
export function registerAdapter(adapter: TypeAdapter): void {
    customAdapters.unshift(adapter)
}

/**
 * Convert a single value from SQL representation to Firestore-compatible representation.
 * Throws SchemaError if no adapter can handle the value.
 */
export function adaptValue(value: unknown): unknown {
    const allAdapters = [...customAdapters, ...builtinAdapters]
    for (const adapter of allAdapters) {
        if (adapter.canHandle(value)) {
            return adapter.convert(value)
        }
    }
    throw new SchemaError(
        `Cannot map value of type "${Object.prototype.toString.call(value)}" to a Firestore-compatible type. ` +
            `Register a custom TypeAdapter via registerAdapter() to handle this type.`
    )
}

/**
 * Convert all values in a SQL row to Firestore-compatible values.
 * The `id` field, if numeric, is converted to a string suitable for Firestore document IDs.
 */
export function adaptRow(row: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(row)) {
        // The `id` field is always stored as a string in Firestore document IDs.
        if (key === "id" && (typeof value === "number" || typeof value === "bigint")) {
            result[key] = String(value)
        } else {
            result[key] = adaptValue(value)
        }
    }
    return result
}

/**
 * Extract the Firestore document ID from a SQL row.
 * Converts numeric IDs to strings.
 * Falls back to generating a random ID if no `id` column is present.
 */
export function extractDocumentId(row: Record<string, unknown>): string {
    const id = row["id"]
    if (id === undefined || id === null) {
        // No id column — caller should have provided one
        throw new SchemaError('SQL row does not contain an "id" column. Cannot determine Firestore document ID.')
    }
    if (typeof id === "string") {
        return id
    }
    if (typeof id === "number" || typeof id === "bigint") {
        return String(id)
    }
    throw new SchemaError(`SQL "id" column has unexpected type "${typeof id}". Expected string, number, or bigint.`)
}
