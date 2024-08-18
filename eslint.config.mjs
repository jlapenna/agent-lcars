import unusedImports from "eslint-plugin-unused-imports";
import eslint from "@eslint/js";
import jest from "eslint-plugin-jest";
import eslintPluginPrettierRecommended from "eslint-plugin-prettier/recommended";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // javascript rules?
  eslint.configs.recommended,

  // tselint: Start
  {
    ignores: ["**/*.config.ts", "**/*.config.js", "**/*.config.mjs", "**/node_modules", "**/dist"],
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
      "prettier/prettier": "warn",
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
      "unused-imports/no-unused-imports": "error",
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
    files: ["__test__/**", "test/**"],
    ...jest.configs["flat/recommended"],
    ...jest.configs["flat/style"],
    rules: {
      ...jest.configs["flat/recommended"].rules,
    },
    languageOptions: {
      globals: {
        ...jest.environments.globals,
      },
    },
  },
  // jest: End

  // Removes conflicting eslint+prettier rules.
  // Should remain at the end.
  eslintPluginPrettierRecommended,
  // Its really annoying when writing code that a formatting issue is an error.
  // Make these warnings.
  // However, we want prettier rules to be warnings; they'll get reformatted and
  // fixed, anyway, further, our lint-staged/husky rules treat warnings as
  // fatal.
  {
    rules: {
      "prettier/prettier": "warn",
    },
  }
);
