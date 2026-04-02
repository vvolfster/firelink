import { defineConfig } from "vitest/config"

export default defineConfig({
    test: {
        globals: true,
        environment: "node",
        include: ["tests/**/*.test.ts"],
        globalSetup: "./tests/global-setup.ts",
        testTimeout: 15000,
        hookTimeout: 30000,
        coverage: {
            provider: "v8",
            include: ["src/**/*.ts"],
            exclude: ["src/cli/**"]
        }
    }
})
