use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

use crate::claude_toasts;
use crate::utils::get_setting_str;

const DEFAULT_SPOOL_PATH: &str = r"S:\tools\claude-notch\spool";

#[derive(Clone, serde::Deserialize, serde::Serialize)]
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
        let mut toast_seen = HashSet::new();
        let mut toast_baselined = false;
        let mut last_toast_poll = None::<Instant>;
        let mut last_heartbeat = None::<Instant>;
        let mut connected = None;
        let mut previous_path = PathBuf::new();
        loop {
            let enabled = get_setting_str(&app, "bloom-claude-notch-enabled").as_deref()
                == Some("true");
            let path = spool_path(&app);
            if path != previous_path {
                last_heartbeat = None;
            }
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
                    if connected != Some(true) {
                        let _ = app.emit("notch-claude-status", serde_json::json!({ "connected": true }));
                        connected = Some(true);
                        toast_seen.clear();
                        toast_baselined = false;
                        last_toast_poll = None;
                    }
                    let mut present = HashSet::new();
                    let mut complete = true;
                    let now = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs_f64();
                    if last_heartbeat.map_or(true, |time| time.elapsed() >= Duration::from_secs(2)) {
                        let _ = fs::write(path.join("bloom.alive"), (now as u64).to_string());
                        last_heartbeat = Some(Instant::now());
                    }
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
                } else {
                    for id in asks.values() {
                        let _ = app.emit("notch-claude-gone", serde_json::json!({ "id": id }));
                    }
                    asks.clear();
                    seen.clear();
                    if connected != Some(false) {
                        let _ = app.emit("notch-claude-status", serde_json::json!({ "connected": false }));
                        connected = Some(false);
                    }
                    if last_toast_poll.map_or(true, |time| time.elapsed() >= Duration::from_secs(2)) {
                        let toasts = claude_toasts::poll_new(&mut toast_seen);
                        last_toast_poll = Some(Instant::now());
                        if toast_baselined {
                            for (id, title, sub) in toasts {
                                let ts = SystemTime::now()
                                    .duration_since(UNIX_EPOCH)
                                    .unwrap_or_default()
                                    .as_secs_f64();
                                let _ = app.emit("notch-claude", ClaudeEvent {
                                    id: format!("{id:032x}"),
                                    r#type: "done".to_string(),
                                    ts,
                                    title,
                                    sub,
                                    project: "Claude (offline)".to_string(),
                                    expires: None,
                                });
                            }
                        }
                        toast_baselined = true;
                    }
                }
            } else {
                connected = None;
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
