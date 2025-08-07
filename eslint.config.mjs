import unusedImports from "eslint-plugin-unused-imports";
import eslint from "@eslint/js";
import jest from "eslint-plugin-jest";
import eslintConfigPrettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // javascript rules?
  eslint.configs.recommended,

  // tselint: Start
  {
    ignores: [
      "**/*.config.ts",
      "**/*.config.js",
      "**/*.config.mjs",
      "**/node_modules",
      "**/dist",
      "**/coverage",
    ],
  },
  {
    files: ["**/jest.config.ts"],
    rules: {
      "no-ignored-file": "off",
    },
  },
  ...tseslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "no-empty": "warn",
      "@typescript-eslint/consistent-indexed-object-style": "off",
      "@typescript-eslint/consistent-type-definitions": "off",
      "@typescript-eslint/no-empty-function": "warn",
      "@typescript-eslint/no-empty-interface": "warn",
      "@typescript-eslint/no-misused-promises": "warn",
      "@typescript-eslint/no-unnecessary-type-assertion": "warn",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/require-await": "warn",
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        {
          allowNumber: true,
        },
      ],
      "no-restricted-imports": "off",
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["firebase-admin/*"],
              importNames: ["getFirestore"],
              message:
                'Avoid direct Firebase Admin SDK functions. Use @"lib/firebase/client"',
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: 'TSTypeReference[typeName.left.name="FirebaseFirestore"]',
          message:
            "Usage of types from the `FirebaseFirestore` namespace is forbidden; import from firebase-admin/firestore instead.",
        },
      ],
      // Work around express 5 async handler (expected) behavior)
      "@typescript-eslint/no-misused-promises": [
        "error",
        {
          checksVoidReturn: false,
        },
      ],
    },
  },
  // tselint: End

  // unusedImports: Start
  // Overriding teslint no-unsed-vars rule.
  // Per: https://www.npmjs.com/package/eslint-plugin-unused-imports
  {
    plugins: {
      "unused-imports": unusedImports,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "unused-imports/no-unused-imports": "warn",
      "unused-imports/no-unused-vars": [
        "warn",
        {
          // Options based on https://typescript-eslint.io/rules/no-unused-vars/
          args: "all",
          argsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  // unusedImports: End

  // jest: Start
  {
    files: ["__test__/**", "test/**", "**/*.test.ts"],
    ...jest.configs["flat/all"],
    rules: {
      "@typescript-eslint/unbound-method": "off",
      // TODO: add flag/all back in, to add style chekcs back.
      ...jest.configs["flat/recommended"].rules,
    },
  },
  // jest: End

  // Removes conflicting eslint+prettier rules -- Should remain at the end.
  eslintConfigPrettier
);
