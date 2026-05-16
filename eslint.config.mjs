import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["node_modules/", "assets/", "server.py"],
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
        // WebGPU globals not yet in the globals package
        GPUDevice: "readonly",
        GPUBuffer: "readonly",
        GPUTexture: "readonly",
        GPUBindGroup: "readonly",
        GPURenderPipeline: "readonly",
        GPUComputePipeline: "readonly",
        GPUCommandEncoder: "readonly",
        GPURenderPassEncoder: "readonly",
        GPUComputePassEncoder: "readonly",
        GPUShaderModule: "readonly",
        GPUSampler: "readonly",
        GPUQuerySet: "readonly",
        navigator: "readonly",
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": "off",
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-prototype-builtins": "warn",
    },
  },
  {
    // Node.js scripts (CI, config files)
    files: [".github/scripts/**/*.mjs", "*.config.mjs"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
];
