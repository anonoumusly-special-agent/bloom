use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

use crate::{dictation, dictation_engine};

const SPEECH_RMS: f32 = 0.01;
const SAMPLE_RATE: usize = 16_000;
const MAX_BLOCK: usize = 25 * SAMPLE_RATE;

static APP: OnceLock<AppHandle> = OnceLock::new();
static SESSION: Mutex<Option<Arc<Session>>> = Mutex::new(None);

struct Session {
    recording: AtomicBool,
    paused: AtomicBool,
    pending: Mutex<Vec<f32>>,
    all: Mutex<Vec<f32>>,
    target: isize,
    lang: String,
    prompt: String,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

fn emit_error(app: &AppHandle, message: impl std::fmt::Display) {
    let _ = app.emit("dictation-state", json!({"state":"error","message":message.to_string()}));
}

pub fn init(app: AppHandle) {
    let _ = APP.set(app.clone());
    dictation_engine::kill_stale_server();
    prewarm(app);
}

pub fn prewarm(app: AppHandle) {
    if crate::utils::get_setting_str(&app, "bloom-dictation-enabled").as_deref() == Some("true")
        && dictation_engine::is_installed()
        && !crate::gaming::is_gaming_active()
    {
        tauri::async_runtime::spawn(async move {
            let lang = crate::utils::get_setting_str(&app, "bloom-dictation-language")
                .filter(|lang| matches!(lang.as_str(), "de" | "en" | "auto"))
                .unwrap_or_else(|| "de".into());
            let result = async {
                let port = dictation_engine::start_server(&lang)?;
                dictation_engine::wait_ready(port).await
            }.await;
            if let Err(message) = result {
                emit_error(&app, message);
            }
        });
    }
}

#[tauri::command]
pub async fn dictation_prepare(app: AppHandle) -> Result<(), String> {
    dictation_engine::ensure_installed(&app).await?;
    let lang = crate::utils::get_setting_str(&app, "bloom-dictation-language")
        .filter(|lang| matches!(lang.as_str(), "de" | "en" | "auto"))
        .unwrap_or_else(|| "de".into());
    let port = dictation_engine::start_server(&lang)?;
    dictation_engine::wait_ready(port).await
}

#[tauri::command]
pub fn dictation_disable() {
    shutdown();
}

#[tauri::command]
pub fn dictation_toggle() {
    toggle();
}

#[tauri::command]
pub fn dictation_history(app: AppHandle) -> Vec<Value> {
    read_history(&history_dir(&app))
}

#[tauri::command]
pub fn dictation_history_audio(app: AppHandle, time: u64) -> Result<String, String> {
    let wav = history_dir(&app).join(format!("{time}.wav"));
    let bytes = fs::read(wav).map_err(|e| format!("Cannot read dictation audio: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[tauri::command]
pub fn dictation_status() -> Value {
    json!({
        "installed": dictation_engine::is_installed(),
        "server": dictation_engine::server_running(),
        "recording": is_recording(),
    })
}

pub fn is_recording() -> bool {
    lock(&SESSION)
        .as_ref()
        .is_some_and(|session| session.recording.load(Ordering::Acquire))
}

pub fn set_paused(paused: bool) {
    let Some(app) = APP.get() else { return };
    let session = lock(&SESSION).clone();
    if let Some(session) = session {
        if session.recording.load(Ordering::Acquire)
            && session.paused.swap(paused, Ordering::AcqRel) != paused
        {
            let _ = app.emit("dictation-state", json!({"state":if paused { "paused" } else { "recording" }}));
        }
    }
}

pub fn toggle() {
    let Some(app) = APP.get() else { return };
    let mut slot = lock(&SESSION);
    if let Some(session) = slot.as_ref() {
        if session.recording.swap(false, Ordering::AcqRel) {
            let _ = app.emit("dictation-state", json!({"state":"processing"}));
        }
        return;
    }
    if crate::gaming::is_gaming_active() {
        emit_error(app, "Diktat ist im Game Mode aus");
        return;
    }
    if crate::utils::get_setting_str(app, "bloom-dictation-enabled").as_deref() != Some("true") {
        return;
    }
    let lang = crate::utils::get_setting_str(app, "bloom-dictation-language")
        .filter(|lang| matches!(lang.as_str(), "de" | "en" | "auto"))
        .unwrap_or_else(|| "de".into());
    let prompt = dictation::build_prompt(
        &crate::utils::get_setting_str(app, "bloom-dictation-words").unwrap_or_default(), 600,
    );
    let session = Arc::new(Session {
        recording: AtomicBool::new(true),
        paused: AtomicBool::new(false),
        pending: Mutex::new(Vec::new()),
        all: Mutex::new(Vec::new()),
        target: unsafe { GetForegroundWindow().0 as isize },
        lang,
        prompt,
    });
    *slot = Some(session.clone());
    drop(slot);
    let _ = app.emit("dictation-state", json!({"state":"recording"}));
    let capture_app = app.clone();
    let capture_session = session.clone();
    let capture = std::thread::spawn(move || capture_microphone(&capture_app, &capture_session));
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        run(app, session, capture).await;
    });
}

pub fn shutdown() {
    if let Some(session) = lock(&SESSION).as_ref() {
        session.recording.store(false, Ordering::Release);
    }
    dictation_engine::stop_server();
}

pub fn pause_for_game() {
    shutdown();
}

async fn run(app: AppHandle, session: Arc<Session>, capture: std::thread::JoinHandle<Result<(), String>>) {
    let result = async {
        dictation_engine::ensure_installed(&app).await?;
        let port = dictation_engine::start_server(&session.lang)?;
        dictation_engine::wait_ready(port).await?;
        let mut committed = String::new();
        while session.recording.load(Ordering::Acquire) {
            tokio::time::sleep(Duration::from_secs(1)).await;
            if !session.recording.load(Ordering::Acquire) { break; }
            let buffer = lock(&session.pending).clone();
            if buffer.len() > MAX_BLOCK {
                let cut = dictation::last_silence_cut(&buffer, SPEECH_RMS)
                    .filter(|&cut| cut > 0)
                    .unwrap_or(MAX_BLOCK);
                if dictation::has_speech(&buffer[..cut], SPEECH_RMS) {
                    let text = dictation_engine::transcribe(
                        port, dictation::encode_wav_16k_mono(&buffer[..cut]), &session.lang, &session.prompt,
                    ).await?;
                    append_text(&mut committed, &text);
                }
                lock(&session.pending).drain(..cut);
            } else if dictation::has_speech(&buffer, SPEECH_RMS) {
                let partial = dictation_engine::transcribe(
                    port, dictation::encode_wav_16k_mono(&buffer), &session.lang, &session.prompt,
                ).await?;
                let mut text = committed.clone();
                append_text(&mut text, &partial);
                let _ = app.emit("dictation-partial", json!({"text":text}));
            }
        }
        Ok::<_, String>((port, committed))
    }.await;

    session.recording.store(false, Ordering::Release);
    let captured = tauri::async_runtime::spawn_blocking(move || capture.join()).await;
    let capture_error = match captured {
        Ok(Ok(Ok(()))) => None,
        Ok(Ok(Err(message))) => Some(message),
        _ => Some("Microphone capture thread failed".to_string()),
    };
    if let Some(message) = capture_error {
        if message == "Microphone capture thread failed" { emit_error(&app, message); }
        // Ordinary capture errors were emitted at the point of failure.
    } else if let Ok((port, mut committed)) = result {
        let rest = lock(&session.pending).clone();
        let final_result = async {
            if dictation::has_speech(&rest, SPEECH_RMS) {
                let text = dictation_engine::transcribe(
                    port, dictation::encode_wav_16k_mono(&rest), &session.lang, &session.prompt,
                ).await?;
                append_text(&mut committed, &text);
            }
            Ok::<_, String>(committed)
        }.await;
        match final_result {
            Ok(text) => finish(&app, &session, text),
            Err(message) => emit_error(&app, message),
        }
    } else {
        emit_error(&app, result.err().unwrap_or_default());
    }
    let mut slot = lock(&SESSION);
    if slot.as_ref().is_some_and(|active| Arc::ptr_eq(active, &session)) {
        *slot = None;
    }
}

fn append_text(committed: &mut String, text: &str) {
    if !text.is_empty() {
        if !committed.is_empty() { committed.push(' '); }
        committed.push_str(text);
    }
}

fn finish(app: &AppHandle, session: &Session, text: String) {
    let reps = dictation::parse_replacements(
        &crate::utils::get_setting_str(app, "bloom-dictation-replacements").unwrap_or_default(),
    );
    let text = dictation::clean_transcript(&dictation::apply_replacements(&text, &reps));
    if text.is_empty() {
        let _ = app.emit("dictation-state", json!({"state":"idle"}));
        return;
    }
    if let Err(message) = paste_text(app, session.target, &format!("{text} ")) {
        emit_error(app, message);
        return;
    }
    let samples = lock(&session.all).clone();
    if let Err(message) = save_history(app, &samples, &text, &session.lang) {
        emit_error(app, message);
    }
    let _ = app.emit("dictation-state", json!({"state":"idle","text":text}));
}

fn paste_text(app: &AppHandle, target: isize, text: &str) -> Result<(), String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_CONTROL, VK_V,
    };
    use windows::Win32::UI::WindowsAndMessaging::{IsWindow, SetForegroundWindow};
    let owner = app.get_webview_window("main")
        .ok_or("Bloom window is unavailable")?.hwnd()
        .map_err(|e| format!("Cannot get Bloom window handle: {e}"))?;
    let owner = HWND(owner.0);
    let old = clipboard_read(owner)?;
    let inserted: Vec<u16> = text.encode_utf16().collect();
    if let Err(message) = clipboard_write(owner, &inserted) {
        if let Some(old) = old.as_ref() { let _ = clipboard_write(owner, old); }
        return Err(message);
    }
    unsafe {
        if target != 0 {
            let hwnd = HWND(target as *mut _);
            if IsWindow(Some(hwnd)).as_bool() && GetForegroundWindow() != hwnd {
                if !SetForegroundWindow(hwnd).as_bool() {
                    if let Some(old) = old.as_ref() { let _ = clipboard_write(owner, old); }
                    return Err("Cannot focus the dictation target".into());
                }
            }
        }
        let key = |vk, up| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 { ki: KEYBDINPUT {
                wVk: vk, wScan: 0,
                dwFlags: if up { KEYEVENTF_KEYUP } else { Default::default() },
                time: 0, dwExtraInfo: 0,
            } },
        };
        let inputs = [key(VK_CONTROL, false), key(VK_V, false), key(VK_V, true), key(VK_CONTROL, true)];
        if SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) != inputs.len() as u32 {
            let release = [key(VK_CONTROL, true)];
            SendInput(&release, std::mem::size_of::<INPUT>() as i32);
            if let Some(old) = old.as_ref() { let _ = clipboard_write(owner, old); }
            return Err("Cannot send Ctrl+V to dictation target".into());
        }
    }
    std::thread::sleep(Duration::from_millis(300));
    if let Some(old) = old {
        // Leave a clipboard change made during the paste delay alone.
        if clipboard_read(owner)?.as_deref() == Some(inserted.as_slice()) {
            clipboard_write(owner, &old)?;
        }
    }
    Ok(())
}

