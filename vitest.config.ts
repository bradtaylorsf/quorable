import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["ts/tests/**/*.test.ts"],
    // Live API tests are gated behind RUN_LIVE_TESTS and never run by default.
    environment: "node",
    testTimeout: 20_000,
  },
});
