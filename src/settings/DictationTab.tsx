import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Clipboard, Keyboard, Languages, List, Mic, Play, Replace, ScrollText } from "lucide-react";
import { SettingRow } from "./SettingRow";

interface DictationTabProps {
	enabled: boolean;
	busy: boolean;
	onToggle: () => Promise<void>;
	hotkey: string;
	onHotkeyChange: (value: string) => void;
	language: string;
	onLanguageChange: (value: string) => void;
	words: string;
	onWordsChange: (value: string) => void;
	replacements: string;
	onReplacementsChange: (value: string) => void;
}

interface DictationStatus {
	installed: boolean;
	server: boolean;
	recording: boolean;
}

interface DownloadStatus {
	phase: "download" | "ready" | "error";
	file?: string;
	done?: number;
	total?: number;
	message?: string;
}

interface HistoryEntry {
	time: number;
	text: string;
}

export function keyName(value: string): string {
	const code = Number(value);
	if (code >= 124 && code <= 135) return `F${code - 111}`;
	if (code >= 112 && code <= 123) return `F${code - 111}`;
	if (code >= 65 && code <= 90) return String.fromCharCode(code);
	if (code >= 48 && code <= 57) return String.fromCharCode(code);
	if (code === 32) return "Space";
	if (code === 13) return "Enter";
	if (code === 27) return "Escape";
	return `VK ${value}`;
}

export function promptLength(words: string): number {
	return Array.from(words.split(/\r?\n/).map((word) => word.trim()).filter(Boolean).join(", ")).length;
}

