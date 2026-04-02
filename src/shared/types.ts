/**
 * The collection interface — same shape on server and client.
 */
export interface FirelinkCollection<T extends Record<string, unknown>> {
    add(doc: Omit<T, "id">): Promise<{ id: string; data: T }>
    set(id: string, doc: T): Promise<{ id: string; data: T }>
    update(id: string, doc: Partial<Omit<T, "id">>): Promise<{ id: string; data: T }>
    delete(id: string): Promise<{ id: string }>
}

/** SQL dialect configuration */
export interface SqlConfig {
    dialect: "postgresql" | "mysql" | "sqlite"
    connectionString?: string
    host?: string
    port?: number
    database?: string
    username?: string
    password?: string
    /** SQLite only */
    filename?: string
}

/** Firestore server-side configuration */
export interface FirestoreServerConfig {
    projectId: string
    serviceAccountPath?: string
    /** Inline service account JSON (alternative to serviceAccountPath) */
    serviceAccount?: object
}

/**
 * Server-side firelink configuration.
 * `tables` is the list of SQL table names firelink is allowed to write to.
 * Each name must match both the SQL table name and the Firestore collection name.
 */
export interface FirelinkServerConfig {
    sql: SqlConfig
    firestore: FirestoreServerConfig
    /** If set, all HTTP requests must include a matching X-Firelink-Key header */
    apiKey?: string
    /** Allow writes without a user token (admin mode). Defaults to true. */
    allowAdminWrites?: boolean
    /** SQL table names that firelink manages (must match Firestore collection names) */
    tables: string[]
    /**
     * Firebase Admin SDK app name used for this firelink instance.
     * Must be unique if running multiple firelink instances in the same process.
     * Defaults to 'firelink'.
     */
    appName?: string
}

/**
 * Client-side firelink configuration.
 */
export interface FirelinkClientConfig {
    /** Base URL of the firelink server, e.g. "http://localhost:3001" */
    serverAddr: string
    apiKey?: string
    /** Returns the current Firebase ID token, or null/undefined if not signed in */
    getToken?: () => Promise<string | null | undefined>
    /** Optional Firestore instance for reads (user manages reads themselves) */
    firestore?: FirebaseFirestore.Firestore
}

/** A single column description returned from schema introspection */
export interface ColumnInfo {
    name: string
    type: string
    nullable: boolean
}

/** A single table description returned from schema introspection */
export interface TableInfo {
    name: string
    columns: ColumnInfo[]
}

/** Shape of firelink.config.json on disk */
export interface FirelinkConfigFile {
    sql: SqlConfig
    firestore: {
        projectId: string
        serviceAccountPath?: string
    }
    tables?: string[]
    output?: {
        typesFile?: string
        /** Package name used in generated import() expressions. Defaults to "firelink". */
        firelinkPackage?: string
    }
    apiKey?: string
    /** Firebase Admin SDK app name. Defaults to 'firelink'. */
    appName?: string
}

/**
 * The minimal interface both FirelinkServer and FirelinkClient satisfy.
 * Generated model classes accept this so they work with either.
 */
export interface FirelinkInstance {
    collection<T extends Record<string, unknown>>(name: string): FirelinkCollection<T>
}

/** Type adapter interface — extensible by users */
export interface TypeAdapter {
    /** Returns true if this adapter can handle the given value */
    canHandle(value: unknown): boolean
    /** Converts the value to a Firestore-compatible representation */
    convert(value: unknown): unknown
}