fn clipboard_open(owner: HWND) -> Result<(), String> {
    use windows::Win32::System::DataExchange::OpenClipboard;
    for _ in 0..5 {
        if unsafe { OpenClipboard(Some(owner)) }.is_ok() { return Ok(()); }
        std::thread::sleep(Duration::from_millis(20));
    }
    Err("Cannot open clipboard".into())
}

fn clipboard_read(owner: HWND) -> Result<Option<Vec<u16>>, String> {
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, IsClipboardFormatAvailable,
    };
    use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
    use windows::Win32::System::Ole::CF_UNICODETEXT;
    clipboard_open(owner)?;
    let result = (|| unsafe {
        if IsClipboardFormatAvailable(CF_UNICODETEXT.0 as u32).is_err() {
            Ok(None)
        } else {
            let handle = GetClipboardData(CF_UNICODETEXT.0 as u32)
                .map_err(|e| format!("Cannot read clipboard text: {e}"))?;
            let memory = HGLOBAL(handle.0);
            let len = GlobalSize(memory) / 2;
            let ptr = GlobalLock(memory) as *const u16;
            if ptr.is_null() {
                Err("Cannot lock clipboard text".to_string())
            } else {
                let units = std::slice::from_raw_parts(ptr, len);
                let end = units.iter().position(|&ch| ch == 0).unwrap_or(len);
                let text = units[..end].to_vec();
                let _ = GlobalUnlock(memory);
                Ok(Some(text))
            }
        }
    })();
    let _ = unsafe { CloseClipboard() };
    result
}

