import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FileVideo, Gamepad2, Plus, X } from "lucide-react";
import { AppPicker } from "../components/AppPicker";
import type { AppInfo } from "../dockApps";
import { SettingRow } from "./SettingRow";

interface GamingTabProps {
	enabled: boolean;
	toggleEnabled: () => void;
	processes: string[];
	onProcessesChange: (processes: string[]) => void;
	presentMonPath: string;
	onPresentMonPathChange: (path: string) => void;
}

interface GamingModeState {
	active: boolean;
	game: string | null;
}

const GAME_SOURCES: ("installed" | "windows")[] = ["installed", "windows"];

export function GamingTab({ enabled, toggleEnabled, processes, onProcessesChange, presentMonPath, onPresentMonPathChange }: GamingTabProps) {
	const [pickerOpen, setPickerOpen] = useState(false);
	const [missingExeApp, setMissingExeApp] = useState<string | null>(null);
	const [manualGame, setManualGame] = useState("");
	const [status, setStatus] = useState<GamingModeState | null>(null);
	const [fpsStatus, setFpsStatus] = useState<string | null>(null);
	const pickerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		let active = true;
		const unlisten = listen<GamingModeState>("gaming-mode", (event) => {
			if (active) setStatus(event.payload);
		});
		const unlistenStats = listen<{ fpsStatus: string | null }>("gaming-stats", (event) => {
			if (active) setFpsStatus(event.payload.fpsStatus);
		});
		unlisten
			.then(() => invoke<GamingModeState>("get_gaming_mode_state"))
			.then((state) => {
				if (active) setStatus(state);
			})
			.catch(console.error);
		return () => {
			active = false;
			unlisten.then((stop) => stop()).catch(console.error);
			unlistenStats.then((stop) => stop()).catch(console.error);
		};
	}, []);

	const addGame = (app: AppInfo) => {
		const executable = (app.executable?.trim() || app.path).split(/[\\/]/).pop()?.trim() || "";
		if (!/\.exe$/i.test(executable)) {
			setMissingExeApp(app.name);
		} else if (!processes.some((item) => item.toLowerCase() === executable.toLowerCase())) {
			onProcessesChange([...processes, executable]);
			setMissingExeApp(null);
		}
		setPickerOpen(false);
	};

	const addManualGame = () => {
		const filename = manualGame.trim().split(/[\\/]/).pop()?.trim() || "";
		if (filename) {
			const executable = /\.exe$/i.test(filename) ? filename : `${filename}.exe`;
			if (!processes.some((item) => item.toLowerCase() === executable.toLowerCase())) {
				onProcessesChange([...processes, executable]);
				setMissingExeApp(null);
			}
		}
		setManualGame("");
	};

	return (
		<>
			<div className="setting-group-label">Gaming</div>
			<div className="setting-group">
				<SettingRow icon={Gamepad2} label="Gaming Mode" desc="Activate when a selected game is running">
					<label className="toggle-switch">
						<input type="checkbox" checked={enabled} onChange={toggleEnabled} />
						<span className="slider" />
					</label>
				</SettingRow>
				<SettingRow icon={Plus} label="Games" desc="Choose which games trigger Gaming Mode">
					<button type="button" className="announcement-banner-link" onClick={() => setPickerOpen(true)}>
						Add game
					</button>
				</SettingRow>
				{missingExeApp && (
					<p className="setting-desc" style={{ margin: "8px 14px 8px 54px" }}>
						{missingExeApp} has no .exe. Start the game and pick it under Open windows, or type the exe name below.
					</p>
				)}
				<SettingRow icon={Plus} label="Exe name" desc="Add a game by its process name">
					<form onSubmit={(event) => { event.preventDefault(); addManualGame(); }} style={{ display: "flex", gap: 6 }}>
						<input
							type="text"
							className="gaming-path-input"
							aria-label="Game exe name"
							placeholder="VALORANT-Win64-Shipping.exe"
							value={manualGame}
							onChange={(event) => setManualGame(event.target.value)}
						/>
						<button type="submit" className="announcement-banner-link">Add</button>
					</form>
				</SettingRow>
				<SettingRow icon={FileVideo} label="PresentMon path" desc="Path to PresentMon.exe for FPS metrics">
					<input
						type="text"
						name="bloom-presentmon-path"
						className="gaming-path-input"
						aria-label="PresentMon path"
						placeholder="C:\\path\\PresentMon.exe"
						value={presentMonPath}
						onChange={(event) => onPresentMonPathChange(event.target.value)}
					/>
				</SettingRow>
				{fpsStatus !== null && (
					<p className="setting-desc" style={{ margin: "8px 14px 8px 54px" }}>{fpsStatus}</p>
				)}
				{processes.map((process, index) => (
					<SettingRow
						key={process}
						icon={Gamepad2}
						label={process}
						divider={index < processes.length - 1}
					>
						<button
							type="button"
							className="announcement-banner-close"
								aria-label={`Remove ${process}`}
								onClick={() => onProcessesChange(processes.filter((item) => item !== process))}
							>
								<X size={14} />
							</button>
					</SettingRow>
				))}
			</div>
			<p className="setting-desc" style={{ margin: "12px 6px", lineHeight: 1.5 }}>
				Tip: For launcher games like Valorant, start the game and pick it under "Open windows",
				or add the exe name, e.g. VALORANT-Win64-Shipping.exe.
			</p>
			<p className="setting-desc" style={{ margin: "12px 6px", lineHeight: 1.5 }}>
				Needs the scheduled tasks BloomGameModeOn and BloomGameModeOff (run the setup script once).
			</p>
			{status && (
				<p className="setting-desc" style={{ margin: "12px 6px" }}>
					{status.active ? `Gaming Mode active: ${status.game}` : "Gaming Mode inactive"}
				</p>
			)}
			{pickerOpen && (
				<AppPicker
					containerRef={pickerRef}
					onClose={() => setPickerOpen(false)}
					onSelect={addGame}
					sources={GAME_SOURCES}
					modal
				/>
			)}
		</>
	);
}
