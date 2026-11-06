import type { Env } from "./env";

const BATCH = 200;
const MAX_REQUEST_DELETIONS_PER_RUN = 5000;

/**
 * Hourly retention sweep.
 *
 * Reads, counts, replays and state writes already exclude expired rows, so a
 * delayed cron never exposes stale data — it only delays physical deletion.
 */
export async function sweep(env: Env, now = Date.now()): Promise<void> {
  let deleted = 0;
  for (;;) {
    const result = await env.DB.prepare(
      `DELETE FROM requests WHERE seq IN (
         SELECT seq FROM requests WHERE expires_at <= ? ORDER BY seq ASC LIMIT ?
       )`,
    )
      .bind(now, BATCH)
      .run();
    const changes = result.meta.changes ?? 0;
    deleted += changes;
    if (changes < BATCH || deleted >= MAX_REQUEST_DELETIONS_PER_RUN) break;
  }

  await env.DB.prepare("DELETE FROM challenges WHERE expires_at <= ?").bind(now).run();
  await env.DB.prepare("DELETE FROM rate WHERE reset_at <= ?").bind(now).run();
  await env.DB.prepare(
    "DELETE FROM admission_context WHERE request_id NOT IN (SELECT request_id FROM requests)",
  ).run();
}