fn clipboard_write(owner: HWND, text: &[u16]) -> Result<(), String> {
    use windows::Win32::Foundation::{GlobalFree, HANDLE};
    use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, SetClipboardData};
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Ole::CF_UNICODETEXT;
    let bytes = (text.len() + 1).checked_mul(2).ok_or("Clipboard text is too large")?;
    let memory = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes) }
        .map_err(|e| format!("Cannot allocate clipboard text: {e}"))?;
    let ptr = unsafe { GlobalLock(memory) } as *mut u16;
    if ptr.is_null() {
        let _ = unsafe { GlobalFree(Some(memory)) };
        return Err("Cannot lock clipboard allocation".into());
    }
    unsafe {
        std::ptr::copy_nonoverlapping(text.as_ptr(), ptr, text.len());
        *ptr.add(text.len()) = 0;
        let _ = GlobalUnlock(memory);
    }
    if let Err(message) = clipboard_open(owner) {
        let _ = unsafe { GlobalFree(Some(memory)) };
        return Err(message);
    }
    let result = (|| unsafe {
        EmptyClipboard().map_err(|e| format!("Cannot clear clipboard: {e}"))?;
        SetClipboardData(CF_UNICODETEXT.0 as u32, Some(HANDLE(memory.0)))
            .map_err(|e| format!("Cannot set clipboard text: {e}"))?;
        Ok(())
    })();
    let _ = unsafe { CloseClipboard() };
    if result.is_err() { let _ = unsafe { GlobalFree(Some(memory)) }; }
    result
}

