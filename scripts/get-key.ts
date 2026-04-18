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
const row = db
  .prepare("SELECT value FROM ItemTable WHERE key = ?")
  .get("windsurfAuthStatus") as { value: string } | null
if (row) {
  const parsed = JSON.parse(row.value) as { apiKey?: string }
  console.log(parsed.apiKey)
}
