use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::net::TcpListener;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::json;
use tauri::{AppHandle, Emitter};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, TerminateProcess, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
};

const ENGINE_URL: &str = "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-win-cuda-12.4.0-x64.zip";
const ENGINE_SHA256: &str = "afef0b881c500958921c3f5523b50e59ee2ec9b6f5cbd25b324c51ed308a957a";
const MODEL_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/0b364b566045a405be7225ee1e415a073e04da77/ggml-large-v3-turbo-q8_0.bin";
const MODEL_SHA256: &str = "317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1";
const MODEL_SIZE: u64 = 874_188_075;
const MODEL_NAME: &str = "ggml-large-v3-turbo-q8_0.bin";
const ENGINE_NAME: &str = "whisper-bin-win-cuda-12.4.0-x64.zip";
const CREATE_NO_WINDOW: u32 = 0x08000000;

static INSTALL_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static SERVER: Mutex<Option<(Child, u16, String)>> = Mutex::new(None);
// ponytail: Serialize these short writes; use a logger thread if log volume makes this a bottleneck.
static LOG_LOCK: Mutex<()> = Mutex::new(());

fn whisper_dir() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_default()
        .join("bloom")
        .join("whisper")
}

pub fn dlog(msg: &str) {
    let _guard = LOG_LOCK.lock().unwrap_or_else(|poison| poison.into_inner());
    let dir = whisper_dir();
    if fs::create_dir_all(&dir).is_err() { return; }
    let path = dir.join("dictation.log");
    if fs::metadata(&path).is_ok_and(|meta| meta.len() > 2 * 1024 * 1024) {
        let previous = dir.join("dictation.prev.log");
        let _ = fs::remove_file(&previous);
        let _ = fs::rename(&path, previous);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let time = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
        let _ = writeln!(file, "{}.{:03} {}", time.as_secs(), time.subsec_millis(), msg.replace(['\r', '\n'], "\\n"));
    }
}

fn error_chain(error: &dyn std::error::Error) -> String {
    let mut message = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        message.push_str(": ");
        message.push_str(&cause.to_string());
        source = cause.source();
    }
    message
}

fn request_error(kind: &str, context: &str, error: reqwest::Error) -> String {
    dlog(&format!(
        "transcribe kind={kind} {context}: {error:?} timeout={} connect={} request={} body={}",
        error.is_timeout(), error.is_connect(), error.is_request(), error.is_body()
    ));
    format!("{context}: {}", error_chain(&error))
}

fn server_exe(dir: &Path) -> Option<PathBuf> {
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_file()
            && path
                .file_name()
                .is_some_and(|name| {
                    name.to_string_lossy()
                        .eq_ignore_ascii_case("whisper-server.exe")
                })
        {
            return Some(path);
        }
        if kind.is_dir() {
            if let Some(exe) = server_exe(&path) {
                return Some(exe);
            }
        }
    }
    None
}

pub fn is_installed() -> bool {
    let dir = whisper_dir();
    dir.join(MODEL_NAME).is_file() && server_exe(&dir.join("engine")).is_some()
}

pub fn server_running() -> bool {
    SERVER
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .as_mut()
        .is_some_and(|(child, _, _)| child.try_wait().is_ok_and(|status| status.is_none()))
}

pub fn server_status() -> String {
    let mut server = SERVER.lock().unwrap_or_else(|poison| poison.into_inner());
    match server.as_mut() {
        Some((child, port, _)) => match child.try_wait() {
            Ok(None) => format!("running pid={} port={port}", child.id()),
            Ok(Some(status)) => format!("exited pid={} port={port} status={status}", child.id()),
            Err(error) => format!("check failed pid={} port={port}: {error}", child.id()),
        },
        None => "no stored child".into(),
    }
}

