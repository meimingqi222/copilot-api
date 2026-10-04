import { Database } from "bun:sqlite"
import { homedir } from "node:os"
import { join } from "node:path"

const dbPath = join(homedir(), ".local", "share", "copilot-api", "stats.db")
const db = new Database(dbPath)

const rows = db
  .query(
    `SELECT datetime(timestamp/1000, 'unixepoch') as ts,
            model, prompt_tokens, completion_tokens,
            cache_read_tokens, cache_write_tokens, total_tokens
     FROM usage_stats
     WHERE model LIKE '%swe-1-6%'
     ORDER BY timestamp DESC
     LIMIT 25`,
  )
  .all()

console.log("Recent swe-1-6 usage:")
for (const row of rows) {
  console.log(row)
}

const summary = db
  .query(
    `SELECT COUNT(*) as n,
            SUM(cache_read_tokens) as total_cache,
            MAX(cache_read_tokens) as max_cache,
            AVG(prompt_tokens) as avg_prompt
     FROM usage_stats
     WHERE model LIKE '%swe-1-6%'`,
  )
  .get()

console.log("\nSummary:", summary)

const topHits = db
  .query(
    `SELECT datetime(timestamp/1000, 'unixepoch') as ts,
            model, prompt_tokens, cache_read_tokens,
            ROUND(100.0 * cache_read_tokens / prompt_tokens, 2) as hit_pct
     FROM usage_stats
     WHERE model LIKE '%swe-1-6%' AND cache_read_tokens > 1000
     ORDER BY cache_read_tokens DESC
     LIMIT 10`,
  )
  .all()

console.log("\nTop cache hits (>1000 tokens):")
for (const row of topHits) console.log(row)

const lsVsCloud = db
  .query(
    `SELECT
       CASE WHEN timestamp < 1751035348000 THEN 'ls_era' ELSE 'cloud_era' END as era,
       COUNT(*) as n,
       AVG(cache_read_tokens) as avg_cache,
       MAX(cache_read_tokens) as max_cache,
       AVG(prompt_tokens) as avg_prompt
     FROM usage_stats
     WHERE model = 'swe-1-6'
     GROUP BY era`,
  )
  .all()

console.log("\nLS vs cloud era (approx split at 16:42 UTC):")
for (const row of lsVsCloud) console.log(row)
