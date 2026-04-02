import { FirestoreWriteError } from "../shared/errors.js"

/**
 * Returns the Firestore REST base URL.
 * When FIRESTORE_EMULATOR_HOST is set, routes to the local emulator instead.
 */
function getBaseUrl(): string {
    const emulatorHost = process.env["FIRESTORE_EMULATOR_HOST"]
    if (emulatorHost) {
        return `http://${emulatorHost}/v1`
    }
    return "https://firestore.googleapis.com/v1"
}

/**
 * Converts a plain JavaScript value to a Firestore REST API Value object.
 * https://cloud.google.com/firestore/docs/reference/rest/v1/Value
 */
function toFirestoreValue(value: unknown): Record<string, unknown> {
    if (value === null || value === undefined) {
        return { nullValue: null }
    }
    if (typeof value === "boolean") {
        return { booleanValue: value }
    }
    if (typeof value === "number") {
        if (Number.isInteger(value)) {
            return { integerValue: String(value) }
        }
        return { doubleValue: value }
    }
    if (typeof value === "string") {
        return { stringValue: value }
    }
    // Firestore Timestamp (already converted by adapters)
    if (typeof value === "object" && value !== null && "_seconds" in value && "_nanoseconds" in value) {
        const ts = value as { _seconds: number; _nanoseconds: number }
        // RFC3339 format
        const isoString = new Date(ts._seconds * 1000).toISOString()
        return {
            timestampValue: isoString.replace("Z", `${String(ts._nanoseconds).padStart(9, "0")}Z`)
        }
    }
    if (Array.isArray(value)) {
        return {
            arrayValue: {
                values: value.map(toFirestoreValue)
            }
        }
    }
    if (typeof value === "object") {
        const fields: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            fields[k] = toFirestoreValue(v)
        }
        return {
            mapValue: { fields }
        }
    }
    // Fallback: stringify
    return { stringValue: String(value) }
}

/**
 * Converts a plain data object to a Firestore REST API Document fields map.
 */
function toFirestoreDocument(data: Record<string, unknown>): Record<string, unknown> {
    const fields: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(data)) {
        fields[key] = toFirestoreValue(value)
    }
    return { fields }
}

/**
 * Build a Firestore REST document path.
 */
function documentPath(projectId: string, collection: string, docId: string): string {
    return `projects/${projectId}/databases/(default)/documents/${collection}/${docId}`
}

/**
 * Write (create or overwrite) a Firestore document using the REST API with a user token.
 * This enforces Firestore Security Rules because we use the user's ID token.
 */
export async function writeDocument(
    projectId: string,
    collection: string,
    docId: string,
    data: Record<string, unknown>,
    userToken: string,
    attempt = 1
): Promise<void> {
    const path = documentPath(projectId, collection, docId)
    const url = `${getBaseUrl()}/${path}`
    const body = toFirestoreDocument(data)

    const response = await fetch(url, {
        method: "PATCH",
        headers: {
            Authorization: `Bearer ${userToken}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    })

    if (!response.ok) {
        const text = await response.text().catch(() => "")
        throw new FirestoreWriteError(`Firestore REST write failed (${response.status}): ${text}`, attempt, response.status)
    }
}

/**
 * Delete a Firestore document using the REST API with a user token.
 * This enforces Firestore Security Rules because we use the user's ID token.
 */
export async function deleteDocument(projectId: string, collection: string, docId: string, userToken: string, attempt = 1): Promise<void> {
    const path = documentPath(projectId, collection, docId)
    const url = `${getBaseUrl()}/${path}`

    const response = await fetch(url, {
        method: "DELETE",
        headers: {
            Authorization: `Bearer ${userToken}`
        }
    })

    if (!response.ok && response.status !== 404) {
        const text = await response.text().catch(() => "")
        throw new FirestoreWriteError(`Firestore REST delete failed (${response.status}): ${text}`, attempt, response.status)
    }
}