async fn download(
    client: &reqwest::Client,
    app: &AppHandle,
    url: &str,
    expected_sha256: &str,
    destination: &Path,
    name: &str,
) -> Result<(), String> {
    let part = destination.with_file_name(format!(
        "{}.part",
        destination.file_name().unwrap_or_default().to_string_lossy()
    ));
    let _ = fs::remove_file(&part);
    let result = async {
        let mut response = client
            .get(url)
            .send()
            .await
            .map_err(|e| format!("{name} download failed: {e}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "{name} download returned HTTP {}",
                response.status()
            ));
        }
        let total = if name == "model" {
            MODEL_SIZE
        } else {
            response.content_length().unwrap_or(0)
        };
        let mut output =
            File::create(&part).map_err(|e| format!("Cannot create {}: {e}", part.display()))?;
        let mut hash = ring::digest::Context::new(&ring::digest::SHA256);
        let mut done = 0u64;
        let mut last_progress = None::<Instant>;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| format!("{name} download interrupted: {e}"))?
        {
            output
                .write_all(&chunk)
                .map_err(|e| format!("Cannot write {}: {e}", part.display()))?;
            hash.update(&chunk);
            done += chunk.len() as u64;
            if last_progress.is_none_or(|last| last.elapsed() >= Duration::from_millis(500)) {
                let _ = app.emit(
                    "dictation-status",
                    json!({"phase":"download","file":name,"done":done,"total":total}),
                );
                last_progress = Some(Instant::now());
            }
        }
        output
            .flush()
            .map_err(|e| format!("Cannot flush {}: {e}", part.display()))?;
        drop(output);
        let actual = hash
            .finish()
            .as_ref()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        if actual != expected_sha256 || (name == "model" && done != MODEL_SIZE) {
            return Err(format!("{name} SHA256 or size mismatch"));
        }
        let _ = fs::remove_file(destination);
        fs::rename(&part, destination)
            .map_err(|e| format!("Cannot install {}: {e}", destination.display()))
    }
    .await;
    if result.is_err() {
        let _ = fs::remove_file(part);
    }
    result
}

pub async fn ensure_installed(app: &AppHandle) -> Result<(), String> {
    let _guard = INSTALL_LOCK.lock().await;
    let result = async {
        if std::env::var_os("LOCALAPPDATA").is_none() {
            return Err("LOCALAPPDATA is not set".to_string());
        }
        let dir = whisper_dir();
        fs::create_dir_all(&dir)
            .map_err(|e| format!("Cannot create {}: {e}", dir.display()))?;
        let engine_dir = dir.join("engine");
        let model = dir.join(MODEL_NAME);
        if is_installed() {
            return Ok(());
        }
        // Ignore an already installed provider, as in the existing network commands.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.url().scheme() == "https" && attempt.previous().len() < 10 {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            }))
            .build()
            .map_err(|e| format!("Cannot create download client: {e}"))?;
        if server_exe(&engine_dir).is_none() {
            let zip = dir.join(ENGINE_NAME);
            download(&client, app, ENGINE_URL, ENGINE_SHA256, &zip, "engine").await?;
            if engine_dir.exists() {
                fs::remove_dir_all(&engine_dir)
                    .map_err(|e| format!("Cannot clean engine directory: {e}"))?;
            }
            fs::create_dir_all(&engine_dir)
                .map_err(|e| format!("Cannot create engine directory: {e}"))?;
            let unpack = Command::new(r"C:\Windows\System32\tar.exe")
                .arg("-xf")
                .arg(&zip)
                .arg("-C")
                .arg(&engine_dir)
                .creation_flags(CREATE_NO_WINDOW)
                .status();
            let _ = fs::remove_file(&zip);
            if !unpack.is_ok_and(|status| status.success()) || server_exe(&engine_dir).is_none() {
                let _ = fs::remove_dir_all(&engine_dir);
                return Err("Cannot unpack a usable whisper-server.exe from engine archive".into());
            }
        }
        if !model.is_file() {
            download(&client, app, MODEL_URL, MODEL_SHA256, &model, "model").await?;
        }
        Ok(())
    }
    .await;
    match &result {
        Ok(()) => {
            let _ = app.emit("dictation-status", json!({"phase":"ready"}));
        }
        Err(message) => {
            let _ = app.emit(
                "dictation-status",
                json!({"phase":"error","message":message}),
            );
        }
    }
    result
}