export function DictationTab({
	enabled, busy, onToggle, hotkey, onHotkeyChange, language, onLanguageChange,
	words, onWordsChange, replacements, onReplacementsChange
}: DictationTabProps) {
	const [status, setStatus] = useState("Checking status…");
	const [capturing, setCapturing] = useState(false);
	const [capturedKey, setCapturedKey] = useState<{ code: string; name: string } | null>(null);
	const [wordsDraft, setWordsDraft] = useState(words);
	const [replacementsDraft, setReplacementsDraft] = useState(replacements);
	const [history, setHistory] = useState<HistoryEntry[]>([]);
	const [historyError, setHistoryError] = useState("");
	const wordsLength = promptLength(wordsDraft);
	const hotkeyName = capturedKey?.code === hotkey ? capturedKey.name : keyName(hotkey);

	useEffect(() => setWordsDraft(words), [words]);
	useEffect(() => setReplacementsDraft(replacements), [replacements]);

	useEffect(() => {
		let active = true;
		let receivedStatusEvent = false;
		const refreshHistory = () => {
			invoke<HistoryEntry[]>("dictation_history")
				.then((entries) => { if (active) setHistory(entries); })
				.catch((error) => { if (active) setHistoryError(String(error)); });
		};
		const statusListener = listen<DownloadStatus>("dictation-status", ({ payload }) => {
			if (!active) return;
			receivedStatusEvent = true;
			if (payload.phase === "error") setStatus(payload.message || "Dictation setup failed");
			else if (payload.phase === "ready") setStatus("Ready");
			else {
				const percent = payload.total ? ` ${Math.min(100, Math.round((payload.done || 0) / payload.total * 100))}%` : "";
				setStatus(`Downloading ${payload.file || "dictation files"}${percent}…`);
			}
		});
		const stateListener = listen<{ state: string; message?: string }>("dictation-state", ({ payload }) => {
			if (!active) return;
			if (payload.state === "idle") refreshHistory();
			if (payload.state === "error") {
				receivedStatusEvent = true;
				setStatus(payload.message || "Dictation failed");
			}
		});
		Promise.all([statusListener, stateListener])
			.then(() => invoke<DictationStatus>("dictation_status"))
			.then((current) => {
				if (active && !receivedStatusEvent) setStatus(current.installed ? "Ready" : "Not installed");
			})
			.catch((error) => { if (active) setStatus(String(error)); });
		refreshHistory();
		return () => {
			active = false;
			statusListener.then((stop) => stop()).catch(console.error);
			stateListener.then((stop) => stop()).catch(console.error);
		};
	}, []);

	useEffect(() => {
		if (!capturing) return;
		const capture = (event: KeyboardEvent) => {
			event.preventDefault();
			event.stopPropagation();
			if (!event.keyCode) return;
			const code = String(event.keyCode);
			const name = Number(code) >= 124 && Number(code) <= 135 ? keyName(code) : event.key === " " ? "Space" : event.key;
			setCapturedKey({ code, name });
			onHotkeyChange(code);
			setCapturing(false);
		};
		window.addEventListener("keydown", capture, true);
		return () => window.removeEventListener("keydown", capture, true);
	}, [capturing, onHotkeyChange]);

	const toggle = async () => {
		setStatus(enabled ? "Stopping…" : "Preparing dictation…");
		try {
			await onToggle();
			const current = await invoke<DictationStatus>("dictation_status");
			setStatus(current.installed ? "Ready" : "Not installed");
		} catch (error) {
			setStatus(String(error));
		}
	};

	const play = async (time: number) => {
		try {
			setHistoryError("");
			const b64 = await invoke<string>("dictation_history_audio", { time });
			await new Audio("data:audio/wav;base64," + b64).play();
		} catch (error) {
			setHistoryError(String(error));
		}
	};

	const copy = async (text: string) => {
		try {
			await navigator.clipboard.writeText(text);
			setHistoryError("");
		} catch (error) {
			setHistoryError(String(error));
		}
	};

	return (
		<>
			<div className="setting-group-label">Dictation</div>
			<div className="setting-group">
				<SettingRow icon={Mic} label="Enable dictation" desc="Downloads the speech model on first use">
					<label className="toggle-switch">
						<input type="checkbox" checked={enabled} disabled={busy} onChange={toggle} />
						<span className="slider" />
					</label>
				</SettingRow>
				<SettingRow icon={Mic} label="Status" desc={status} />
				<SettingRow icon={Keyboard} label="Key" desc={`Current: ${hotkeyName}`}>
					<button type="button" className="announcement-banner-link" aria-label="Set dictation key" aria-pressed={capturing} onClick={() => setCapturing(true)}>
						{capturing ? "Listening…" : "Press a key…"}
					</button>
				</SettingRow>
				<SettingRow icon={Languages} label="Language">
					<select className="settings-select" value={language} onChange={(event) => onLanguageChange(event.target.value)}>
						<option value="de">German</option>
						<option value="en">English</option>
						<option value="auto">Auto detect</option>
					</select>
				</SettingRow>
			</div>
			<p className="setting-desc dictation-hint">Map a mouse button to this key in Logi Options. Press once to start, again to stop. Hold Space to pause.</p>

			<div className="setting-group-label">Vocabulary</div>
			<div className="setting-group">
				<SettingRow icon={List} label="Words" desc="One word per line" divider={false} />
				<div className="dictation-field">
					<textarea className="dictation-textarea" aria-label="Dictation words" value={wordsDraft} onChange={(event) => setWordsDraft(event.target.value)} onBlur={() => { if (wordsDraft !== words) onWordsChange(wordsDraft); }} />
					<span className="setting-desc">{wordsLength} / 600 characters · Put the most important words first.</span>
				</div>
				<div className="setting-divider" />
				<SettingRow icon={Replace} label="Replacements" desc="One replacement per line" divider={false} />
				<div className="dictation-field">
					<textarea className="dictation-textarea" aria-label="Dictation replacements" placeholder="wrong => right" value={replacementsDraft} onChange={(event) => setReplacementsDraft(event.target.value)} onBlur={() => { if (replacementsDraft !== replacements) onReplacementsChange(replacementsDraft); }} />
				</div>
			</div>

			<div className="setting-group-label">History</div>
			<div className="setting-group">
				{history.length === 0 && <SettingRow icon={ScrollText} label="No dictations yet" divider={false} />}
				{history.map((entry) => (
					<div className="dictation-history-item" key={entry.time}>
						<div className="setting-desc">{new Date(entry.time).toLocaleString()}</div>
						<div className="dictation-history-text">{entry.text}</div>
						<div className="dictation-history-actions">
							<button type="button" className="announcement-banner-link" onClick={() => copy(entry.text)}><Clipboard size={12} /> Copy</button>
							<button type="button" className="announcement-banner-link" onClick={() => play(entry.time)}><Play size={12} /> Play</button>
						</div>
					</div>
				))}
			</div>
			{historyError && <p className="setting-desc dictation-hint">{historyError}</p>}
		</>
	);
}
