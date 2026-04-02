import type { Config } from "drizzle-kit"

export default {
    schema: "./src/schema.ts",
    out: "./drizzle",
    driver: "pg",
    dbCredentials: {
        connectionString: process.env["DATABASE_URL"] ?? "postgresql://user:pass@localhost:5432/mydb"
    }
} satisfies Config
