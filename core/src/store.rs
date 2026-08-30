//! Local SQLite persistence — library metadata (shared/school vs. private
//! tracks), score history, and local user profiles. Lives in paw-core (not
//! the Tauri shell) so a future iOS build can reuse the same schema/logic —
//! SQLite is available on every target platform we care about (Windows,
//! macOS, iOS).
//!
//! Audio files themselves stay on the filesystem (see the `filename` field,
//! resolved by the caller against its uploads directory); only metadata
//! lives here. `owner: None` on a track means shared/school content;
//! `owner: Some(profile_id)` is a private track belonging to that local
//! profile. Multiple profiles can exist per install (e.g. several people
//! sharing one family/classroom computer, each with their own private
//! library and score history) — exactly one is "active" at a time
//! (`settings.active_profile_id`), and that's whose view the exercise
//! engine and library commands operate against.

use crate::error::{CoreError, Result};
use rand::Rng;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;

const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS profiles (
        id         TEXT PRIMARY KEY,
        username   TEXT NOT NULL,
        created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
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
        profile_id TEXT,
        module     TEXT NOT NULL,
        score      INTEGER NOT NULL,
        rounds     INTEGER NOT NULL,
        level      INTEGER NOT NULL,
        streak     INTEGER NOT NULL,
        created_at TEXT NOT NULL
    );
";

pub struct Store {
    conn: Mutex<Connection>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub username: String,
    pub created_at: String,
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

fn row_to_score(row: &rusqlite::Row) -> rusqlite::Result<ScoreEntry> {
    Ok(ScoreEntry {
        id: row.get(0)?,
        module: row.get(1)?,
        score: row.get(2)?,
        rounds: row.get(3)?,
        level: row.get(4)?,
        streak: row.get(5)?,
        created_at: row.get(6)?,
    })
}

const TRACK_COLUMNS: &str = "id, filename, original_name, size, duration, mime_type, active, owner, added_at";
const SCORE_COLUMNS: &str = "id, module, score, rounds, level, streak, created_at";

/// A legacy single-profile install (before multi-profile support) had a
/// `profile` table (singular) with exactly one row. Move that into the new
/// `profiles` table with a fresh id, point every track that used to be
/// owned by the old bare username at that id instead, and make it active.
/// A no-op on a fresh database or one that's already been migrated.
fn migrate_legacy_single_profile(conn: &Connection) -> rusqlite::Result<()> {
    let has_old_table: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='profile'",
        [],
        |r| r.get(0),
    )?;
    if has_old_table == 0 {
        return Ok(());
    }

    let already_migrated: i64 = conn.query_row("SELECT COUNT(*) FROM profiles", [], |r| r.get(0))?;
    if already_migrated == 0 {
        let old: Option<(String, String)> = conn
            .query_row("SELECT username, created_at FROM profile WHERE id = 1", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()?;
        if let Some((username, created_at)) = old {
            let new_id = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO profiles (id, username, created_at) VALUES (?1, ?2, ?3)",
                params![new_id, username, created_at],
            )?;
            conn.execute("UPDATE tracks SET owner = ?1 WHERE owner = ?2", params![new_id, username])?;
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('active_profile_id', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![new_id],
            )?;
        }
    }
    conn.execute("DROP TABLE profile", [])?;
    Ok(())
}

impl Store {
    pub fn open(db_path: &Path) -> Result<Self> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(db_path).map_err(map_err)?;
        conn.execute_batch(SCHEMA).map_err(map_err)?;
        migrate_legacy_single_profile(&conn).map_err(map_err)?;
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

    // ─── Profiles ────────────────────────────────────────────────────────────

    pub fn list_profiles(&self) -> Result<Vec<Profile>> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = conn
            .prepare("SELECT id, username, created_at FROM profiles ORDER BY created_at ASC")
            .map_err(map_err)?;
        let rows = stmt
            .query_map([], |row| {
                Ok(Profile { id: row.get(0)?, username: row.get(1)?, created_at: row.get(2)? })
            })
            .map_err(map_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(map_err)
    }

    /// Create a new profile and make it the active one (a freshly created
    /// profile is the one the caller almost always wants to switch into).
    pub fn create_profile(&self, username: &str, created_at: &str) -> Result<Profile> {
        let profile = Profile { id: uuid::Uuid::new_v4().to_string(), username: username.to_string(), created_at: created_at.to_string() };
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute(
            "INSERT INTO profiles (id, username, created_at) VALUES (?1, ?2, ?3)",
            params![profile.id, profile.username, profile.created_at],
        ).map_err(map_err)?;
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('active_profile_id', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![profile.id],
        ).map_err(map_err)?;
        Ok(profile)
    }

