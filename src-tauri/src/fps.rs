use std::io::{BufRead, BufReader};
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::AppHandle;

use crate::fps_stats::{header_column, parse_frametime, RollingFrames};

const CREATE_NO_WINDOW: u32 = 0x08000000;
const SESSION: &str = "BloomFPS";

#[derive(Default)]
struct FpsState {
    child: Option<Child>,
    path: Option<PathBuf>,
    frames: RollingFrames,
    status: Option<String>,
    generation: u64,
}

static STATE: OnceLock<Mutex<FpsState>> = OnceLock::new();

fn state() -> &'static Mutex<FpsState> {
    STATE.get_or_init(|| Mutex::new(FpsState::default()))
}

pub fn start(app: &AppHandle, pid: u32) {
    stop();
    let Some(path) = crate::utils::get_setting_str(app, "bloom-presentmon-path")
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_file())
    else {
        return;
    };

    let pid = pid.to_string();
    let spawned = Command::new(&path)
        .args([
            "--process_id", pid.as_str(), "--output_stdout", "--no_console_stats",
            "--session_name", SESSION, "--stop_existing_session", "--terminate_on_proc_exit",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let mut shared = state().lock().unwrap_or_else(|p| p.into_inner());
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => {
            shared.status = Some(format!("PresentMon could not start: {error}"));
            return;
        }
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    shared.generation = shared.generation.wrapping_add(1);
    let generation = shared.generation;
    shared.path = Some(path);
    shared.child = Some(child);
    drop(shared);

    if let Some(stdout) = stdout {
        std::thread::spawn(move || {
            let mut lines = BufReader::new(stdout).lines();
            let Some(Ok(header)) = lines.next() else { return };
            let Some(col) = header_column(&header) else {
                let mut shared = state().lock().unwrap_or_else(|p| p.into_inner());
                if shared.generation == generation && shared.status.is_none() {
                    shared.status = Some("PresentMon output has no frametime column".to_string());
                }
                return;
            };
            for line in lines {
                let Ok(line) = line else { break };
                if let Some(frametime) = parse_frametime(&line, col) {
                    let mut shared = state().lock().unwrap_or_else(|p| p.into_inner());
                    if shared.generation != generation {
                        break;
                    }
                    shared.frames.push(frametime);
                }
            }
        });
    }
    if let Some(stderr) = stderr {
        std::thread::spawn(move || {
            if let Some(Ok(line)) = BufReader::new(stderr).lines().next() {
                let mut shared = state().lock().unwrap_or_else(|p| p.into_inner());
                if shared.generation == generation {
                    shared.status = Some(line);
                }
            }
        });
    }
}

pub fn stop() {
    let (path, child) = {
        let mut shared = state().lock().unwrap_or_else(|p| p.into_inner());
        shared.generation = shared.generation.wrapping_add(1);
        shared.frames = RollingFrames::default();
        shared.status = None;
        (shared.path.take(), shared.child.take())
    };
    let Some(mut child) = child else { return };
    if let Some(path) = path {
        if let Ok(mut stop) = Command::new(path)
            .args(["--session_name", SESSION, "--terminate_existing_session"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            wait_briefly(&mut stop);
        }
    }
    wait_briefly(&mut child);
}

fn wait_briefly(child: &mut Child) {
    let until = Instant::now() + Duration::from_secs(2);
    while matches!(child.try_wait(), Ok(None)) && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(50));
    }
    if !matches!(child.try_wait(), Ok(Some(_))) {
        let _ = child.kill();
    }
    let _ = child.wait();
}

pub fn snapshot() -> (Option<f64>, Option<f64>, Option<f64>, Option<String>) {
    let shared = state().lock().unwrap_or_else(|p| p.into_inner());
    let (avg, low1, frametime) = shared.frames.stats().map_or((None, None, None), |stats| {
        (Some(stats.0), Some(stats.1), Some(stats.2))
    });
    (avg, low1, frametime, shared.status.clone())
}
