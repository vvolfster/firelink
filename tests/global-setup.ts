/**
 * Vitest global setup: starts the Firebase Firestore emulator before all tests
 * and tears it down after. Requires Java 11+ and firebase-tools to be installed.
 *
 * If the emulator fails to start (e.g. Java not available), emulator-dependent
 * tests are skipped via the FIRESTORE_EMULATOR_AVAILABLE env var.
 */
import { spawn, type ChildProcess } from "node:child_process"
import { createConnection } from "node:net"

const EMULATOR_HOST = "127.0.0.1"
const EMULATOR_PORT = 8080
const PROJECT_ID = "demo-firelink-test"
const STARTUP_TIMEOUT_MS = 30_000

let emulatorProcess: ChildProcess | null = null

/** Poll until the emulator port is open, or timeout. */
function waitForPort(host: string, port: number, timeoutMs: number): Promise<boolean> {
    return new Promise(resolve => {
        const deadline = Date.now() + timeoutMs
        function attempt() {
            if (Date.now() > deadline) {
                resolve(false)
                return
            }
            const sock = createConnection({ host, port })
            sock.once("connect", () => {
                sock.destroy()
                resolve(true)
            })
            sock.once("error", () => {
                setTimeout(attempt, 300)
            })
        }
        attempt()
    })
}

/** Try to locate a Java binary and inject it into PATH for the emulator process. */
function resolveJavaPath(): string | undefined {
    const candidates = [
        process.env["JAVA_HOME"],
        // Common Windows paths after winget/MSI installs
        "C:\\Program Files\\Microsoft\\jdk-21.0.10.7-hotspot\\bin",
        "C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.10.7-hotspot\\bin",
        "C:\\Program Files\\Java\\jdk-21\\bin"
    ]
    for (const candidate of candidates) {
        if (candidate) return candidate
    }
    return undefined
}

export async function setup(): Promise<void> {
    // Use demo- prefix so the emulator never contacts Google servers.
    process.env["FIRESTORE_EMULATOR_HOST"] = `${EMULATOR_HOST}:${EMULATOR_PORT}`
    process.env["GCLOUD_PROJECT"] = PROJECT_ID
    process.env["FIRELINK_TEST_PROJECT"] = PROJECT_ID

    // Check if the emulator is already running (e.g. started externally).
    const alreadyUp = await waitForPort(EMULATOR_HOST, EMULATOR_PORT, 1_000)
    if (alreadyUp) {
        process.env["FIRESTORE_EMULATOR_AVAILABLE"] = "true"
        console.info("[firelink tests] Firestore emulator already running — reusing it.")
        return
    }

    console.info("[firelink tests] Starting Firestore emulator…")

    // On Windows, .cmd files must be spawned with shell:true
    const isWindows = process.platform === "win32"
    const javaDir = resolveJavaPath()
    const childEnv = {
        ...process.env,
        ...(javaDir ? { PATH: `${javaDir}${isWindows ? ";" : ":"}${process.env["PATH"] ?? ""}` } : {})
    }

    emulatorProcess = spawn("firebase", ["emulators:start", "--only", "firestore", "--project", PROJECT_ID], {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        shell: isWindows,
        env: childEnv
    })

    emulatorProcess.stdout?.on("data", () => {
        // Uncomment to debug emulator output:
        // process.stdout.write(`[emulator] ${(chunk as Buffer).toString()}`);
    })

    emulatorProcess.stderr?.on("data", () => {
        // process.stderr.write(`[emulator] ${(chunk as Buffer).toString()}`);
    })

    const ready = await waitForPort(EMULATOR_HOST, EMULATOR_PORT, STARTUP_TIMEOUT_MS)

    if (!ready) {
        emulatorProcess.kill()
        emulatorProcess = null
        process.env["FIRESTORE_EMULATOR_AVAILABLE"] = "false"
        console.warn(
            "[firelink tests] Firestore emulator did not start in time. " +
                "Emulator-dependent tests will be skipped. " +
                "Make sure Java 11+ is installed and firebase-tools is available."
        )
        return
    }

    process.env["FIRESTORE_EMULATOR_AVAILABLE"] = "true"
    console.info("[firelink tests] Firestore emulator ready.")
}

export async function teardown(): Promise<void> {
    if (emulatorProcess) {
        emulatorProcess.kill("SIGTERM")
        await new Promise<void>(resolve => {
            emulatorProcess!.once("exit", () => resolve())
            setTimeout(resolve, 3_000)
        })
        emulatorProcess = null
        console.info("[firelink tests] Firestore emulator stopped.")
    }
}
