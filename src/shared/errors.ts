/**
 * Base error class for all firelink errors.
 */
export class FirelinkError extends Error {
    public readonly code: string

    constructor(message: string, code: string, cause?: unknown) {
        super(message)
        this.name = "FirelinkError"
        this.code = code
        if (cause !== undefined) {
            this.cause = cause
        }
        // Maintain proper prototype chain in transpiled ES5
        Object.setPrototypeOf(this, new.target.prototype)
    }
}

/**
 * Thrown when a SQL write (INSERT/UPDATE/DELETE) fails.
 */
export class SqlWriteError extends FirelinkError {
    constructor(message: string, cause?: unknown) {
        super(message, "SQL_WRITE_ERROR", cause)
        this.name = "SqlWriteError"
        Object.setPrototypeOf(this, new.target.prototype)
    }
}

/**
 * Thrown when a Firestore write fails.
 */
export class FirestoreWriteError extends FirelinkError {
    public readonly attempt: number
    public readonly statusCode?: number

    constructor(message: string, attempt: number, statusCode?: number, cause?: unknown) {
        super(message, "FIRESTORE_WRITE_ERROR", cause)
        this.name = "FirestoreWriteError"
        this.attempt = attempt
        this.statusCode = statusCode
        Object.setPrototypeOf(this, new.target.prototype)
    }
}

/**
 * Thrown when Firestore write fails after all retry attempts are exhausted.
 * At this point the SQL transaction has been rolled back.
 */
export class FirestoreRetryExhaustedError extends FirestoreWriteError {
    public readonly totalAttempts: number
    // Override the code from base class — we declare it non-readonly here via shadowing
    public override readonly code: string = "FIRESTORE_RETRY_EXHAUSTED"

    constructor(message: string, totalAttempts: number, statusCode?: number, cause?: unknown) {
        super(message, totalAttempts, statusCode, cause)
        this.name = "FirestoreRetryExhaustedError"
        this.totalAttempts = totalAttempts
        Object.setPrototypeOf(this, new.target.prototype)
    }
}

/**
 * Thrown for authentication/authorization failures (bad API key, missing token, etc.).
 */
export class AuthError extends FirelinkError {
    public readonly statusCode: number

    constructor(message: string, statusCode = 401, cause?: unknown) {
        super(message, "AUTH_ERROR", cause)
        this.name = "AuthError"
        this.statusCode = statusCode
        Object.setPrototypeOf(this, new.target.prototype)
    }
}

/**
 * Thrown for invalid request payloads (malformed body, missing required fields, etc.).
 * Maps to HTTP 400 in the server routes.
 */
export class BadRequestError extends FirelinkError {
    constructor(message: string, cause?: unknown) {
        super(message, "BAD_REQUEST", cause)
        this.name = "BadRequestError"
        Object.setPrototypeOf(this, new.target.prototype)
    }
}

/**
 * Thrown when schema introspection fails or a type cannot be mapped.
 */
export class SchemaError extends FirelinkError {
    constructor(message: string, cause?: unknown) {
        super(message, "SCHEMA_ERROR", cause)
        this.name = "SchemaError"
        Object.setPrototypeOf(this, new.target.prototype)
    }
}
