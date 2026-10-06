import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    // Integration tests share one database; parallel files would contend for the advisory lock
    fileParallelism: false,
  },
});
