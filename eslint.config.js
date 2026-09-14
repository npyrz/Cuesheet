import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/release/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    /*
     * Node globals for the plain-JS scripts: `scripts/*.mjs` and the desktop
     * bundler. They are ESM modules with no TypeScript config behind them, so
     * eslint assumes a browser and reports `Buffer`, `process` and `console`
     * as undefined — correctly, given what it knows. Declared by hand rather
     * than pulling in the `globals` package for six names.
     */
    files: ["**/*.mjs", "eslint.config.js", "*.config.js"],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        URL: "readonly",
        console: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
