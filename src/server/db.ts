import type { SqlConfig } from "../shared/types.js"

// We use a loose type here because drizzle-orm exposes different DB types per driver.
// The actual drizzle instance is typed as `unknown` and cast at point of use.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyDrizzleDb = any

/**
 * Create a Drizzle ORM instance from a SqlConfig.
 * Uses dynamic requires so unused drivers don't cause import errors.
 */
export async function createDrizzleDb(config: SqlConfig): Promise<AnyDrizzleDb> {
    const { dialect } = config

    if (dialect === "postgresql") {
        const connectionString = resolveConnectionString(config)
        // Dynamic import to avoid requiring pg when not used

        const pgModule = await import("pg" as string)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const PgPool = (pgModule.default ?? pgModule).Pool as any
        const { drizzle } = await import("drizzle-orm/node-postgres")

        const pool = new PgPool({ connectionString })

        return drizzle(pool)
    }

    if (dialect === "sqlite") {
        if (!config.filename) {
            throw new Error("SqlConfig.filename is required for SQLite dialect")
        }
        const { default: Database } = (await import("better-sqlite3" as string)) as {
            default: typeof import("better-sqlite3")
        }
        const { drizzle } = await import("drizzle-orm/better-sqlite3")
        const sqlite = new Database(config.filename)
        return drizzle(sqlite)
    }

    if (dialect === "mysql") {
        const connectionString = resolveConnectionString(config)

        const mysql2 = await import("mysql2/promise" as string)

        const pool = (mysql2.default ?? mysql2).createPool({ uri: connectionString })
        const { drizzle } = await import("drizzle-orm/mysql2")
        return drizzle(pool)
    }

    throw new Error(`Unsupported SQL dialect: ${dialect as string}`)
}

function resolveConnectionString(config: SqlConfig): string {
    if (config.connectionString) {
        return config.connectionString
    }
    // Build from parts
    const { dialect, host = "localhost", port, database = "", username = "", password = "" } = config
    const proto = dialect === "postgresql" ? "postgresql" : "mysql"
    const portPart = port ? `:${port}` : ""
    const auth = password ? `${username}:${password}` : username
    return `${proto}://${auth}@${host}${portPart}/${database}`
}
