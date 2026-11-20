use std::{collections::BTreeMap, fs, io::Write, path::PathBuf};

use anyhow::{Context, Result, anyhow};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use url::Url;

/// A signed-in admin session for one HelloBox URL.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Saved {
    pub token: String,
    pub email: String,
    pub expires_at: String,
}

impl Saved {
    pub fn expired(&self) -> bool {
        DateTime::parse_from_rfc3339(&self.expires_at)
            .map(|at| at.with_timezone(&Utc) <= Utc::now())
            .unwrap_or(true)
    }
}

#[derive(Default, Serialize, Deserialize)]
struct Store {
    sessions: BTreeMap<String, Saved>,
}

fn path() -> Result<PathBuf> {
    let dir = dirs::config_dir().ok_or_else(|| anyhow!("No config directory on this system"))?;
    Ok(dir.join("hellobox-admin").join("sessions.json"))
}

fn read() -> Store {
    path()
        .ok()
        .filter(|p| p.exists())
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

// Only this user can read the file, since it holds admin tokens.
fn write(store: &Store) -> Result<()> {
    let path = path()?;
    let dir = path.parent().ok_or_else(|| anyhow!("Bad config path"))?;
    fs::create_dir_all(dir)?;
    let temp = path.with_extension("json.tmp");
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        options.mode(0o600);
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    let mut file = options
        .open(&temp)
        .with_context(|| format!("Couldn't write {}", temp.display()))?;
    file.write_all(serde_json::to_string_pretty(store)?.as_bytes())?;
    file.sync_all()?;
    fs::rename(&temp, &path)?;
    Ok(())
}

pub fn load(base: &Url) -> Option<Saved> {
    read()
        .sessions
        .get(base.as_str())
        .filter(|saved| !saved.expired())
        .cloned()
}

pub fn save(base: &Url, saved: Saved) -> Result<()> {
    let mut store = read();
    store.sessions.retain(|_, s| !s.expired());
    store.sessions.insert(base.to_string(), saved);
    write(&store)
}

pub fn forget(base: &Url) -> Result<()> {
    let mut store = read();
    if store.sessions.remove(base.as_str()).is_some() {
        write(&store)?;
    }
    Ok(())
}
