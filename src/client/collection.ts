import type { FirelinkCollection, FirelinkClientConfig } from "../shared/types.js"
import { FirelinkError } from "../shared/errors.js"

/** Shape of the server's success response */
interface FirelinkResponse {
    success: boolean
    id: string
    data?: Record<string, unknown>
    error?: string
    code?: string
}

/**
 * Creates an HTTP-based FirelinkCollection that proxies writes to the firelink server.
 */
export function createHttpCollection<T extends Record<string, unknown>>(collectionName: string, config: FirelinkClientConfig): FirelinkCollection<T> {
    const base = config.serverAddr.replace(/\/$/, "")

    async function buildHeaders(): Promise<Record<string, string>> {
        const headers: Record<string, string> = {
            "Content-Type": "application/json"
        }
        if (config.apiKey) {
            headers["X-Firelink-Key"] = config.apiKey
        }
        if (config.getToken) {
            const token = await config.getToken()
            if (token) {
                headers["Authorization"] = `Bearer ${token}`
            }
        }
        return headers
    }

    async function handleResponse(res: Response): Promise<FirelinkResponse> {
        let body: FirelinkResponse
        try {
            body = (await res.json()) as FirelinkResponse
        } catch {
            const text = await res.text().catch(() => "")
            throw new FirelinkError(`Server returned non-JSON response (${res.status}): ${text}`, "PARSE_ERROR")
        }

        if (!body.success) {
            throw new FirelinkError(body.error ?? `Server error (${res.status})`, body.code ?? "SERVER_ERROR")
        }

        return body
    }

    return {
        async add(doc: Omit<T, "id">): Promise<{ id: string; data: T }> {
            const headers = await buildHeaders()
            const res = await fetch(`${base}/firelink/${collectionName}`, {
                method: "POST",
                headers,
                body: JSON.stringify(doc)
            })
            const body = await handleResponse(res)
            return { id: body.id, data: body.data as T }
        },

        async set(id: string, doc: T): Promise<{ id: string; data: T }> {
            const headers = await buildHeaders()
            const res = await fetch(`${base}/firelink/${collectionName}/${encodeURIComponent(id)}`, {
                method: "PUT",
                headers,
                body: JSON.stringify(doc)
            })
            const body = await handleResponse(res)
            return { id: body.id, data: body.data as T }
        },

        async update(id: string, doc: Partial<Omit<T, "id">>): Promise<{ id: string; data: T }> {
            const headers = await buildHeaders()
            const res = await fetch(`${base}/firelink/${collectionName}/${encodeURIComponent(id)}`, {
                method: "PATCH",
                headers,
                body: JSON.stringify(doc)
            })
            const body = await handleResponse(res)
            return { id: body.id, data: body.data as T }
        },

        async delete(id: string): Promise<{ id: string }> {
            const headers = await buildHeaders()
            const res = await fetch(`${base}/firelink/${collectionName}/${encodeURIComponent(id)}`, {
                method: "DELETE",
                headers
            })
            const body = await handleResponse(res)
            return { id: body.id }
        }
    }
}
