import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      // Tests always run against local miniflare state, never the deployed D1.
      remoteBindings: false,
      miniflare: {
        compatibilityDate: "2026-10-01",
        d1Databases: ["DB"],
        bindings: {
          ALLOW_TEST_SECRET: "1",
          PUBLIC_ORIGIN: "https://book.test",
          APP_ORIGINS: "https://app.test",
          TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
          TURNSTILE_HOSTNAME: "book.test",
          TURNSTILE_SECRET: "1x0000000000000000000000000000000AA",
          BOOKING_HMAC_KEY: "test-hmac-key-test-hmac-key-test",
          PROOF_EGRESS: "public-only",
          TEST_MIGRATIONS: JSON.stringify(migrations),
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