fn capture_microphone(app: &AppHandle, session: &Session) -> Result<(), String> {
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
    let result = (|| unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED)
            .ok()
            .map_err(|e| format!("Cannot initialize microphone COM: {e}"))?;
        let result = capture_loop(app, session);
        CoUninitialize();
        result
    })();
    if let Err(message) = &result {
        session.recording.store(false, Ordering::Release);
        emit_error(app, message);
    }
    result
}

unsafe fn capture_loop(app: &AppHandle, session: &Session) -> Result<(), String> {
    use windows::Win32::Media::Audio::{
        eCapture, eConsole, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator,
        MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_ALL};
    let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
        .map_err(|e| format!("Cannot find microphone enumerator: {e}"))?;
    let device = enumerator.GetDefaultAudioEndpoint(eCapture, eConsole)
        .map_err(|e| format!("No default microphone: {e}"))?;
    let client: IAudioClient = device.Activate(CLSCTX_ALL, None)
        .map_err(|e| format!("Cannot activate microphone: {e}"))?;
    let format_ptr = client.GetMixFormat().map_err(|e| format!("Cannot read microphone format: {e}"))?;
    let format = *format_ptr;
    let kind = if format.wFormatTag == 0xfffe && format.cbSize >= 22 {
        let ext = &*(format_ptr as *const windows::Win32::Media::Audio::WAVEFORMATEXTENSIBLE);
        let subformat = ext.SubFormat;
        if subformat == windows::core::GUID::from_u128(0x00000003_0000_0010_8000_00aa00389b71) { 3 }
        else if subformat == windows::core::GUID::from_u128(0x00000001_0000_0010_8000_00aa00389b71) { 1 }
        else { 0 }
    } else { format.wFormatTag };
    let channels = format.nChannels as usize;
    let rate = format.nSamplesPerSec;
    let stride = format.nBlockAlign as usize;
    let bits = format.wBitsPerSample;
    let valid = channels > 0 && rate > 0
        && ((kind == 3 && bits == 32 && stride == channels * 4)
            || (kind == 1 && bits == 16 && stride == channels * 2));
    if !valid {
        CoTaskMemFree(Some(format_ptr as *const _));
        return Err(format!("Unsupported microphone format: tag {kind}, {bits} bits, {channels} channels"));
    }
    let initialized = client.Initialize(AUDCLNT_SHAREMODE_SHARED, 0, 1_000_000, 0, format_ptr, None);
    CoTaskMemFree(Some(format_ptr as *const _));
    initialized.map_err(|e| format!("Cannot initialize microphone stream: {e}"))?;
    let capture: IAudioCaptureClient = client.GetService()
        .map_err(|e| format!("Cannot get microphone capture service: {e}"))?;
    client.Start().map_err(|e| format!("Cannot start microphone: {e}"))?;
    let mut last_level = std::time::Instant::now();
    let mut level = Vec::new();
    while session.recording.load(Ordering::Acquire) {
        std::thread::sleep(Duration::from_millis(10));
        loop {
            if capture.GetNextPacketSize().map_err(|e| format!("Microphone disconnected: {e}"))? == 0 { break; }
            let mut data = std::ptr::null_mut();
            let mut frames = 0;
            let mut flags = 0;
            capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None)
                .map_err(|e| format!("Cannot read microphone: {e}"))?;
            let count = frames as usize * channels;
            let mut interleaved = Vec::with_capacity(count);
            let silent = flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0
                || session.paused.load(Ordering::Acquire);
            if silent || data.is_null() {
                interleaved.resize(count, 0.0);
            } else {
                let bytes = std::slice::from_raw_parts(data, frames as usize * stride);
                for chunk in bytes.chunks_exact(stride) {
                    for sample in chunk.chunks_exact(stride / channels) {
                        interleaved.push(if kind == 3 {
                            f32::from_le_bytes(sample.try_into().unwrap_or([0; 4]))
                        } else {
                            i16::from_le_bytes(sample.try_into().unwrap_or([0; 2])) as f32 / 32_768.0
                        });
                    }
                }
            }
            capture.ReleaseBuffer(frames).map_err(|e| format!("Cannot release microphone buffer: {e}"))?;
            let mono = dictation::to_mono(&interleaved, channels);
            // ponytail: Packet-local resampling can drift by one sample per packet at odd rates;
            // carry the fractional phase across packets if sample-accurate timing is needed.
            let samples = dictation::resample_linear(&mono, rate, SAMPLE_RATE as u32);
            level.extend_from_slice(&samples);
            lock(&session.pending).extend_from_slice(&samples);
            lock(&session.all).extend_from_slice(&samples);
        }
        if last_level.elapsed() >= Duration::from_millis(50) {
            let _ = app.emit("dictation-level", dictation::rms(&level));
            level.clear();
            last_level = std::time::Instant::now();
        }
    }
    client.Stop().map_err(|e| format!("Cannot stop microphone: {e}"))
}

