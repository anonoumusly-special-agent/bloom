use std::os::windows::process::CommandExt;
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter};
use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_NO_MORE_FILES};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
    TH32CS_SNAPPROCESS,
};

static ACTIVE_GAME: Mutex<Option<String>> = Mutex::new(None);

pub fn setup_gaming_mode(app: AppHandle) {
    std::thread::spawn(move || {
        let mut active_game: Option<String> = None;
        loop {
            let enabled = crate::utils::get_setting_str(&app, "bloom-gaming-enabled").as_deref()
                == Some("true");
            let configured: Vec<String> = crate::utils::get_setting_str(&app, "bloom-gaming-processes")
                .and_then(|value| serde_json::from_str(&value).ok())
                .unwrap_or_default();

            if !enabled {
                if active_game.is_some() {
                    run_task("BloomGameModeOff");
                    active_game = None;
                    publish_state(&app, None);
                }
            } else if !configured.is_empty() || active_game.is_some() {
                match running_processes() {
                    Ok(processes) => {
                        let still_running = active_game.as_ref().is_some_and(|game| {
                            contains_exe(&configured, game) && contains_exe(&processes, game)
                        });
                        if active_game.is_some() && !still_running {
                            run_task("BloomGameModeOff");
                            active_game = None;
                            publish_state(&app, None);
                        } else if active_game.is_none() {
                            if let Some(game) = configured
                                .iter()
                                .find(|exe| contains_exe(&processes, exe))
                            {
                                active_game = Some(game.clone());
                                run_task("BloomGameModeOn");
                                publish_state(&app, active_game.clone());
                            }
                        }
                    }
                    Err(error) => eprintln!("Failed to scan game processes: {error}"),
                }
            }

            std::thread::sleep(Duration::from_secs(2));
        }
    });
}

fn running_processes() -> windows::core::Result<Vec<String>> {
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)?;
        let result = (|| {
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            let mut processes = Vec::new();
            if let Err(error) = Process32FirstW(snapshot, &mut entry) {
                return if GetLastError() == ERROR_NO_MORE_FILES {
                    Ok(processes)
                } else {
                    Err(error)
                };
            }
            loop {
                let end = entry
                    .szExeFile
                    .iter()
                    .position(|&ch| ch == 0)
                    .unwrap_or(entry.szExeFile.len());
                processes.push(String::from_utf16_lossy(&entry.szExeFile[..end]));
                if let Err(error) = Process32NextW(snapshot, &mut entry) {
                    return if GetLastError() == ERROR_NO_MORE_FILES {
                        Ok(processes)
                    } else {
                        Err(error)
                    };
                }
            }
        })();
        let _ = CloseHandle(snapshot);
        result
    }
}

fn contains_exe(processes: &[String], game: &str) -> bool {
    let game = game.to_lowercase();
    processes.iter().any(|exe| exe.to_lowercase() == game)
}

fn run_task(name: &str) {
    match Command::new("schtasks")
        .args(["/Run", "/TN", name])
        .creation_flags(0x08000000)
        .status()
    {
        Ok(status) if status.success() => {}
        Ok(status) => eprintln!("Failed to run scheduled task {name}: {status}"),
        Err(error) => eprintln!("Failed to start scheduled task {name}: {error}"),
    }
}

fn publish_state(app: &AppHandle, game: Option<String>) {
    *ACTIVE_GAME
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = game.clone();
    let _ = app.emit(
        "gaming-mode",
        serde_json::json!({ "active": game.is_some(), "game": game }),
    );
}

#[tauri::command]
pub fn get_gaming_mode_state() -> serde_json::Value {
    let game = ACTIVE_GAME
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    serde_json::json!({ "active": game.is_some(), "game": game })
}

#[cfg(test)]
mod tests {
    use super::contains_exe;

    #[test]
    fn matches_exe_name_without_case() {
        let running = vec!["VALORANT-Win64-Shipping.exe".to_string()];
        assert!(contains_exe(&running, "valorant-win64-shipping.EXE"));
        assert!(!contains_exe(&running, "other.exe"));
        assert!(contains_exe(&["ÜberGame.exe".to_string()], "übergame.EXE"));
    }
}