pub fn start_server(lang: &str) -> Result<u16, String> {
    if !matches!(lang, "de" | "en" | "auto") {
        return Err("Unsupported dictation language".into());
    }
    let mut server = SERVER.lock().unwrap_or_else(|poison| poison.into_inner());
    if let Some((child, port, current_lang)) = server.as_mut() {
        match child.try_wait() {
            Ok(None) if current_lang == lang => {
                dlog(&format!("start_server reused port={port} pid={}", child.id()));
                return Ok(*port);
            }
            Ok(Some(status)) => dlog(&format!("start_server old child pid={} exited status={status}", child.id())),
            Ok(None) => {}
            Err(error) => {
                dlog(&format!("start_server old child pid={} try_wait failed: {error}", child.id()));
                return Err(format!("Cannot check whisper server: {error}"));
            }
        }
    }
    let dir = whisper_dir();
    let model = dir.join(MODEL_NAME);
    let exe = server_exe(&dir.join("engine")).ok_or("Whisper engine is not installed")?;
    if !model.is_file() {
        return Err("Whisper model is not installed".into());
    }
    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|e| format!("Cannot reserve local port: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Cannot read local port: {e}"))?
        .port();
    drop(listener);
    if let Some((mut old, _, _)) = server.take() {
        let _ = old.kill();
        let _ = old.wait();
    }
    let _ = fs::remove_file(dir.join("server.pid"));
    let log_path = dir.join("server.log");
    if log_path.exists() {
        let previous = dir.join("server.prev.log");
        let _ = fs::remove_file(&previous);
        fs::rename(&log_path, previous)
            .map_err(|e| format!("Cannot preserve {}: {e}", log_path.display()))?;
    }
    let log = File::create(&log_path)
        .map_err(|e| format!("Cannot create {}: {e}", log_path.display()))?;
    let stderr_log = log
        .try_clone()
        .map_err(|e| format!("Cannot clone {}: {e}", log_path.display()))?;
    let mut child = Command::new(&exe)
        .arg("-m")
        .arg(&model)
        .args(["--host", "127.0.0.1", "--port"])
        .arg(port.to_string())
        .args(["-l", lang, "-fa", "-sns", "-mc", "0"])
        .current_dir(exe.parent().ok_or("Whisper engine directory is missing")?)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(stderr_log))
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("Cannot start whisper server: {e}"))?;
    if let Err(e) = fs::write(dir.join("server.pid"), child.id().to_string()) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("Cannot write whisper server PID: {e}"));
    }
    dlog(&format!("start_server spawned port={port} pid={} lang={lang}", child.id()));
    *server = Some((child, port, lang.to_string()));
    Ok(port)
}

pub fn stop_server(reason: &str) {
    let mut server = SERVER.lock().unwrap_or_else(|poison| poison.into_inner());
    if let Some((mut child, _, _)) = server.take() {
        dlog(&format!("stop_server reason={reason} pid={}", child.id()));
        let _ = child.kill();
        let _ = child.wait();
    } else {
        dlog(&format!("stop_server reason={reason} no stored child"));
    }
    let _ = fs::remove_file(whisper_dir().join("server.pid"));
}

pub fn kill_stale_server() {
    let pid_file = whisper_dir().join("server.pid");
    if let Ok(pid) = fs::read_to_string(&pid_file) {
        if let Ok(pid) = pid.trim().parse::<u32>() {
            unsafe {
                if let Ok(process) = OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE,
                    false,
                    pid,
                ) {
                    let mut path = vec![0u16; 32_768];
                    let mut len = path.len() as u32;
                    if QueryFullProcessImageNameW(
                        process,
                        PROCESS_NAME_WIN32,
                        windows::core::PWSTR(path.as_mut_ptr()),
                        &mut len,
                    )
                    .is_ok()
                    {
                        let image = String::from_utf16_lossy(&path[..len as usize]);
                        if image
                            .rsplit('\\')
                            .next()
                            .is_some_and(|name| name.eq_ignore_ascii_case("whisper-server.exe"))
                        {
                            let _ = TerminateProcess(process, 1);
                        }
                    }
                    let _ = CloseHandle(process);
                }
            }
        }
    }
    let _ = fs::remove_file(pid_file);
}

fn server_log_tail(log: &str) -> String {
    let lines: Vec<_> = log.lines().collect();
    let errors: Vec<_> = lines
        .iter()
        .copied()
        .filter(|line| line.to_ascii_lowercase().contains("error"))
        .collect();
    let selected = if errors.is_empty() { &lines } else { &errors };
    selected[selected.len().saturating_sub(3)..].join("\n")
}

pub async fn wait_ready(port: u16) -> Result<(), String> {
    let started = Instant::now();
    let result = async {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| format!("Cannot create local client: {e}"))?;
    let url = format!("http://127.0.0.1:{port}/");
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if client.get(&url).send().await.is_ok() {
            return Ok(());
        }
        if let Some((child, child_port, _)) = SERVER
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .as_mut()
        {
            if *child_port == port
                && child
                    .try_wait()
                    .map_err(|e| format!("Cannot check whisper server: {e}"))?
                    .is_some()
            {
                let mut message =
                    "Whisper server exited; check NVIDIA driver and VC++ runtime".to_string();
                if let Ok(log) = fs::read(whisper_dir().join("server.log")) {
                    let tail = server_log_tail(&String::from_utf8_lossy(&log));
                    if !tail.is_empty() {
                        message.push_str(&format!("\n{tail}"));
                    }
                }
                return Err(message);
            }
        }
        if Instant::now() >= deadline {
            return Err("Whisper server did not become ready within 60 seconds; check NVIDIA driver and VC++ runtime".into());
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    }.await;
    match &result {
        Ok(()) => dlog(&format!("wait_ready port={port} ready after {} ms", started.elapsed().as_millis())),
        Err(message) => dlog(&format!("wait_ready port={port} failed after {} ms: {message}", started.elapsed().as_millis())),
    }
    result
}

