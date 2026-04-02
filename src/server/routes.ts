import type { Router, Request, Response } from "express"
import { Router as createRouter } from "express"
import { AuthError, BadRequestError, FirelinkError, FirestoreRetryExhaustedError, SqlWriteError } from "../shared/errors.js"
import { executeWrite } from "./writer.js"
import type { FirelinkServerConfig } from "../shared/types.js"
import type { AnyDrizzleDb } from "./db.js"

/**
 * Validate the X-Firelink-Key header against the configured API key.
 * Throws AuthError if invalid.
 */
function validateApiKey(req: Request, config: FirelinkServerConfig): void {
    if (!config.apiKey) return // no key configured — open
    const provided = req.headers["x-firelink-key"]
    if (provided !== config.apiKey) {
        throw new AuthError("Invalid or missing X-Firelink-Key header", 401)
    }
}

/**
 * Extract user token from Authorization: Bearer <token> header.
 * Returns undefined if no token is present.
 */
function extractUserToken(req: Request): string | undefined {
    const auth = req.headers["authorization"]
    if (!auth) return undefined
    const match = /^Bearer\s+(.+)$/i.exec(auth)
    return match?.[1]
}

/**
 * Send a standardized error response.
 */
function sendError(res: Response, err: unknown): void {
    if (err instanceof AuthError) {
        res.status(err.statusCode).json({
            success: false,
            error: err.message,
            code: err.code
        })
        return
    }
    if (err instanceof BadRequestError) {
        res.status(400).json({ success: false, error: err.message, code: err.code })
        return
    }
    if (err instanceof FirestoreRetryExhaustedError) {
        res.status(503).json({
            success: false,
            error: err.message,
            code: err.code
        })
        return
    }
    if (err instanceof SqlWriteError && /no row found/i.test(err.message)) {
        res.status(404).json({
            success: false,
            error: err.message,
            code: err.code
        })
        return
    }
    if (err instanceof FirelinkError) {
        res.status(500).json({
            success: false,
            error: err.message,
            code: err.code
        })
        return
    }
    res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : String(err),
        code: "INTERNAL_ERROR"
    })
}

/**
 * Build and return an Express Router with all firelink write routes.
 */
export function createFirelinkRouter(config: FirelinkServerConfig, db: AnyDrizzleDb): Router {
    const router = createRouter()

    // POST /firelink/:collection — add a new document
    router.post("/firelink/:collection", async (req: Request, res: Response) => {
        try {
            validateApiKey(req, config)
            const userToken = extractUserToken(req)

            if (!userToken && !(config.allowAdminWrites ?? true)) {
                throw new AuthError("A user token is required (allowAdminWrites is disabled)", 403)
            }

            const { collection } = req.params
            const data = req.body as Record<string, unknown>

            if (!data || typeof data !== "object" || Array.isArray(data)) {
                throw new BadRequestError("Request body must be a JSON object")
            }

            const result = await executeWrite("add", collection, null, data, db, config, userToken)
            res.status(201).json({ success: true, ...result })
        } catch (err) {
            sendError(res, err)
        }
    })

    // PUT /firelink/:collection/:id — set (upsert) a document
    router.put("/firelink/:collection/:id", async (req: Request, res: Response) => {
        try {
            validateApiKey(req, config)
            const userToken = extractUserToken(req)

            if (!userToken && !(config.allowAdminWrites ?? true)) {
                throw new AuthError("A user token is required (allowAdminWrites is disabled)", 403)
            }

            const { collection, id } = req.params
            const data = req.body as Record<string, unknown>

            if (!data || typeof data !== "object" || Array.isArray(data)) {
                throw new BadRequestError("Request body must be a JSON object")
            }

            const result = await executeWrite("set", collection, id, data, db, config, userToken)
            res.status(200).json({ success: true, ...result })
        } catch (err) {
            sendError(res, err)
        }
    })

    // PATCH /firelink/:collection/:id — partial update
    router.patch("/firelink/:collection/:id", async (req: Request, res: Response) => {
        try {
            validateApiKey(req, config)
            const userToken = extractUserToken(req)

            if (!userToken && !(config.allowAdminWrites ?? true)) {
                throw new AuthError("A user token is required (allowAdminWrites is disabled)", 403)
            }

            const { collection, id } = req.params
            const data = req.body as Record<string, unknown>

            if (!data || typeof data !== "object" || Array.isArray(data)) {
                throw new BadRequestError("Request body must be a JSON object")
            }

            const result = await executeWrite("update", collection, id, data, db, config, userToken)
            res.status(200).json({ success: true, ...result })
        } catch (err) {
            sendError(res, err)
        }
    })

    // DELETE /firelink/:collection/:id — delete a document
    router.delete("/firelink/:collection/:id", async (req: Request, res: Response) => {
        try {
            validateApiKey(req, config)
            const userToken = extractUserToken(req)

            if (!userToken && !(config.allowAdminWrites ?? true)) {
                throw new AuthError("A user token is required (allowAdminWrites is disabled)", 403)
            }

            const { collection, id } = req.params
            const result = await executeWrite("delete", collection, id, null, db, config, userToken)
            res.status(200).json({ success: true, ...result })
        } catch (err) {
            sendError(res, err)
        }
    })

    return router
}
