import { sql } from "drizzle-orm"
import { FirestoreRetryExhaustedError, FirestoreWriteError, SqlWriteError } from "../shared/errors.js"
import { adaptRow, extractDocumentId } from "./adapters.js"
import { deleteDocument, writeDocument } from "./firestore-rest.js"
import { getAdminFirestore } from "./admin.js"
import type { FirelinkServerConfig } from "../shared/types.js"
import type { AnyDrizzleDb } from "./db.js"

export type WriteOperation = "add" | "set" | "update" | "delete"

const RETRY_DELAYS_MS = [200, 400, 800]
const MAX_ATTEMPTS = 3

/** Sleep for `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Attempt a Firestore write (or delete), retrying up to MAX_ATTEMPTS times
 * with exponential backoff. Throws FirestoreRetryExhaustedError on final failure.
 */
async function retryFirestoreWrite(fn: (attempt: number) => Promise<void>): Promise<void> {
    let lastError: FirestoreWriteError | undefined
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            await fn(attempt)
            return
        } catch (err) {
            if (err instanceof FirestoreWriteError) {
                lastError = err
            } else {
                lastError = new FirestoreWriteError(`Firestore write threw unexpected error: ${String(err)}`, attempt, undefined, err)
            }
            if (attempt < MAX_ATTEMPTS) {
                await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 800)
            }
        }
    }
    throw new FirestoreRetryExhaustedError(
        `Firestore write failed after ${MAX_ATTEMPTS} attempts: ${lastError?.message ?? "unknown error"}`,
        MAX_ATTEMPTS,
        lastError?.statusCode,
        lastError
    )
}

/**
 * Execute a raw SELECT * WHERE id = ? and return the first row, or undefined.
 * Handles dialect differences in how Drizzle returns results.
 */
