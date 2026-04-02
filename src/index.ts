/**
 * firelink — root package export.
 * Import from subpaths for tree-shaking:
 *   import { createServer } from 'firelink/server'
 *   import { createClient } from 'firelink/client'
 *   import type { FirelinkModels } from 'firelink/types'
 */

// Shared types and errors
export type {
    FirelinkCollection,
    FirelinkInstance,
    FirelinkServerConfig,
    FirelinkClientConfig,
    SqlConfig,
    FirestoreServerConfig,
    TypeAdapter,
    TableInfo,
    ColumnInfo,
    FirelinkConfigFile
} from "./shared/types.js"

export { FirelinkError, SqlWriteError, FirestoreWriteError, FirestoreRetryExhaustedError, AuthError, SchemaError } from "./shared/errors.js"
