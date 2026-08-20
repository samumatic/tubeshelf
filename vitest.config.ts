import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": import.meta.dirname,
    },
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**"],
    // Date math in the codebase (relative-time parsing, retention windows)
    // uses local-time Date methods; pin the test run to UTC so expectations
    // don't depend on the machine's timezone.
    env: { TZ: "UTC" },
  },
});
