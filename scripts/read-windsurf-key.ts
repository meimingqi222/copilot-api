import { Database } from "bun:sqlite"
import { join } from "node:path"

const dbPath = join(
  process.env.APPDATA ?? "",
  "Windsurf - Next",
  "User",
  "globalStorage",
  "state.vscdb",
)

const db = new Database(dbPath, { readonly: true })

// Find all relevant keys
const rows = db.prepare("SELECT key FROM ItemTable").all() as Array<{
  key: string
}>
const relevantKeys = rows
  .map((r) => r.key)
  .filter((k) => /devin|token|api|session|auth|jwt|key/i.test(k))

console.log("=== Relevant keys ===")
for (const k of relevantKeys) {
  console.log(k)
}

console.log("\n=== Values ===")
for (const k of relevantKeys) {
  const row = db
    .prepare("SELECT value FROM ItemTable WHERE key = ?")
    .get(k) as { value: string } | null
  if (row) {
    const val =
      typeof row.value === "string" ?
        row.value.slice(0, 120)
      : String(row.value)
    console.log(`${k} = ${val}`)
  }
}
