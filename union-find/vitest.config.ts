import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "html", "json-summary"],
      reportsDirectory: "coverage",
      // The run fails if any metric drops below 100%.
      thresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
    },
  },
});
