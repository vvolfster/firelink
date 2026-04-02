import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import type { FirelinkConfigFile, TableInfo, ColumnInfo } from "../shared/types.js"

/** Map SQL column type strings to TypeScript type strings */
function sqlTypeToTs(sqlType: string, nullable: boolean): string {
    const t = sqlType.toLowerCase()
    let tsType: string

    if (
        t.includes("int") ||
        t.includes("serial") ||
        t.includes("decimal") ||
        t.includes("numeric") ||
        t.includes("float") ||
        t.includes("double") ||
        t.includes("real") ||
        t.includes("money")
    ) {
        tsType = "number"
    } else if (
        t.includes("char") ||
        t.includes("text") ||
        t.includes("uuid") ||
        t.includes("enum") ||
        t.includes("json") ||
        t.includes("xml") ||
        t.includes("clob")
    ) {
        tsType = "string"
    } else if (t.includes("bool")) {
        tsType = "boolean"
    } else if (t.includes("date") || t.includes("time") || t.includes("timestamp")) {
        tsType = "Date"
    } else if (t.includes("blob") || t.includes("bytea") || t.includes("binary")) {
        tsType = "Buffer"
    } else if (t.includes("bigint")) {
        tsType = "bigint"
    } else {
        // Unknown: default to unknown
        tsType = "unknown"
    }

    return nullable ? `${tsType} | null` : tsType
}

/** Convert a snake_case or kebab-case name to PascalCase */
function toPascalCase(name: string): string {
    return name.replace(/[_-]([a-z])/g, (_, c: string) => c.toUpperCase()).replace(/^[a-z]/, c => c.toUpperCase())
}

/** Convert a snake_case or kebab-case name to camelCase */
function toCamelCase(name: string): string {
    const pascal = toPascalCase(name)
    return pascal.charAt(0).toLowerCase() + pascal.slice(1)
}

