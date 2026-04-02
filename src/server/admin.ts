import type { FirelinkServerConfig } from "../shared/types.js"

/**
 * Returns (or creates) the shared Firebase Admin Firestore instance for this config.
 *
 * The Admin SDK app is keyed by `config.appName` (defaults to `'firelink'`).
 * If multiple firelink instances run in the same process with different configs,
 * give each a distinct `appName` to avoid collisions.
 */
export async function getAdminFirestore(config: FirelinkServerConfig): Promise<import("firebase-admin/firestore").Firestore> {
    const { initializeApp, getApps, cert, applicationDefault } = await import("firebase-admin/app")
    const { getFirestore } = await import("firebase-admin/firestore")

    const appName = config.appName ?? "firelink"
    const existing = getApps().find(a => a.name === appName)

    if (existing) {
        return getFirestore(existing)
    }

    const { firestore: fsConfig } = config
    let credential

    if (fsConfig.serviceAccount) {
        credential = cert(fsConfig.serviceAccount as Parameters<typeof cert>[0])
    } else if (fsConfig.serviceAccountPath) {
        const { createRequire } = await import("node:module")
        const require = createRequire(import.meta.url)
        const sa = require(fsConfig.serviceAccountPath) as Parameters<typeof cert>[0]
        credential = cert(sa)
    } else {
        credential = applicationDefault()
    }

    const app = initializeApp({ credential, projectId: fsConfig.projectId }, appName)
    return getFirestore(app)
}
