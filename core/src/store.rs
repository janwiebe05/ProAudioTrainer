//! Local SQLite persistence — library metadata (shared/school vs. private
//! tracks), score history, and the local user profile. Lives in paw-core
//! (not the Tauri shell) so a future iOS build can reuse the same
//! schema/logic — SQLite is available on every target platform we care
//! about (Windows, macOS, iOS).
//!
//! Audio files themselves stay on the filesystem (see the `filename` field,
//! resolved by the caller against its uploads directory); only metadata
//! lives here. `owner: None` means school/shared content, `owner:
//! Some(name)` is a private track belonging to that local profile —
//! carried over 1:1 from the legacy JSON `ownerId: null | username` model.

use crate::error::{CoreError, Result};
use rand::Rng;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;

const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS tracks (
        id            TEXT PRIMARY KEY,
        filename      TEXT NOT NULL,
        original_name TEXT NOT NULL,
        size          INTEGER NOT NULL,
        duration      REAL,
        mime_type     TEXT,
        active        INTEGER NOT NULL DEFAULT 1,
        owner         TEXT,
        added_at      TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scores (
        id         TEXT PRIMARY KEY,
        module     TEXT NOT NULL,
        score      INTEGER NOT NULL,
        rounds     INTEGER NOT NULL,
        level      INTEGER NOT NULL,
        streak     INTEGER NOT NULL,
        created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS profile (
        id         INTEGER PRIMARY KEY CHECK (id = 1),
        username   TEXT NOT NULL,
        created_at TEXT NOT NULL
    );
";

pub struct Store {
    conn: Mutex<Connection>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub filename: String,
    pub original_name: String,
    pub size: i64,
    pub duration: Option<f64>,
    pub mime_type: Option<String>,
    pub active: bool,
    pub owner: Option<String>,
    pub added_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoreEntry {
    pub id: String,
    pub module: String,
    pub score: i64,
    pub rounds: i64,
    pub level: i64,
    pub streak: i64,
    pub created_at: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleProgress {
    pub module: String,
    pub sessions: i64,
    pub best_score: i64,
    pub total_score: i64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressSummary {
    pub total_points: i64,
    pub total_rounds: i64,
    pub avg_score: i64,
    pub best_streak: i64,
    pub session_count: i64,
}

fn map_err(e: rusqlite::Error) -> CoreError {
    CoreError::Decode(format!("sqlite: {e}"))
}

fn row_to_track(row: &rusqlite::Row) -> rusqlite::Result<Track> {
    Ok(Track {
        id: row.get(0)?,
        filename: row.get(1)?,
        original_name: row.get(2)?,
        size: row.get(3)?,
        duration: row.get(4)?,
        mime_type: row.get(5)?,
        active: row.get::<_, i64>(6)? != 0,
        owner: row.get(7)?,
        added_at: row.get(8)?,
    })
}

const TRACK_COLUMNS: &str = "id, filename, original_name, size, duration, mime_type, active, owner, added_at";

impl Store {
    pub fn open(db_path: &Path) -> Result<Self> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(db_path).map_err(map_err)?;
        conn.execute_batch(SCHEMA).map_err(map_err)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    /// In-memory store — used by tests (also handy for downstream crates'
    /// own tests, which is why this isn't cfg(test)-gated: that attribute
    /// wouldn't apply across the crate boundary anyway).
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory().map_err(map_err)?;
        conn.execute_batch(SCHEMA).map_err(map_err)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    // ─── Tracks / library ───────────────────────────────────────────────────

    pub fn add_track(&self, track: &Track) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO tracks (id, filename, original_name, size, duration, mime_type, active, owner, added_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                track.id, track.filename, track.original_name, track.size, track.duration,
                track.mime_type, track.active as i64, track.owner, track.added_at,
            ],
        ).map_err(map_err)?;
        Ok(())
    }

    /// Tracks visible to `owner`: shared (owner IS NULL) plus their own private ones.
    pub fn list_accessible(&self, owner: &str) -> Result<Vec<Track>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {TRACK_COLUMNS} FROM tracks WHERE owner IS NULL OR owner = ?1 ORDER BY added_at DESC"
            ))
            .map_err(map_err)?;
        let rows = stmt
            .query_map(params![owner], row_to_track)
            .map_err(map_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(map_err)
    }

    pub fn get_track(&self, id: &str) -> Result<Option<Track>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            &format!("SELECT {TRACK_COLUMNS} FROM tracks WHERE id = ?1"),
            params![id],
            row_to_track,
        )
        .optional()
        .map_err(map_err)
    }

    pub fn set_active(&self, id: &str, active: bool) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE tracks SET active = ?2 WHERE id = ?1", params![id, active as i64])
            .map_err(map_err)?;
        Ok(())
    }

    pub fn delete_track(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM tracks WHERE id = ?1", params![id]).map_err(map_err)?;
        Ok(())
    }

    /// One random *active*, accessible-to-`owner` track — used by the
    /// exercise engine instead of a filesystem scan. Filters in SQL rather
    /// than fetching every accessible track (incl. inactive ones) and
    /// discarding most of them in Rust.
    pub fn pick_random_active_track(&self, owner: &str, rng: &mut impl Rng) -> Result<Option<Track>> {
        let active: Vec<Track> = {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {TRACK_COLUMNS} FROM tracks WHERE (owner IS NULL OR owner = ?1) AND active = 1"
                ))
                .map_err(map_err)?;
            let rows = stmt.query_map(params![owner], row_to_track).map_err(map_err)?;
            rows.collect::<rusqlite::Result<Vec<_>>>().map_err(map_err)?
        };
        if active.is_empty() {
            return Ok(None);
        }
        Ok(Some(active[rng.gen_range(0..active.len())].clone()))
    }

    // ─── Scores ──────────────────────────────────────────────────────────────

    pub fn add_score(&self, entry: &ScoreEntry) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO scores (id, module, score, rounds, level, streak, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![entry.id, entry.module, entry.score, entry.rounds, entry.level, entry.streak, entry.created_at],
        ).map_err(map_err)?;
        Ok(())
    }

    pub fn top_scores(&self, module: &str, limit: i64) -> Result<Vec<ScoreEntry>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, module, score, rounds, level, streak, created_at FROM scores WHERE module = ?1 ORDER BY score DESC LIMIT ?2")
            .map_err(map_err)?;
        let rows = stmt
            .query_map(params![module, limit], |row| {
                Ok(ScoreEntry {
                    id: row.get(0)?, module: row.get(1)?, score: row.get(2)?,
                    rounds: row.get(3)?, level: row.get(4)?, streak: row.get(5)?, created_at: row.get(6)?,
                })
            })
            .map_err(map_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(map_err)
    }

    pub fn progress_overview(&self) -> Result<Vec<ModuleProgress>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT module, COUNT(*), MAX(score), SUM(score) FROM scores GROUP BY module ORDER BY module")
            .map_err(map_err)?;
        let rows = stmt
            .query_map([], |row| {
                Ok(ModuleProgress {
                    module: row.get(0)?,
                    sessions: row.get(1)?,
                    best_score: row.get::<_, Option<i64>>(2)?.unwrap_or(0),
                    total_score: row.get::<_, Option<i64>>(3)?.unwrap_or(0),
                })
            })
            .map_err(map_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(map_err)
    }

    /// All-time aggregate across every module — feeds the dashboard's stat
    /// cards (legacy /api/progress/summary).
    pub fn summary(&self) -> Result<ProgressSummary> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT COALESCE(SUM(score),0), COALESCE(SUM(rounds),0),
                     COALESCE(CAST(AVG(score) AS INTEGER),0), COALESCE(MAX(streak),0), COUNT(*)
              FROM scores",
            [],
            |row| {
                Ok(ProgressSummary {
                    total_points: row.get(0)?,
                    total_rounds: row.get(1)?,
                    avg_score: row.get(2)?,
                    best_streak: row.get(3)?,
                    session_count: row.get(4)?,
                })
            },
        ).map_err(map_err)
    }

    /// Most recent scores across all modules, newest first — feeds the
    /// dashboard's session-history table and learning-curve chart (legacy
    /// /api/progress/sessions).
    pub fn recent_scores(&self, limit: i64) -> Result<Vec<ScoreEntry>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, module, score, rounds, level, streak, created_at FROM scores ORDER BY created_at DESC LIMIT ?1")
            .map_err(map_err)?;
        let rows = stmt
            .query_map(params![limit], |row| {
                Ok(ScoreEntry {
                    id: row.get(0)?, module: row.get(1)?, score: row.get(2)?,
                    rounds: row.get(3)?, level: row.get(4)?, streak: row.get(5)?, created_at: row.get(6)?,
                })
            })
            .map_err(map_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(map_err)
    }

    // ─── Local profile ───────────────────────────────────────────────────────

    pub fn get_profile_username(&self) -> Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT username FROM profile WHERE id = 1", [], |row| row.get(0))
            .optional()
            .map_err(map_err)
    }

    pub fn set_profile_username(&self, username: &str, created_at: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO profile (id, username, created_at) VALUES (1, ?1, ?2)
             ON CONFLICT(id) DO UPDATE SET username = excluded.username",
            params![username, created_at],
        ).map_err(map_err)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;

    fn sample_track(id: &str, owner: Option<&str>, active: bool) -> Track {
        Track {
            id: id.to_string(),
            filename: format!("{id}.mp3"),
            original_name: format!("{id} original.mp3"),
            size: 12345,
            duration: Some(180.0),
            mime_type: Some("audio/mpeg".to_string()),
            active,
            owner: owner.map(|s| s.to_string()),
            added_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn add_and_list_respects_shared_vs_private_visibility() {
        let store = Store::open_in_memory().unwrap();
        store.add_track(&sample_track("shared1", None, true)).unwrap();
        store.add_track(&sample_track("alice1", Some("alice"), true)).unwrap();
        store.add_track(&sample_track("bob1", Some("bob"), true)).unwrap();

        let alice_view = store.list_accessible("alice").unwrap();
        let ids: Vec<_> = alice_view.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains(&"shared1"));
        assert!(ids.contains(&"alice1"));
        assert!(!ids.contains(&"bob1"));
    }

    #[test]
    fn set_active_and_random_pick_only_returns_active_tracks() {
        let store = Store::open_in_memory().unwrap();
        store.add_track(&sample_track("a", None, true)).unwrap();
        store.add_track(&sample_track("b", None, false)).unwrap();
        let mut rng = rand_chacha::ChaCha8Rng::seed_from_u64(1);

        for _ in 0..20 {
            let picked = store.pick_random_active_track("anyone", &mut rng).unwrap().unwrap();
            assert_eq!(picked.id, "a", "only the active track should ever be picked");
        }

        store.set_active("a", false).unwrap();
        assert!(store.pick_random_active_track("anyone", &mut rng).unwrap().is_none());
    }

    #[test]
    fn delete_track_removes_it() {
        let store = Store::open_in_memory().unwrap();
        store.add_track(&sample_track("x", None, true)).unwrap();
        assert!(store.get_track("x").unwrap().is_some());
        store.delete_track("x").unwrap();
        assert!(store.get_track("x").unwrap().is_none());
    }

    #[test]
    fn scores_round_trip_and_top_scores_orders_descending() {
        let store = Store::open_in_memory().unwrap();
        for (i, score) in [300, 900, 600].into_iter().enumerate() {
            store.add_score(&ScoreEntry {
                id: format!("s{i}"), module: "eq".into(), score, rounds: 5, level: 2, streak: 3,
                created_at: "2026-01-01T00:00:00Z".into(),
            }).unwrap();
        }
        let top = store.top_scores("eq", 2).unwrap();
        assert_eq!(top.len(), 2);
        assert_eq!(top[0].score, 900);
        assert_eq!(top[1].score, 600);
    }

    #[test]
    fn progress_overview_aggregates_per_module() {
        let store = Store::open_in_memory().unwrap();
        store.add_score(&ScoreEntry { id: "1".into(), module: "eq".into(), score: 500, rounds: 3, level: 1, streak: 1, created_at: "t".into() }).unwrap();
        store.add_score(&ScoreEntry { id: "2".into(), module: "eq".into(), score: 800, rounds: 4, level: 2, streak: 2, created_at: "t".into() }).unwrap();
        store.add_score(&ScoreEntry { id: "3".into(), module: "reverb".into(), score: 200, rounds: 1, level: 1, streak: 0, created_at: "t".into() }).unwrap();

        let overview = store.progress_overview().unwrap();
        let eq = overview.iter().find(|m| m.module == "eq").unwrap();
        assert_eq!(eq.sessions, 2);
        assert_eq!(eq.best_score, 800);
        assert_eq!(eq.total_score, 1300);
    }

    #[test]
    fn track_and_score_entry_serialize_as_camel_case() {
        let t = sample_track("id1", Some("alice"), true);
        let tv = serde_json::to_value(&t).unwrap();
        for key in ["id", "filename", "originalName", "size", "duration", "mimeType", "active", "owner", "addedAt"] {
            assert!(tv.get(key).is_some(), "Track missing camelCase key {key:?}");
        }

        let s = ScoreEntry { id: "s1".into(), module: "eq".into(), score: 1, rounds: 1, level: 1, streak: 0, created_at: "t".into() };
        let sv = serde_json::to_value(&s).unwrap();
        for key in ["id", "module", "score", "rounds", "level", "streak", "createdAt"] {
            assert!(sv.get(key).is_some(), "ScoreEntry missing camelCase key {key:?}");
        }

        let p = ModuleProgress { module: "eq".into(), sessions: 1, best_score: 1, total_score: 1 };
        let pv = serde_json::to_value(&p).unwrap();
        for key in ["module", "sessions", "bestScore", "totalScore"] {
            assert!(pv.get(key).is_some(), "ModuleProgress missing camelCase key {key:?}");
        }
    }

    #[test]
    fn summary_and_recent_scores_aggregate_across_all_modules() {
        let store = Store::open_in_memory().unwrap();
        store.add_score(&ScoreEntry { id: "1".into(), module: "eq".into(), score: 500, rounds: 3, level: 1, streak: 2, created_at: "2026-01-01T00:00:00Z".into() }).unwrap();
        store.add_score(&ScoreEntry { id: "2".into(), module: "reverb".into(), score: 300, rounds: 2, level: 1, streak: 5, created_at: "2026-01-02T00:00:00Z".into() }).unwrap();

        let summary = store.summary().unwrap();
        assert_eq!(summary.total_points, 800);
        assert_eq!(summary.total_rounds, 5);
        assert_eq!(summary.session_count, 2);
        assert_eq!(summary.best_streak, 5);
        assert_eq!(summary.avg_score, 400);

        let recent = store.recent_scores(10).unwrap();
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0].id, "2", "newest first");
    }

    #[test]
    fn profile_defaults_to_none_then_persists_after_set() {
        let store = Store::open_in_memory().unwrap();
        assert!(store.get_profile_username().unwrap().is_none());
        store.set_profile_username("Jan", "2026-01-01T00:00:00Z").unwrap();
        assert_eq!(store.get_profile_username().unwrap().as_deref(), Some("Jan"));
        // setting again should update, not conflict-error
        store.set_profile_username("Jan Wiebe", "2026-01-02T00:00:00Z").unwrap();
        assert_eq!(store.get_profile_username().unwrap().as_deref(), Some("Jan Wiebe"));
    }
}