pub fn history_dir(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap_or_default().join("dictation")
}

fn read_history(dir: &Path) -> Vec<Value> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    let mut records = entries.filter_map(Result::ok).filter_map(|entry| {
        let path = entry.path();
        if path.extension().is_none_or(|ext| ext != "json") { return None; }
        let record: Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
        let time = record.get("time").and_then(Value::as_u64).unwrap_or(0);
        Some((time, record))
    }).collect::<Vec<_>>();
    records.sort_unstable_by(|left, right| right.0.cmp(&left.0));
    records.into_iter().map(|(_, record)| record).collect()
}

fn save_history(app: &AppHandle, samples: &[f32], text: &str, lang: &str) -> Result<(), String> {
    app.path().app_data_dir().map_err(|e| format!("Cannot find app data directory: {e}"))?;
    let dir = history_dir(app);
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create dictation history: {e}"))?;
    let mut millis = SystemTime::now().duration_since(UNIX_EPOCH)
        .map_err(|e| format!("Cannot read current time: {e}"))?.as_millis();
    while dir.join(format!("{millis}.wav")).exists() || dir.join(format!("{millis}.json")).exists() {
        millis += 1;
    }
    let wav = dir.join(format!("{millis}.wav"));
    let meta = dir.join(format!("{millis}.json"));
    fs::write(&wav, dictation::encode_wav_16k_mono(samples))
        .map_err(|e| format!("Cannot save dictation audio: {e}"))?;
    let record = json!({"time":millis,"text":text,"lang":lang});
    if let Err(e) = fs::write(&meta, record.to_string()) {
        let _ = fs::remove_file(&wav);
        return Err(format!("Cannot save dictation record: {e}"));
    }
    prune_history(&dir)
}