    /// Deletes a profile along with its private tracks and scores (shared
    /// tracks, i.e. owner IS NULL, are untouched). Returns the filenames of
    /// any deleted tracks so the caller can remove the underlying files too
    /// — the Store only owns the DB, not the filesystem. If the deleted
    /// profile was active, no profile is active afterwards (caller should
    /// prompt to switch/create one).
    pub fn delete_profile(&self, id: &str) -> Result<Vec<String>> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let filenames: Vec<String> = {
            let mut stmt = conn.prepare("SELECT filename FROM tracks WHERE owner = ?1").map_err(map_err)?;
            let rows = stmt.query_map(params![id], |r| r.get::<_, String>(0)).map_err(map_err)?;
            rows.collect::<rusqlite::Result<Vec<_>>>().map_err(map_err)?
        };
        conn.execute("DELETE FROM tracks WHERE owner = ?1", params![id]).map_err(map_err)?;
        conn.execute("DELETE FROM scores WHERE profile_id = ?1", params![id]).map_err(map_err)?;
        conn.execute("DELETE FROM profiles WHERE id = ?1", params![id]).map_err(map_err)?;
        conn.execute(
            "DELETE FROM settings WHERE key = 'active_profile_id' AND value = ?1",
            params![id],
        ).map_err(map_err)?;
        Ok(filenames)
    }

    pub fn get_active_profile(&self) -> Result<Option<Profile>> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let active_id: Option<String> = conn
            .query_row("SELECT value FROM settings WHERE key = 'active_profile_id'", [], |r| r.get(0))
            .optional()
            .map_err(map_err)?;
        let Some(active_id) = active_id else { return Ok(None) };
        conn.query_row(
            "SELECT id, username, created_at FROM profiles WHERE id = ?1",
            params![active_id],
            |row| Ok(Profile { id: row.get(0)?, username: row.get(1)?, created_at: row.get(2)? }),
        ).optional().map_err(map_err)
    }

    /// Errors if `id` doesn't name an existing profile — switching to a
    /// stale/unknown id would silently leave the app with no valid active
    /// profile.
    pub fn set_active_profile(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let exists: i64 = conn
            .query_row("SELECT COUNT(*) FROM profiles WHERE id = ?1", params![id], |r| r.get(0))
            .map_err(map_err)?;
        if exists == 0 {
            return Err(CoreError::InvalidParam(format!("no such profile: {id}")));
        }
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('active_profile_id', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![id],
        ).map_err(map_err)?;
        Ok(())
    }

    // ─── Tracks / library ───────────────────────────────────────────────────

    pub fn add_track(&self, track: &Track) -> Result<()> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
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

    /// Tracks visible to `owner` (a profile id): shared (owner IS NULL)
    /// plus their own private ones.
    pub fn list_accessible(&self, owner: &str) -> Result<Vec<Track>> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
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
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row(
            &format!("SELECT {TRACK_COLUMNS} FROM tracks WHERE id = ?1"),
            params![id],
            row_to_track,
        )
        .optional()
        .map_err(map_err)
    }

    pub fn set_active(&self, id: &str, active: bool) -> Result<()> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute("UPDATE tracks SET active = ?2 WHERE id = ?1", params![id, active as i64])
            .map_err(map_err)?;
        Ok(())
    }

    pub fn delete_track(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute("DELETE FROM tracks WHERE id = ?1", params![id]).map_err(map_err)?;
        Ok(())
    }

    /// One random *active*, accessible-to-`owner` track — used by the
    /// exercise engine instead of a filesystem scan. Filters in SQL rather
    /// than fetching every accessible track (incl. inactive ones) and
    /// discarding most of them in Rust.
    pub fn pick_random_active_track(&self, owner: &str, rng: &mut impl Rng) -> Result<Option<Track>> {
        let active: Vec<Track> = {
            let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
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
    // All scoped to a profile_id: each local profile has its own history,
    // the way its own private library tracks are its own.

    pub fn add_score(&self, profile_id: &str, entry: &ScoreEntry) -> Result<()> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute(
            "INSERT INTO scores (id, profile_id, module, score, rounds, level, streak, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![entry.id, profile_id, entry.module, entry.score, entry.rounds, entry.level, entry.streak, entry.created_at],
        ).map_err(map_err)?;
        Ok(())
    }

    pub fn top_scores(&self, profile_id: &str, module: &str, limit: i64) -> Result<Vec<ScoreEntry>> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {SCORE_COLUMNS} FROM scores WHERE profile_id = ?1 AND module = ?2 ORDER BY score DESC LIMIT ?3"
            ))
            .map_err(map_err)?;
        let rows = stmt.query_map(params![profile_id, module, limit], row_to_score).map_err(map_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(map_err)
    }

    pub fn progress_overview(&self, profile_id: &str) -> Result<Vec<ModuleProgress>> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = conn
            .prepare("SELECT module, COUNT(*), MAX(score), SUM(score) FROM scores WHERE profile_id = ?1 GROUP BY module ORDER BY module")
            .map_err(map_err)?;
        let rows = stmt
            .query_map(params![profile_id], |row| {
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

    /// All-time aggregate across every module for one profile — feeds the
    /// dashboard's stat cards (legacy /api/progress/summary).
    pub fn summary(&self, profile_id: &str) -> Result<ProgressSummary> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.query_row(
            "SELECT COALESCE(SUM(score),0), COALESCE(SUM(rounds),0),
                     COALESCE(CAST(AVG(score) AS INTEGER),0), COALESCE(MAX(streak),0), COUNT(*)
              FROM scores WHERE profile_id = ?1",
            params![profile_id],
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

    /// Most recent scores for one profile across all modules, newest first
    /// — feeds the dashboard's session-history table and learning-curve
    /// chart (legacy /api/progress/sessions).
    pub fn recent_scores(&self, profile_id: &str, limit: i64) -> Result<Vec<ScoreEntry>> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {SCORE_COLUMNS} FROM scores WHERE profile_id = ?1 ORDER BY created_at DESC LIMIT ?2"
            ))
            .map_err(map_err)?;
        let rows = stmt.query_map(params![profile_id, limit], row_to_score).map_err(map_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(map_err)
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
            store.add_score("alice", &ScoreEntry {
                id: format!("s{i}"), module: "eq".into(), score, rounds: 5, level: 2, streak: 3,
                created_at: "2026-01-01T00:00:00Z".into(),
            }).unwrap();
        }
        let top = store.top_scores("alice", "eq", 2).unwrap();
        assert_eq!(top.len(), 2);
        assert_eq!(top[0].score, 900);
        assert_eq!(top[1].score, 600);
    }

    #[test]
    fn progress_overview_aggregates_per_module() {
        let store = Store::open_in_memory().unwrap();
        store.add_score("alice", &ScoreEntry { id: "1".into(), module: "eq".into(), score: 500, rounds: 3, level: 1, streak: 1, created_at: "t".into() }).unwrap();
        store.add_score("alice", &ScoreEntry { id: "2".into(), module: "eq".into(), score: 800, rounds: 4, level: 2, streak: 2, created_at: "t".into() }).unwrap();
        store.add_score("alice", &ScoreEntry { id: "3".into(), module: "reverb".into(), score: 200, rounds: 1, level: 1, streak: 0, created_at: "t".into() }).unwrap();

        let overview = store.progress_overview("alice").unwrap();
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

        let prof = Profile { id: "p1".into(), username: "Jan".into(), created_at: "t".into() };
        let profv = serde_json::to_value(&prof).unwrap();
        for key in ["id", "username", "createdAt"] {
            assert!(profv.get(key).is_some(), "Profile missing camelCase key {key:?}");
        }
    }

    #[test]
    fn summary_and_recent_scores_aggregate_across_all_modules() {
        let store = Store::open_in_memory().unwrap();
        store.add_score("alice", &ScoreEntry { id: "1".into(), module: "eq".into(), score: 500, rounds: 3, level: 1, streak: 2, created_at: "2026-01-01T00:00:00Z".into() }).unwrap();
        store.add_score("alice", &ScoreEntry { id: "2".into(), module: "reverb".into(), score: 300, rounds: 2, level: 1, streak: 5, created_at: "2026-01-02T00:00:00Z".into() }).unwrap();

        let summary = store.summary("alice").unwrap();
        assert_eq!(summary.total_points, 800);
        assert_eq!(summary.total_rounds, 5);
        assert_eq!(summary.session_count, 2);
        assert_eq!(summary.best_streak, 5);
        assert_eq!(summary.avg_score, 400);

        let recent = store.recent_scores("alice", 10).unwrap();
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0].id, "2", "newest first");
    }

    #[test]
    fn scores_are_scoped_per_profile() {
        let store = Store::open_in_memory().unwrap();
        store.add_score("alice", &ScoreEntry { id: "1".into(), module: "eq".into(), score: 500, rounds: 1, level: 1, streak: 0, created_at: "t".into() }).unwrap();
        store.add_score("bob", &ScoreEntry { id: "2".into(), module: "eq".into(), score: 900, rounds: 1, level: 1, streak: 0, created_at: "t".into() }).unwrap();

        assert_eq!(store.summary("alice").unwrap().total_points, 500);
        assert_eq!(store.summary("bob").unwrap().total_points, 900);
        assert_eq!(store.recent_scores("alice", 10).unwrap().len(), 1);
    }

    #[test]
    fn no_active_profile_until_one_is_created_or_switched_to() {
        let store = Store::open_in_memory().unwrap();
        assert!(store.get_active_profile().unwrap().is_none());

        let p = store.create_profile("Jan", "2026-01-01T00:00:00Z").unwrap();
        let active = store.get_active_profile().unwrap().unwrap();
        assert_eq!(active.id, p.id);
        assert_eq!(active.username, "Jan");
    }

    #[test]
    fn creating_a_second_profile_switches_active_to_it() {
        let store = Store::open_in_memory().unwrap();
        let p1 = store.create_profile("Jan", "t").unwrap();
        let p2 = store.create_profile("Alex", "t").unwrap();
        assert_eq!(store.get_active_profile().unwrap().unwrap().id, p2.id);

        store.set_active_profile(&p1.id).unwrap();
        assert_eq!(store.get_active_profile().unwrap().unwrap().id, p1.id);

        assert_eq!(store.list_profiles().unwrap().len(), 2);
    }

    #[test]
    fn switching_to_unknown_profile_id_errors() {
        let store = Store::open_in_memory().unwrap();
        store.create_profile("Jan", "t").unwrap();
        assert!(store.set_active_profile("does-not-exist").is_err());
    }

    #[test]
    fn deleting_a_profile_removes_its_private_tracks_and_scores_but_not_shared() {
        let store = Store::open_in_memory().unwrap();
        let p = store.create_profile("Jan", "t").unwrap();
        store.add_track(&sample_track("private1", Some(&p.id), true)).unwrap();
        store.add_track(&sample_track("shared1", None, true)).unwrap();
        store.add_score(&p.id, &ScoreEntry { id: "s1".into(), module: "eq".into(), score: 1, rounds: 1, level: 1, streak: 0, created_at: "t".into() }).unwrap();

        let removed_filenames = store.delete_profile(&p.id).unwrap();
        assert_eq!(removed_filenames, vec!["private1.mp3".to_string()]);
        assert!(store.get_track("private1").unwrap().is_none());
        assert!(store.get_track("shared1").unwrap().is_some(), "shared tracks must survive a profile deletion");
        assert!(store.get_active_profile().unwrap().is_none(), "deleting the active profile leaves none active");
        assert_eq!(store.list_profiles().unwrap().len(), 0);
    }

    #[test]
    fn legacy_single_profile_table_migrates_into_profiles_and_reowns_tracks() {
        // Simulate a pre-multi-profile database on disk, then reopen it via
        // Store::open() (open_in_memory() bypasses the file-based migration
        // path, so this test uses a real temp file).
        let dir = std::env::temp_dir().join(format!("paw-migration-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("data.db");

        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute_batch(
                "CREATE TABLE tracks (id TEXT PRIMARY KEY, filename TEXT NOT NULL, original_name TEXT NOT NULL,
                    size INTEGER NOT NULL, duration REAL, mime_type TEXT, active INTEGER NOT NULL DEFAULT 1,
                    owner TEXT, added_at TEXT NOT NULL);
                 CREATE TABLE profile (id INTEGER PRIMARY KEY CHECK (id = 1), username TEXT NOT NULL, created_at TEXT NOT NULL);
                 INSERT INTO profile (id, username, created_at) VALUES (1, 'Jan', '2026-01-01T00:00:00Z');
                 INSERT INTO tracks (id, filename, original_name, size, active, owner, added_at)
                    VALUES ('t1', 't1.mp3', 't1.mp3', 100, 1, 'Jan', '2026-01-01T00:00:00Z');",
            ).unwrap();
        }

        let store = Store::open(&db_path).unwrap();
        let active = store.get_active_profile().unwrap().expect("migrated profile should be active");
        assert_eq!(active.username, "Jan");

        let track = store.get_track("t1").unwrap().unwrap();
        assert_eq!(track.owner.as_deref(), Some(active.id.as_str()), "track ownership should follow the migrated profile id, not the old bare username");

        // Reopening again must not re-migrate or duplicate the profile.
        drop(store);
        let store2 = Store::open(&db_path).unwrap();
        assert_eq!(store2.list_profiles().unwrap().len(), 1);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
