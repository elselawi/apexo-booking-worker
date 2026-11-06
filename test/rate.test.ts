import { beforeEach, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { consumeRate } from "../src/rate";
import { resetDatabase } from "./helpers";

beforeEach(resetDatabase);

it("rejects without incrementing a full bucket and resets it after expiry", async () => {
  const spec = { bucket: "bounded", ceiling: 2, reset: 2000 };
  expect(await consumeRate(env.DB, spec, 1000)).toBe(true);
  expect(await consumeRate(env.DB, spec, 1000)).toBe(true);
  expect(await consumeRate(env.DB, spec, 1000)).toBe(false);
  expect(await consumeRate(env.DB, spec, 1000)).toBe(false);
  const row = await env.DB.prepare("SELECT count FROM rate WHERE bucket = 'bounded'").first<{ count: number }>();
  expect(row?.count).toBe(2);
  expect(await consumeRate(env.DB, { ...spec, reset: 3000 }, 2000)).toBe(true);
});
