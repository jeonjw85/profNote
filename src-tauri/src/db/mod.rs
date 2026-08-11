use tauri_plugin_sql::{Builder, Migration, MigrationKind};

pub const DATABASE_URL: &str = "sqlite:profnote.db";

const SCHEMA_V1: &str = "CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    transcript TEXT NOT NULL DEFAULT '',
    summary_md TEXT NOT NULL DEFAULT '',
    audio_path TEXT,
    status TEXT NOT NULL DEFAULT 'recording',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);";

const SCHEMA_V2: &str = "ALTER TABLE notes ADD COLUMN segments_json TEXT NOT NULL DEFAULT '';
ALTER TABLE notes ADD COLUMN professor_speaker TEXT;";

pub fn register<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.plugin(
        Builder::new()
            .add_migrations(
                DATABASE_URL,
                vec![
                    Migration {
                        version: 1,
                        description: "create notes and settings tables",
                        sql: SCHEMA_V1,
                        kind: MigrationKind::Up,
                    },
                    Migration {
                        version: 2,
                        description: "store speaker segments and professor selection",
                        sql: SCHEMA_V2,
                        kind: MigrationKind::Up,
                    },
                ],
            )
            .build(),
    )
}