pub async fn transcribe(kind: &str, port: u16, wav: Vec<u8>, lang: &str, prompt: &str) -> Result<String, String> {
    let started = Instant::now();
    let wav_bytes = wav.len();
    let audio_seconds = wav_bytes.saturating_sub(44) as f64 / 32_000.0;
    let result = async {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| request_error(kind, "Cannot create local client", e))?;
    let file = reqwest::multipart::Part::bytes(wav)
        .file_name("a.wav")
        .mime_str("audio/wav")
        .map_err(|e| request_error(kind, "Cannot prepare WAV upload", e))?;
    let mut form = reqwest::multipart::Form::new()
        .part("file", file)
        .text("language", lang.to_string())
        .text("temperature", "0")
        .text("response_format", "json");
    if !prompt.is_empty() {
        form = form.text("prompt", prompt.to_string());
    }
    let response = client
        .post(format!("http://127.0.0.1:{port}/inference"))
        .multipart(form)
        .send()
        .await
        .map_err(|e| request_error(kind, "Whisper request failed", e))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| request_error(kind, "Cannot read whisper response", e))?;
    if !status.is_success() {
        let excerpt = body.chars().take(300).collect::<String>();
        dlog(&format!("transcribe kind={kind} HTTP {status} body_excerpt={excerpt:?}"));
        return Err(format!(
            "Whisper returned HTTP {status}: {excerpt}"
        ));
    }
    let json: serde_json::Value = serde_json::from_str(&body).map_err(|e| {
        dlog(&format!("transcribe kind={kind} Invalid whisper response: {e:?}"));
        format!("Invalid whisper response: {}", error_chain(&e))
    })?;
    let text = json
        .get("text")
        .and_then(|value| value.as_str())
        .ok_or("Whisper response has no text")?;
    Ok(crate::dictation::clean_transcript(text))
    }.await;
    match &result {
        Ok(text) => dlog(&format!("transcribe kind={kind} port={port} audio_seconds={audio_seconds:.3} wav_bytes={wav_bytes} elapsed_ms={} text_chars={}", started.elapsed().as_millis(), text.chars().count())),
        Err(message) => {
            dlog(&format!("transcribe kind={kind} port={port} audio_seconds={audio_seconds:.3} wav_bytes={wav_bytes} elapsed_ms={} error={message}", started.elapsed().as_millis()));
            dlog(&format!("transcribe kind={kind} server_status={}", server_status()));
            match fs::read(whisper_dir().join("server.log")) {
                Ok(log) => {
                    let log = String::from_utf8_lossy(&log);
                    let lines: Vec<_> = log.lines().collect();
                    dlog(&format!("transcribe kind={kind} server.log last 20 lines: {}", lines[lines.len().saturating_sub(20)..].join("\n")));
                }
                Err(error) => dlog(&format!("transcribe kind={kind} cannot read server.log: {error}")),
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::{error_chain, server_exe, server_log_tail};
    use std::fs;

    #[test]
    fn error_chain_includes_source() {
        #[derive(Debug)]
        struct WithSource;
        impl std::fmt::Display for WithSource {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "request failed")
            }
        }
        impl std::error::Error for WithSource {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                Some(&std::fmt::Error)
            }
        }
        assert_eq!(error_chain(&WithSource), "request failed: an error occurred when formatting an argument");
    }

    #[test]
    fn finds_nested_server_executable() {
        let dir = std::env::temp_dir().join(format!("bloom-whisper-search-{}", std::process::id()));
        let nested = dir.join("build").join("bin");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("whisper-server.exe"), []).unwrap();
        assert_eq!(server_exe(&dir), Some(nested.join("whisper-server.exe")));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn server_log_tail_prefers_recent_errors() {
        assert_eq!(
            server_log_tail("old error\nstart\nError one\n\nnote\nerror two\nerror three\nend\n"),
            "Error one\nerror two\nerror three"
        );
        assert_eq!(server_log_tail("one\ntwo\nthree\nfour\n"), "two\nthree\nfour");
    }
}
