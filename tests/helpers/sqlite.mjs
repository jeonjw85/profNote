import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PYTHON_SQL = `
import json, sqlite3, sys
connection = sqlite3.connect(sys.argv[1])
connection.row_factory = sqlite3.Row
params = {str(index + 1): value for index, value in enumerate(json.loads(sys.argv[3]))}
cursor = connection.execute(sys.argv[2], params)
result = [dict(row) for row in cursor.fetchall()] if cursor.description else {"rowsAffected": cursor.rowcount}
connection.commit()
connection.close()
print(json.dumps(result))
`;

export function createDatabase(t) {
  const directory = mkdtempSync(join(tmpdir(), "profnote-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "test.db");
  const query = (sql, params = []) => JSON.parse(execFileSync("python3", [
    "-c", PYTHON_SQL, path, sql, JSON.stringify(params),
  ], { encoding: "utf8" }));
  query("CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL, transcript TEXT NOT NULL, summary_md TEXT NOT NULL, audio_path TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, segments_json TEXT NOT NULL, professor_speaker TEXT)");
  query("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  return { query, select: async (...args) => query(...args), execute: async (...args) => query(...args) };
}
