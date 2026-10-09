// Lint rules: ESLint's and typescript-eslint's recommended sets, the TypeScript ones with
// type information (from tsconfig.json). Formatting is Prettier's job, not ESLint's.
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores(["test/fixtures/", "examples/", ".yarn/", "dist/"]),
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true },
    },
    rules: {
      // const { Status, ...rest } = order: leaving a property out is what Status is for
      "@typescript-eslint/no-unused-vars": [
        "error",
        { ignoreRestSiblings: true },
      ],
      // String(value) and `${value}` turn OData values into text on purpose: keys, dates and
      // literals are primitives in their internal form, and request input is checked against
      // its Edm type before it gets here
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
    },
  },
  // The metadata parser reads the raw XML, which is untyped (see Xml in metadata.ts): the
  // checks for values of type any don't apply there. The model it builds is typed.
  {
    files: ["lib/metadata.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
  // The tests and this file are JavaScript, which tsc doesn't check: no type-aware rules
  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
