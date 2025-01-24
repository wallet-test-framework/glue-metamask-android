import { FlatCompat } from "@eslint/eslintrc";
import js from "@eslint/js";
import typescriptEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const compat = new FlatCompat({
    baseDirectory: __dirname,
    recommendedConfig: js.configs.recommended,
    allConfig: js.configs.all,
});

export default [
    {
        ignores: ["**/node_modules", "dist"],
    },
    ...compat.extends(
        "eslint:recommended",
        "plugin:@typescript-eslint/recommended",
    ),
    ...compat
        .extends(
            "plugin:@typescript-eslint/recommended-requiring-type-checking",
        )
        .map((config) => ({ ...config, files: ["**/*.ts"] })),
    ...compat.extends("plugin:@typescript-eslint/strict", "prettier"),
    {
        files: ["**/*.ts"],
        plugins: {
            "@typescript-eslint": typescriptEslint,
        },

        languageOptions: {
            parser: tsParser,
            ecmaVersion: 5,
            sourceType: "module",

            parserOptions: {
                project: true,
            },
        },

        rules: {
            "@typescript-eslint/no-unused-vars": [
                "error",
                {
                    argsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                    caughtErrorsIgnorePattern: "^_",
                },
            ],
        },
    },
    {
        files: ["**/Build.js"],

        rules: {
            "@typescript-eslint/no-unsafe-assignment": ["off"],
            "@typescript-eslint/no-unsafe-call": ["off"],
            "@typescript-eslint/no-unsafe-member-access": ["off"],
        },
    },
];
