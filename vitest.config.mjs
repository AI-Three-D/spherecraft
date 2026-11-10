import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.{test,spec}.{js,mjs}"],
    exclude: [...configDefaults.exclude, "tools/perf/structured-terrain-results/**"],
    passWithNoTests: true,
  },
});