async function selectById(db: AnyDrizzleDb, tableName: string, id: number | bigint | string, dialect: string): Promise<Record<string, unknown> | undefined> {
    const q = sql`SELECT * FROM ${sql.identifier(tableName)} WHERE id = ${id}`
    if (dialect === "sqlite") {
        return (db as any).get(q) as Record<string, unknown> | undefined
    }
    const result = await (db as any).execute(q)
    const rows: Record<string, unknown>[] = dialect === "postgresql" ? result.rows : result[0]
    return rows?.[0]
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
 * Perform a SQL INSERT and return the inserted row.
 * Handles PostgreSQL (RETURNING), SQLite (lastInsertRowid), and MySQL (insertId).
 */
async function sqlInsert(db: AnyDrizzleDb, tableName: string, data: Record<string, unknown>, dialect: string): Promise<Record<string, unknown>> {
    if (Object.keys(data).length === 0) {
        throw new SqlWriteError("INSERT data cannot be empty")
    }
    const t = sql.identifier(tableName)
    const colFrags = Object.keys(data).map(c => sql.identifier(c))
    const valFrags = Object.values(data).map(v => sql`${v}`)
    const colsSql = sql.join(colFrags, sql.raw(", "))
    const valsSql = sql.join(valFrags, sql.raw(", "))

    try {
        if (dialect === "postgresql") {
            const res = await (db as any).execute(sql`INSERT INTO ${t} (${colsSql}) VALUES (${valsSql}) RETURNING *`)
            const rows: Record<string, unknown>[] = res.rows
            if (!rows?.length) throw new SqlWriteError("INSERT returned no rows")
            return rows[0]
        }

        if (dialect === "sqlite") {
            const run = (db as any).run(sql`INSERT INTO ${t} (${colsSql}) VALUES (${valsSql})`) as { lastInsertRowid: number | bigint }
            const insertId = Number(run.lastInsertRowid)
            const row = await selectById(db, tableName, insertId, dialect)
            if (!row) throw new SqlWriteError("INSERT succeeded but SELECT returned no rows")
            return row
        }

        if (dialect === "mysql") {
            const [res] = await (db as any).execute(sql`INSERT INTO ${t} (${colsSql}) VALUES (${valsSql})`)
            const insertId = (res as any).insertId as number
            const row = await selectById(db, tableName, insertId, dialect)
            if (!row) throw new SqlWriteError("INSERT succeeded but SELECT returned no rows")
            return row
        }

        throw new SqlWriteError(`Unsupported dialect: ${dialect}`)
    } catch (err) {
        if (err instanceof SqlWriteError) throw err
        throw new SqlWriteError(`SQL INSERT failed: ${String(err)}`, err)
    }
}

/**
 * Perform a SQL UPDATE and return the updated row.
 * Throws SqlWriteError with "No row found" when id does not exist.
 */
async function sqlUpdate(db: AnyDrizzleDb, tableName: string, id: string, data: Record<string, unknown>, dialect: string): Promise<Record<string, unknown>> {
    if (Object.keys(data).length === 0) {
        throw new SqlWriteError("UPDATE data cannot be empty")
    }
    const idValue: number | string = isNaN(Number(id)) ? id : Number(id)
    const t = sql.identifier(tableName)
    const setFrags = Object.keys(data).map(c => sql`${sql.identifier(c)} = ${data[c]}`)
    const setSql = sql.join(setFrags, sql.raw(", "))

    try {
        if (dialect === "postgresql") {
            const res = await (db as any).execute(sql`UPDATE ${t} SET ${setSql} WHERE id = ${idValue} RETURNING *`)
            const rows: Record<string, unknown>[] = res.rows
            if (!rows?.length) throw new SqlWriteError(`No row found with id "${id}" for UPDATE`)
            return rows[0]
        }

        if (dialect === "sqlite") {
            const run = (db as any).run(sql`UPDATE ${t} SET ${setSql} WHERE id = ${idValue}`) as { changes: number }
            if (run.changes === 0) throw new SqlWriteError(`No row found with id "${id}" after UPDATE`)
            const row = await selectById(db, tableName, idValue, dialect)
            if (!row) throw new SqlWriteError(`No row found with id "${id}" after UPDATE`)
            return row
        }

        if (dialect === "mysql") {
            const [res] = await (db as any).execute(sql`UPDATE ${t} SET ${setSql} WHERE id = ${idValue}`)
            if ((res as any).affectedRows === 0) throw new SqlWriteError(`No row found with id "${id}" for UPDATE`)
            const row = await selectById(db, tableName, idValue, dialect)
            if (!row) throw new SqlWriteError(`No row found with id "${id}" after UPDATE`)
            return row
        }

        throw new SqlWriteError(`Unsupported dialect: ${dialect}`)
    } catch (err) {
        if (err instanceof SqlWriteError) throw err
        throw new SqlWriteError(`SQL UPDATE failed: ${String(err)}`, err)
    }
}

/**
 * Perform a SQL DELETE.
 */
async function sqlDelete(db: AnyDrizzleDb, tableName: string, id: string, dialect: string): Promise<void> {
    const idValue: number | string = isNaN(Number(id)) ? id : Number(id)
    const t = sql.identifier(tableName)
    try {
        if (dialect === "sqlite") {
            ;(db as any).run(sql`DELETE FROM ${t} WHERE id = ${idValue}`)
        } else {
            await (db as any).execute(sql`DELETE FROM ${t} WHERE id = ${idValue}`)
        }
    } catch (err) {
        throw new SqlWriteError(`SQL DELETE failed: ${String(err)}`, err)
    }
}

/**
 * Core write function. Begins a SQL transaction, performs the SQL write,
 * maps the result to Firestore format, writes to Firestore (with retry),
 * and commits or rolls back the SQL transaction accordingly.
 */
export async function executeWrite(
    op: WriteOperation,
    collection: string,
    id: string | null,
    data: Record<string, unknown> | null,
    db: AnyDrizzleDb,
    config: FirelinkServerConfig,
    userToken?: string
): Promise<{ id: string; data?: Record<string, unknown> }> {
    if (!config.tables.includes(collection)) {
        throw new SqlWriteError(`Collection "${collection}" is not in FirelinkServerConfig.tables.`)
    }

    const tableName = collection
    const { dialect } = config.sql
    const projectId = config.firestore.projectId

    let sqlRow: Record<string, unknown> | null = null
    let docId: string = id ?? ""

    const result = await withTransaction(db, dialect, async (tx: AnyDrizzleDb) => {
        if (op === "add") {
            if (!data) throw new SqlWriteError("Data is required for add operation")
            sqlRow = await sqlInsert(tx, tableName, data, dialect)
            docId = extractDocumentId(sqlRow)
        } else if (op === "set") {
            if (!id) throw new SqlWriteError("ID is required for set operation")
            if (!data) throw new SqlWriteError("Data is required for set operation")
            const idNum: number | string = isNaN(Number(id)) ? id : Number(id)
            try {
                sqlRow = await sqlUpdate(tx, tableName, id, { ...data, id: idNum }, dialect)
            } catch (err) {
                if (err instanceof SqlWriteError && /no row found/i.test(err.message)) {
                    sqlRow = await sqlInsert(tx, tableName, { ...data, id: idNum }, dialect)
                } else {
                    throw err
                }
            }
            docId = extractDocumentId(sqlRow)
        } else if (op === "update") {
            if (!id) throw new SqlWriteError("ID is required for update operation")
            if (!data) throw new SqlWriteError("Data is required for update operation")
            sqlRow = await sqlUpdate(tx, tableName, id, data, dialect)
            docId = extractDocumentId(sqlRow)
        } else if (op === "delete") {
            if (!id) throw new SqlWriteError("ID is required for delete operation")
            await sqlDelete(tx, tableName, id, dialect)
            docId = id
        }

        const firestoreData = sqlRow ? adaptRow(sqlRow) : null

        await retryFirestoreWrite(async attempt => {
            if (op === "delete") {
                if (userToken) {
                    await deleteDocument(projectId, collection, docId, userToken, attempt)
                } else {
                    const adminFs = await getAdminFirestore(config)
                    await adminFs.collection(collection).doc(docId).delete()
                }
            } else {
                if (!firestoreData) throw new SqlWriteError("Internal: firestoreData is null after write")
                if (userToken) {
                    await writeDocument(projectId, collection, docId, firestoreData, userToken, attempt)
                } else {
                    const adminFs = await getAdminFirestore(config)
                    await adminFs
                        .collection(collection)
                        .doc(docId)
                        .set(firestoreData, { merge: op === "update" })
                }
            }
        })

        return { docId, firestoreData }
    })

    if (op === "delete") {
        return { id: result.docId as string }
    }
    return {
        id: result.docId as string,
        data: result.firestoreData as Record<string, unknown>
    }
}

/**
 * Run `fn` inside a SQL transaction, compatible with both async (pg/mysql) and
 * sync (SQLite / better-sqlite3) drivers.
 *
 * PostgreSQL and MySQL use Drizzle's built-in `db.transaction(async tx => ...)`
 * which holds a dedicated pool connection open across await points.
 *
 * SQLite (better-sqlite3) transactions are synchronous and cannot wrap async
 * callbacks, so we issue raw BEGIN / COMMIT / ROLLBACK instead and pass the
 * same `db` reference (single connection, so no isolation concern in Node.js).
 */
async function withTransaction<T>(db: AnyDrizzleDb, dialect: string, fn: (tx: AnyDrizzleDb) => Promise<T>): Promise<T> {
    if (dialect === "postgresql" || dialect === "mysql") {
        return (db as any).transaction((tx: AnyDrizzleDb) => fn(tx))
    }

    // SQLite: manual transaction control
    ;(db as any).run(sql`BEGIN`)
    try {
        const result = await fn(db)
        ;(db as any).run(sql`COMMIT`)
        return result
    } catch (err) {
        try {
            ;(db as any).run(sql`ROLLBACK`)
        } catch {
            // ignore rollback errors
        }
        throw err
    }
}

// Re-export for migration-sync
export { rawSelect, sql }
