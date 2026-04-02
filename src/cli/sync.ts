import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { FirelinkConfigFile } from "../shared/types.js"

/**
 * CLI handler for `firelink sync`.
 *
 * Reads firelink.config.json, opens a Drizzle DB connection, and calls
 * syncAll() to push every table in config.tables to Firestore via BulkWriter.
 */
export async function syncAllCommand(configPath?: string): Promise<void> {
    const cfgPath = resolve(configPath ?? "firelink.config.json")
    let config: FirelinkConfigFile

    try {
        config = JSON.parse(readFileSync(cfgPath, "utf8")) as FirelinkConfigFile
    } catch {
        throw new Error(`Could not read config file: ${cfgPath}`)
    }

    if (!config.tables || config.tables.length === 0) {
        throw new Error("firelink.config.json must include a non-empty 'tables' array")
    }

    const { createDrizzleDb } = await import("../server/db.js")
    const { syncAll } = await import("../server/migration-sync.js")

    const db = await createDrizzleDb(config.sql)

    // Build a minimal server config from the file config
    const serverConfig = {
        sql: config.sql,
        firestore: config.firestore,
        tables: config.tables,
        appName: config.appName
    }

    console.log(`Syncing ${config.tables.length} collection(s) to Firestore…`)

    const results = await syncAll(db, serverConfig)

    let totalSynced = 0
    let totalErrors = 0

    for (const r of results) {
        totalSynced += r.synced
        totalErrors += r.errors.length
        const status = r.errors.length === 0 ? "✓" : "✗"
        console.log(`  ${status} ${r.collection}: ${r.synced} synced, ${r.errors.length} errors`)
        for (const e of r.errors) {
            console.error(`      id=${e.id}: ${e.error}`)
        }
    }

    console.log(`\nDone. Total: ${totalSynced} synced, ${totalErrors} errors.`)

    if (totalErrors > 0) {
        process.exit(1)
    }
}
