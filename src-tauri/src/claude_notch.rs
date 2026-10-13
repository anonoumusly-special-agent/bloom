use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

use crate::utils::get_setting_str;

const DEFAULT_SPOOL_PATH: &str = r"S:\tools\claude-notch\spool";

#[derive(serde::Deserialize, serde::Serialize)]
struct ClaudeEvent {
    id: String,
    #[serde(rename = "type")]
    r#type: String,
    ts: f64,
    title: String,
    sub: String,
    project: String,
    expires: Option<f64>,
}

fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn spool_path(app: &AppHandle) -> PathBuf {
    PathBuf::from(
        get_setting_str(app, "bloom-claude-notch-path")
            .filter(|path| !path.is_empty())
            .unwrap_or_else(|| DEFAULT_SPOOL_PATH.to_string()),
    )
}

fn parse_event(content: &str, now: f64) -> Option<ClaudeEvent> {
    let event: ClaudeEvent = serde_json::from_str(content).ok()?;
    if !valid_id(&event.id)
        || !matches!(event.r#type.as_str(), "done" | "ask")
        || !event.ts.is_finite()
        || now - event.ts > 60.0
    {
        return None;
    }
    Some(event)
}

pub fn start(app: AppHandle) {
    thread::spawn(move || {
        let mut seen = HashSet::new();
        let mut asks = HashMap::<String, String>::new();
        let mut previous_path = PathBuf::new();
        loop {
            let enabled = get_setting_str(&app, "bloom-claude-notch-enabled").as_deref()
                == Some("true");
            let path = spool_path(&app);
            if !enabled || path != previous_path {
                for id in asks.values() {
                    let _ = app.emit("notch-claude-gone", serde_json::json!({ "id": id }));
                }
                seen.clear();
                asks.clear();
                previous_path = path.clone();
            }

            if enabled {
                if let Ok(entries) = fs::read_dir(&path) {
                    let mut present = HashSet::new();
                    let mut complete = true;
                    let now = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs_f64();
                    for entry in entries {
                        let Ok(entry) = entry else {
                            complete = false;
                            continue;
                        };
                        let file_path = entry.path();
                        if file_path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                            continue;
                        }
                        let file_name = entry.file_name();
                        let Some(name) = file_name.to_str().map(str::to_owned) else {
                            continue;
                        };
                        present.insert(name.clone());
                        if seen.contains(&name) {
                            continue;
                        }
                        let Some(event) = fs::read_to_string(&file_path)
                            .ok()
                            .and_then(|content| parse_event(&content, now))
                        else {
                            continue;
                        };
                        if event.r#type == "ask" {
                            asks.insert(name.clone(), event.id.clone());
                        }
                        seen.insert(name);
                        let _ = app.emit("notch-claude", event);
                    }
                    if complete {
                        for (name, id) in &asks {
                            if !present.contains(name) {
                                let _ = app.emit("notch-claude-gone", serde_json::json!({ "id": id }));
                            }
                        }
                        asks.retain(|name, _| present.contains(name));
                        seen.retain(|name| present.contains(name));
                    }
                }
            }
            thread::sleep(Duration::from_millis(500));
        }
    });
}

#[tauri::command]
pub fn notch_claude_decision(app: AppHandle, id: String, allow: bool) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("Invalid Claude event id".to_string());
    }
    fs::write(
        spool_path(&app).join(format!("{id}.decision")),
        if allow { "allow" } else { "deny" },
    )
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_or_old_events() {
        let id = "0123456789abcdef0123456789abcdef";
        let event = format!(
            r#"{{"id":"{id}","type":"ask","ts":100.0,"title":"Question","sub":"Details","project":"Test"}}"#
        );
        assert!(parse_event(&event, 150.0).is_some());
        assert!(parse_event(&event, 161.0).is_none());
        assert!(!valid_id("../../outside"));
        assert!(!valid_id("ABCDEF0123456789abcdef0123456789"));
    }
}