fn prune_history(dir: &std::path::Path) -> Result<(), String> {
    let mut records = fs::read_dir(dir).map_err(|e| format!("Cannot list dictation history: {e}"))?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().is_none_or(|ext| ext != "json") || !path.with_extension("wav").is_file() {
                return None;
            }
            Some((path.file_stem()?.to_string_lossy().parse::<u128>().ok()?, path))
        }).collect::<Vec<_>>();
    records.sort_unstable_by_key(|(millis, _)| *millis);
    for (_, old) in records.iter().take(records.len().saturating_sub(50)) {
        fs::remove_file(old).map_err(|e| format!("Cannot remove old dictation record: {e}"))?;
        fs::remove_file(old.with_extension("wav"))
            .map_err(|e| format!("Cannot remove old dictation audio: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{prune_history, read_history};
    use serde_json::json;
    use std::fs;

    #[test]
    fn history_keeps_latest_50_complete_pairs() {
        let dir = std::env::temp_dir().join(format!("bloom-dictation-history-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        for millis in 1..=52 {
            fs::write(dir.join(format!("{millis}.json")), "{}").unwrap();
            fs::write(dir.join(format!("{millis}.wav")), []).unwrap();
        }
        fs::write(dir.join("53.json"), "{}").unwrap();
        prune_history(&dir).unwrap();
        assert!(!dir.join("1.json").exists() && !dir.join("2.wav").exists());
        assert!(dir.join("3.json").exists() && dir.join("52.wav").exists());
        assert!(dir.join("53.json").exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn history_reads_newest_first() {
        let dir = std::env::temp_dir().join(format!("bloom-dictation-read-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("10.json"), json!({"time":10,"text":"new"}).to_string()).unwrap();
        fs::write(dir.join("2.json"), json!({"time":2,"text":"old"}).to_string()).unwrap();
        fs::write(dir.join("broken.json"), "{").unwrap();
        assert_eq!(read_history(&dir), vec![json!({"time":10,"text":"new"}), json!({"time":2,"text":"old"})]);
        fs::remove_dir_all(dir).unwrap();
    }
}
