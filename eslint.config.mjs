import tseslint from "typescript-eslint"
import eslintConfigPrettier from "eslint-config-prettier"

export default tseslint.config({ ignores: ["dist/**", "node_modules/**", "coverage/**"] }, tseslint.configs.recommended, eslintConfigPrettier, {
    languageOptions: {
        parserOptions: {
            project: true,
            tsconfigRootDir: import.meta.dirname
        }
    },
    rules: {
        // The Drizzle db instance is typed as `any` by design (multi-dialect).
        // These rules would produce noise throughout writer.ts and migration-sync.ts.
        "@typescript-eslint/no-explicit-any": "warn",
        "@typescript-eslint/no-unsafe-member-access": "off",
        "@typescript-eslint/no-unsafe-call": "off",
        "@typescript-eslint/no-unsafe-assignment": "off",
        "@typescript-eslint/no-unsafe-argument": "off",
        "@typescript-eslint/no-unsafe-return": "off"
    }
})