/** Introspect PostgreSQL tables via information_schema */
async function introspectPostgres(connectionString: string, schemaName = "public"): Promise<TableInfo[]> {
    const pgModule = await import("pg" as string)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const PgClient = (pgModule.default ?? pgModule).Client as any

    const client = new PgClient({ connectionString })

    await client.connect()

    try {
        // Get table names

        const tablesResult = await client.query(
            `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
            [schemaName]
        )

        const tables: TableInfo[] = []

        for (const tableRow of tablesResult.rows as Array<Record<string, string>>) {
            const tableName = tableRow["table_name"] ?? ""

            const colsResult = await client.query(
                `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
         ORDER BY ordinal_position`,
                [schemaName, tableName]
            )

            const columns: ColumnInfo[] = (colsResult.rows as Array<Record<string, string>>).map(col => ({
                name: col["column_name"] ?? "",
                type: col["data_type"] ?? "",
                nullable: col["is_nullable"] === "YES"
            }))

            tables.push({ name: tableName, columns })
        }

        return tables
    } finally {
        await client.end()
    }
}

/** Introspect SQLite tables via PRAGMA */
async function introspectSqlite(filename: string): Promise<TableInfo[]> {
    const { default: Database } = (await import("better-sqlite3" as string)) as {
        default: typeof import("better-sqlite3")
    }
    const db = new Database(filename, { readonly: true })

    try {
        const tableRows = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{
            name: string
        }>

        const tables: TableInfo[] = []

        for (const { name: tableName } of tableRows) {
            const pragmaRows = db.prepare(`PRAGMA table_info("${tableName}")`).all() as Array<{
                name: string
                type: string
                notnull: number
                pk: number
            }>

            const columns: ColumnInfo[] = pragmaRows.map(col => ({
                name: col.name,
                type: col.type || "TEXT",
                nullable: col.notnull === 0 && col.pk === 0
            }))

            tables.push({ name: tableName, columns })
        }

        return tables
    } finally {
        db.close()
    }
}

/** Introspect MySQL tables via information_schema */
async function introspectMysql(connectionString: string): Promise<TableInfo[]> {
    const mysql2 = await import("mysql2/promise" as string)

    const conn = await (mysql2.default ?? mysql2).createConnection(connectionString)

    try {
        // Extract database name from connection string
        const dbMatch = /\/([^/?]+)(\?|$)/.exec(connectionString)
        const dbName = dbMatch?.[1] ?? ""

        const [tableRows] = (await conn.execute(
            `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
       ORDER BY TABLE_NAME`,
            [dbName]
        )) as [Array<Record<string, string>>, unknown]

        const tables: TableInfo[] = []

        for (const tableRow of tableRows) {
            const tableName = tableRow["TABLE_NAME"] ?? ""

            const [colRows] = (await conn.execute(
                `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
         ORDER BY ORDINAL_POSITION`,
                [dbName, tableName]
            )) as [Array<Record<string, string>>, unknown]

            const columns: ColumnInfo[] = colRows.map(col => ({
                name: col["COLUMN_NAME"] ?? "",
                type: col["DATA_TYPE"] ?? "",
                nullable: col["IS_NULLABLE"] === "YES"
            }))

            tables.push({ name: tableName, columns })
        }

        return tables
    } finally {
        await conn.end()
    }
}

/** Generate a TypeScript interface for a table */
function generateInterface(table: TableInfo): string {
    const interfaceName = `${toPascalCase(table.name)}Table`
    const lines: string[] = [`export interface ${interfaceName} {`]

    for (const col of table.columns) {
        const propName = toCamelCase(col.name)
        const tsType = sqlTypeToTs(col.type, col.nullable)
        lines.push(`  ${propName}: ${tsType};`)
    }

    lines.push("}")
    return lines.join("\n")
}

/**
 * Generate a typed model class for a table.
 * The class accepts any FirelinkInstance (server or client) and exposes
 * fully typed add/set/update/delete methods — no generics required from the user.
 */
function generateModelClass(table: TableInfo, firelinkPackage: string): string {
    const interfaceName = `${toPascalCase(table.name)}Table`
    const className = `${toPascalCase(table.name)}Model`
    const collectionName = table.name

    return [
        `export class ${className} {`,
        `  private readonly _collection: import('${firelinkPackage}').FirelinkCollection<${interfaceName}>;`,
        ``,
        `  constructor(client: import('${firelinkPackage}').FirelinkInstance) {`,
        `    this._collection = client.collection<${interfaceName}>('${collectionName}');`,
        `  }`,
        ``,
        `  add(doc: Omit<${interfaceName}, 'id'>): Promise<{ id: string; data: ${interfaceName} }> {`,
        `    return this._collection.add(doc);`,
        `  }`,
        ``,
        `  set(id: string, doc: ${interfaceName}): Promise<{ id: string; data: ${interfaceName} }> {`,
        `    return this._collection.set(id, doc);`,
        `  }`,
        ``,
        `  update(id: string, doc: Partial<Omit<${interfaceName}, 'id'>>): Promise<{ id: string; data: ${interfaceName} }> {`,
        `    return this._collection.update(id, doc);`,
        `  }`,
        ``,
        `  delete(id: string): Promise<{ id: string }> {`,
        `    return this._collection.delete(id);`,
        `  }`,
        `}`
    ].join("\n")
}

/** Generate the FirelinkModels union type */
function generateModelsType(tables: TableInfo[]): string {
    const lines: string[] = ["export type FirelinkModels = {"]
    for (const table of tables) {
        const interfaceName = `${toPascalCase(table.name)}Table`
        lines.push(`  ${table.name}: ${interfaceName};`)
    }
    lines.push("};")
    return lines.join("\n")
}

/** Main entry point for type generation */
export async function generateTypes(configPath?: string): Promise<void> {
    const cwd = process.cwd()
    const cfgPath = configPath ?? resolve(cwd, "firelink.config.json")

    let cfgRaw: string
    try {
        cfgRaw = readFileSync(cfgPath, "utf-8")
    } catch {
        throw new Error(`Could not read config file at ${cfgPath}`)
    }

    const cfg = JSON.parse(cfgRaw) as FirelinkConfigFile
    const { sql } = cfg

    let tables: TableInfo[]

    if (sql.dialect === "postgresql") {
        const connStr =
            sql.connectionString ??
            `postgresql://${sql.username ?? ""}:${sql.password ?? ""}@${sql.host ?? "localhost"}:${sql.port ?? 5432}/${sql.database ?? ""}`
        tables = await introspectPostgres(connStr)
    } else if (sql.dialect === "sqlite") {
        if (!sql.filename) throw new Error("SqlConfig.filename is required for SQLite")
        tables = await introspectSqlite(sql.filename)
    } else if (sql.dialect === "mysql") {
        const connStr =
            sql.connectionString ?? `mysql://${sql.username ?? ""}:${sql.password ?? ""}@${sql.host ?? "localhost"}:${sql.port ?? 3306}/${sql.database ?? ""}`
        tables = await introspectMysql(connStr)
    } else {
        throw new Error(`Unsupported dialect: ${(sql as { dialect: string }).dialect}`)
    }

    if (tables.length === 0) {
        console.warn("Warning: No tables found in the database.")
    }

    // The package name to use in generated import() expressions.
    // Users can override via config if they're working in a monorepo.
    const firelinkPackage = cfg.output?.firelinkPackage ?? "firelink"

    // Build file content: interfaces first, then model classes, then the models map
    const parts: string[] = [
        "// AUTO-GENERATED by firelink --schema. Do not edit manually.",
        "",
        ...tables.map(generateInterface),
        "",
        ...tables.map(t => generateModelClass(t, firelinkPackage)),
        "",
        generateModelsType(tables),
        ""
    ]

    const content = parts.join("\n")
    const outputPath = resolve(cwd, cfg.output?.typesFile ?? "firelink.types.ts")

    writeFileSync(outputPath, content, "utf-8")
    console.log(`Generated ${tables.length} table type(s) + model class(es) → ${outputPath}`)
}
