import { defineConfig } from "vitest/config";

// Standalone Vitest config — intentionally does NOT load the reactRouter()
// Vite plugin (it expects a full RR build context that isn't present under
// the test runner). Unit tests here target pure server/model logic, so a
// plain node environment is all we need.
export default defineConfig({
  test: {
    environment: "node",
    include: ["app/**/*.test.{ts,tsx,js,jsx}"],
    globals: false,
  },
});
