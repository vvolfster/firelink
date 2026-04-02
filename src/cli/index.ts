#!/usr/bin/env node
import { Command } from "commander"
import { generateTypes } from "./generate.js"
import { syncAllCommand } from "./sync.js"

const program = new Command()

program.name("firelink").description("firelink — relational integrity layer for Firebase Firestore").version("0.1.0")

program
    .command("schema")
    .description("Generate TypeScript types from your SQL schema")
    .option("--config <path>", "Path to firelink.config.json (default: ./firelink.config.json)")
    .action(async (options: { config?: string }) => {
        try {
            await generateTypes(options.config)
            process.exit(0)
        } catch (err) {
            console.error("firelink schema failed:", err instanceof Error ? err.message : String(err))
            process.exit(1)
        }
    })

program
    .command("sync")
    .description("Sync all SQL tables to Firestore using BulkWriter (full collection sync)")
    .option("--config <path>", "Path to firelink.config.json (default: ./firelink.config.json)")
    .action(async (options: { config?: string }) => {
        try {
            await syncAllCommand(options.config)
            process.exit(0)
        } catch (err) {
            console.error("firelink sync failed:", err instanceof Error ? err.message : String(err))
            process.exit(1)
        }
    })

// Legacy flat flags (--schema kept for backwards compat)
program
    .option("--schema", "Generate TypeScript types from your SQL schema (alias for: firelink schema)")
    .option("--config <path>", "Path to firelink.config.json (default: ./firelink.config.json)")
    .action(async (options: { schema?: boolean; config?: string }) => {
        if (options.schema) {
            try {
                await generateTypes(options.config)
                process.exit(0)
            } catch (err) {
                console.error("firelink --schema failed:", err instanceof Error ? err.message : String(err))
                process.exit(1)
            }
            return
        }

        program.help()
    })

program.parse(process.argv)
