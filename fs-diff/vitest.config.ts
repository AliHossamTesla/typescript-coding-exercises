import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // The bin entry only wires run() to the real process. It is exercised by
      // subprocess tests, which v8 coverage can't see. Nothing else is excluded.
      exclude: ["src/cli.ts"],
      reporter: ["text", "html"],
      reportsDirectory: "coverage",
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});
