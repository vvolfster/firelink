import { createHttpCollection } from "./collection.js"
import type { FirelinkCollection, FirelinkClientConfig } from "../shared/types.js"

export interface FirelinkClient {
    /**
     * Returns an HTTP-based collection that proxies writes to the firelink server.
     * Optionally pass a Firestore instance to the config for reads (managed by you).
     *
     * @example
     * ```ts
     * const client = createClient({ serverAddr: 'http://localhost:3001', apiKey: '...' });
     * const users = client.collection<User>('users');
     * const result = await users.add({ email: 'alice@example.com' });
     * ```
     */
    collection<T extends Record<string, unknown>>(name: string): FirelinkCollection<T>
}

/**
 * Create a firelink client that proxies all writes through the firelink server.
 *
 * @example
 * ```ts
 * import { createClient } from 'firelink/client';
 * import { getAuth } from 'firebase/auth';
 *
 * const client = createClient({
 *   serverAddr: 'http://localhost:3001',
 *   apiKey: 'my-api-key',
 *   getToken: () => getAuth().currentUser?.getIdToken(),
 * });
 *
 * const users = client.collection<User>('users');
 * await users.add({ email: 'alice@example.com', name: 'Alice' });
 * ```
 */
export function createClient(config: FirelinkClientConfig): FirelinkClient {
    return {
        collection<T extends Record<string, unknown>>(name: string): FirelinkCollection<T> {
            return createHttpCollection<T>(name, config)
        }
    }
}

// Re-export config type
export type { FirelinkClientConfig } from "../shared/types.js"
export { FirelinkError } from "../shared/errors.js"
