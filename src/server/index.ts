import type { Router } from "express"
import { createFirelinkRouter } from "./routes.js"
import { executeWrite } from "./writer.js"
import { createDrizzleDb } from "./db.js"
import type { FirelinkCollection, FirelinkServerConfig } from "../shared/types.js"
import type { AnyDrizzleDb } from "./db.js"

export interface FirelinkServer {
    /** Express router — mount this on your app with app.use(router) */
    router: Router
    /**
     * Returns a collection handle that writes directly (no HTTP).
     * Suitable for server-side admin writes.
     */
    collection<T extends Record<string, unknown>>(name: string): FirelinkCollection<T>
}

/**
 * Create a firelink server instance.
 *
 * @example
 * ```ts
 * const { router, collection } = await createServer(config);
 * app.use(express.json());
 * app.use(router);
 *
 * const users = collection<User>('users');
 * await users.add({ email: 'alice@example.com' });
 * ```
 */
export async function createServer(config: FirelinkServerConfig): Promise<FirelinkServer> {
    const db: AnyDrizzleDb = await createDrizzleDb(config.sql)
    const router = createFirelinkRouter(config, db)

    function collection<T extends Record<string, unknown>>(collectionName: string): FirelinkCollection<T> {
        return {
            async add(doc: Omit<T, "id">): Promise<{ id: string; data: T }> {
                const result = await executeWrite("add", collectionName, null, doc as Record<string, unknown>, db, config)
                return { id: result.id, data: result.data as T }
            },

            async set(id: string, doc: T): Promise<{ id: string; data: T }> {
                const result = await executeWrite("set", collectionName, id, doc as Record<string, unknown>, db, config)
                return { id: result.id, data: result.data as T }
            },

            async update(id: string, doc: Partial<Omit<T, "id">>): Promise<{ id: string; data: T }> {
                const result = await executeWrite("update", collectionName, id, doc as Record<string, unknown>, db, config)
                return { id: result.id, data: result.data as T }
            },

            async delete(id: string): Promise<{ id: string }> {
                const result = await executeWrite("delete", collectionName, id, null, db, config)
                return { id: result.id }
            }
        }
    }

    return { router, collection }
}

// Re-export migration sync utilities
export { syncMigrationToFirestore, syncCollectionToFirestore, syncAll } from "./migration-sync.js"

// Re-export config types and error classes for convenience
export type { FirelinkServerConfig } from "../shared/types.js"
export { FirelinkError, SqlWriteError, FirestoreWriteError, FirestoreRetryExhaustedError, AuthError, SchemaError } from "../shared/errors.js"
export { registerAdapter } from "./adapters.js"
export type { TypeAdapter } from "../shared/types.js"
