import { sql } from "drizzle-orm"
import { adaptRow, extractDocumentId } from "./adapters.js"
import { FirestoreRetryExhaustedError, FirestoreWriteError } from "../shared/errors.js"
import { getAdminFirestore } from "./admin.js"
import type { FirelinkServerConfig } from "../shared/types.js"
import type { AnyDrizzleDb } from "./db.js"

const RETRY_DELAYS_MS = [200, 400, 800]
const MAX_ATTEMPTS = 3

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

async function retryWrite(fn: (attempt: number) => Promise<void>): Promise<void> {
    let lastError: FirestoreWriteError | undefined
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            await fn(attempt)
            return
        } catch (err) {
            lastError = err instanceof FirestoreWriteError ? err : new FirestoreWriteError(String(err), attempt, undefined, err)
            if (attempt < MAX_ATTEMPTS) {
                await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 800)
            }
        }
    }
    throw new FirestoreRetryExhaustedError(
        `Firestore sync failed after ${MAX_ATTEMPTS} attempts: ${lastError?.message ?? "unknown"}`,
        MAX_ATTEMPTS,
        lastError?.statusCode,
        lastError
    )
}

/**
 * Execute a raw SELECT and return all rows.
 */
async function rawSelect(db: AnyDrizzleDb, q: ReturnType<typeof sql>, dialect: string): Promise<Record<string, unknown>[]> {
    if (dialect === "sqlite") {
        return (db as any).all(q) as Record<string, unknown>[]
    }
    const result = await (db as any).execute(q)
    return (dialect === "postgresql" ? result.rows : result[0]) as Record<string, unknown>[]
}

/**
 * After a migration runs, call this to sync affected rows to Firestore.
 *
 * For `update` operations, queries the SQL database for each affected ID and
 * writes the latest state to Firestore using the Admin SDK.
 *
 * For `delete` operations, removes the corresponding Firestore documents.
 *
 * IDs present in `affectedIds` but absent from SQL are treated as implicit
 * deletes (the migration may have removed those rows).
 *
 * @param db          - Drizzle instance (already connected)
 * @param collection  - Firestore collection name (must match SQL table name)
 * @param affectedIds - Array of string IDs affected by the migration
 * @param operation   - Whether rows were updated or deleted
 * @param config      - FirelinkServerConfig
 */
export async function syncMigrationToFirestore(
    db: AnyDrizzleDb,
    collection: string,
    affectedIds: string[],
    operation: "update" | "delete",
    config: FirelinkServerConfig
): Promise<void> {
    if (affectedIds.length === 0) return

    if (!config.tables.includes(collection)) {
        throw new Error(`syncMigrationToFirestore: "${collection}" is not in FirelinkServerConfig.tables`)
    }

    const dialect = config.sql.dialect
    const adminFs = await getAdminFirestore(config)

    if (operation === "delete") {
        for (const id of affectedIds) {
            await retryWrite(async attempt => {
                await adminFs.collection(collection).doc(id).delete()
                void attempt
            })
        }
        return
    }

    // operation === 'update': fetch rows from SQL and sync to Firestore
    const t = sql.identifier(collection)
    const idValues = affectedIds.map(id => (isNaN(Number(id)) ? id : Number(id)))
    const inFrags = idValues.map(id => sql`${id}`)
    const inList = sql.join(inFrags, sql.raw(", "))

    const rows = await rawSelect(db, sql`SELECT * FROM ${t} WHERE id IN (${inList})`, dialect)

    for (const row of rows) {
        const docId = extractDocumentId(row)
        const firestoreData = adaptRow(row)

        await retryWrite(async attempt => {
            await adminFs.collection(collection).doc(docId).set(firestoreData)
            void attempt
        })
    }

    // IDs not found in SQL were deleted by the migration — remove from Firestore
    const foundIds = new Set(rows.map(r => String(extractDocumentId(r))))
    const missingIds = affectedIds.filter(id => !foundIds.has(id))

    for (const id of missingIds) {
        await retryWrite(async attempt => {
            await adminFs.collection(collection).doc(id).delete()
            void attempt
        })
    }
}

/**
 * Syncs all rows in a SQL table to a Firestore collection using BulkWriter
 * for maximum throughput. Firestore documents whose IDs no longer exist in
 * SQL are deleted (orphan cleanup).
 *
 * Use this after a migration that affects many or all rows, or to bring a
 * new collection fully in sync.
 */
export async function syncCollectionToFirestore(
    db: AnyDrizzleDb,
    collection: string,
    config: FirelinkServerConfig,
    batchSize = 100
): Promise<{ synced: number; errors: Array<{ id: string; error: string }> }> {
    if (!config.tables.includes(collection)) {
        throw new Error(`syncCollectionToFirestore: "${collection}" is not in FirelinkServerConfig.tables`)
    }

    const dialect = config.sql.dialect
    const t = sql.identifier(collection)
    const adminFs = await getAdminFirestore(config)
    const bulkWriter = adminFs.bulkWriter()

    // Track every ID we read from SQL (used for orphan detection)
    const sqlIds = new Set<string>()
    // Track individual write promises so we can collect per-doc errors
    const writePromises = new Map<string, Promise<unknown>>()

    // Page through all SQL rows and enqueue BulkWriter set operations
    let offset = 0
    while (true) {
        const rows = await rawSelect(db, sql`SELECT * FROM ${t} LIMIT ${batchSize} OFFSET ${offset}`, dialect)
        if (rows.length === 0) break

        for (const row of rows) {
            const docId = extractDocumentId(row)
            const firestoreData = adaptRow(row)
            sqlIds.add(docId)
            writePromises.set(docId, bulkWriter.set(adminFs.collection(collection).doc(docId), firestoreData))
        }

        offset += batchSize
        if (rows.length < batchSize) break
    }

    // Flush all enqueued writes
    await bulkWriter.close()

    // Tally successes and errors from resolved promises
    let synced = 0
    const errors: Array<{ id: string; error: string }> = []

    for (const [docId, promise] of writePromises) {
        try {
            await promise
            synced++
        } catch (err) {
            errors.push({
                id: docId,
                error: err instanceof Error ? err.message : String(err)
            })
        }
    }

    // Orphan cleanup: delete Firestore docs whose IDs are no longer in SQL
    const allDocRefs = await adminFs.collection(collection).listDocuments()
    const orphanRefs = allDocRefs.filter(ref => !sqlIds.has(ref.id))

    if (orphanRefs.length > 0) {
        const deleteBulkWriter = adminFs.bulkWriter()
        for (const ref of orphanRefs) {
            deleteBulkWriter.delete(ref)
        }
        await deleteBulkWriter.close()
    }

    return { synced, errors }
}

/**
 * Syncs every collection in `config.tables` to Firestore using BulkWriter.
 * Returns one result entry per collection.
 */
export async function syncAll(
    db: AnyDrizzleDb,
    config: FirelinkServerConfig,
    batchSize = 100
): Promise<Array<{ collection: string; synced: number; errors: Array<{ id: string; error: string }> }>> {
    const results = []
    for (const collection of config.tables) {
        const result = await syncCollectionToFirestore(db, collection, config, batchSize)
        results.push({ collection, ...result })
    }
    return results
}
