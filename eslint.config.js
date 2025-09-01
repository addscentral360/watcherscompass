// eslint.config.js
import globals from "globals";
import js from "@eslint/js";

export default [
  js.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,   // ✅ gives __dirname, process, etc
      },
    },
  },
];
