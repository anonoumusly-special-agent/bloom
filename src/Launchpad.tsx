import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogOut, Moon, Power } from "lucide-react";
import type { AppInfo } from "./dockApps";
import { reloadIfMirrorWasStale } from "./hooks/settingsMirror";
import { useSettingsSync } from "./hooks/useSettingsSync";
import { initTheme } from "./theme";

const HIDDEN_KEY = "bloom-launchpad-hidden";

function readHiddenPaths(value: string | null): Set<string> {
	try {
		const parsed: unknown = JSON.parse(value || "[]");
		return new Set(Array.isArray(parsed) ? parsed.filter((path): path is string => typeof path === "string") : []);
	} catch {
		return new Set();
	}
}

export default function Launchpad() {
	const [apps, setApps] = useState<AppInfo[]>([]);
	const [icons, setIcons] = useState<Record<string, string>>({});
	const [search, setSearch] = useState("");
	const [editing, setEditing] = useState(false);
	const [hiddenPaths, setHiddenPaths] = useState(() => readHiddenPaths(localStorage.getItem(HIDDEN_KEY)));
	const [open, setOpen] = useState(false);
	const [loading, setLoading] = useState(true);
	const inputRef = useRef<HTMLInputElement>(null);
	const openRef = useRef(false);
	const requestedIcons = useRef(new Set<string>());
	const scanSeq = useRef(0);
	useSettingsSync({ [HIDDEN_KEY]: (value) => {
		localStorage.setItem(HIDDEN_KEY, String(value));
		setHiddenPaths(readHiddenPaths(String(value)));
	} });

	const filtered = useMemo(() => {
		const query = search.trim().toLocaleLowerCase();
		return apps.filter((app) => editing || (!hiddenPaths.has(app.path) && (!query || app.name.toLocaleLowerCase().includes(query))));
	}, [apps, search, editing, hiddenPaths]);

	useEffect(() => {
		return initTheme();
	}, []);

	useEffect(() => {
		if (open && !editing) inputRef.current?.focus();
	}, [open, editing]);

	useEffect(() => {
		if (!open) return;
		let active = true;
		const mirrored = localStorage.getItem(HIDDEN_KEY);
		void invoke<Record<string, string>>("load_settings").then(async (settings) => {
			if (await reloadIfMirrorWasStale(settings)) return;
			if (!active || localStorage.getItem(HIDDEN_KEY) !== mirrored) return;
			const value = settings[HIDDEN_KEY] ?? mirrored;
			if (value !== null) localStorage.setItem(HIDDEN_KEY, value);
			setHiddenPaths(readHiddenPaths(value));
		}).catch((error) => console.error("Failed to load Launchpad settings:", error));
		return () => { active = false; };
	}, [open]);

	useEffect(() => {
		let active = true;
		let visibilityEventSeen = false;
		const loadApps = async (refresh = false) => {
			const seq = ++scanSeq.current;
			try {
				const result = await invoke<AppInfo[]>("get_installed_apps", { refresh });
				if (active && seq === scanSeq.current) {
					setApps(result.sort((a, b) =>
						a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
						a.path.localeCompare(b.path)
					));
				}
			} catch (error) {
				console.error("Failed to load installed apps:", error);
			} finally {
				if (active && seq === scanSeq.current) setLoading(false);
			}
		};
		void loadApps();

		const shown = () => {
			openRef.current = true;
			setOpen(true);
			setEditing(false);
			setSearch("");
			setLoading(true);
			void loadApps(true);
		};
		const hidden = () => {
			openRef.current = false;
			setOpen(false);
			setEditing(false);
			setSearch("");
		};
		const unlisten = listen<boolean>("launchpad-visibility", ({ payload }) => {
			visibilityEventSeen = true;
			if (payload) shown();
			else hidden();
		});
		// A Start click can show the native window before this webview subscribes.
		void unlisten.then(() => getCurrentWindow().isVisible()).then((visible) => {
			if (active && !visibilityEventSeen && visible && !openRef.current) shown();
		});
		return () => {
			active = false;
			scanSeq.current++;
			unlisten.then((fn) => fn());
		};
	}, []);

	useEffect(() => {
		const observer = new IntersectionObserver((entries) => {
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				observer.unobserve(entry.target);
				const path = (entry.target as HTMLElement).dataset.path;
				if (!path || requestedIcons.current.has(path)) continue;
				requestedIcons.current.add(path);
				void invoke<string | null>("get_app_icon", { path })
					.then((icon) => {
						if (icon) setIcons((previous) => ({ ...previous, [path]: icon }));
					})
					.catch((error) => console.error("Failed to load app icon:", error));
			}
		}, { root: document.querySelector(".launchpad-apps"), rootMargin: "120px" });
		document.querySelectorAll(".launchpad-app[data-path]").forEach((tile) => observer.observe(tile));
		return () => observer.disconnect();
	}, [filtered, open]);

	const hide = () => {
		if (!openRef.current) return;
		openRef.current = false;
		setOpen(false);
		setEditing(false);
		setSearch("");
	};

	const toggleHidden = (path: string) => {
		const next = new Set(hiddenPaths);
		if (next.has(path)) next.delete(path);
		else next.add(path);
		setHiddenPaths(next);
		const value = JSON.stringify([...next]);
		localStorage.setItem(HIDDEN_KEY, value);
		void invoke("save_setting", { key: HIDDEN_KEY, value }).catch(console.error);
	};

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (!openRef.current) return;
			if (event.key === "Escape") {
				event.preventDefault();
				if (editing) setEditing(false);
				else hide();
			} else if (event.key === "Enter" && !editing && filtered[0] && event.target === inputRef.current) {
				event.preventDefault();
				void launch(filtered[0]);
			}
		};
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("blur", hide);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("blur", hide);
		};
	});

	const launch = async (app: AppInfo) => {
		try {
			await invoke("open_app", { appName: app.path });
		} catch (error) {
			console.error(`Failed to launch ${app.name}:`, error);
		} finally {
			hide();
		}
	};

	return (
		<AnimatePresence onExitComplete={() => {
			// Let the empty WebView frame paint before hiding the native window.
			requestAnimationFrame(() => requestAnimationFrame(() => {
				if (!openRef.current) void invoke("hide_launchpad").catch(console.error);
			}));
		}}>
			{open && (
				<motion.main
					className="launchpad-backdrop"
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					exit={{ opacity: 0 }}
					transition={{ duration: 0.18 }}
					onMouseDown={(event) => {
						if (event.button !== 0) return;
						const target = event.target as Element;
						if (target.closest("button, input")) return;
						if (target.classList.contains("launchpad-apps") && event.nativeEvent.offsetX >= target.clientWidth) return;
						hide();
					}}
				>
					<motion.section
						className="launchpad-content"
						initial={{ opacity: 0, scale: 0.97 }}
						animate={{ opacity: 1, scale: 1 }}
						exit={{ opacity: 0, scale: 0.97 }}
						transition={{ duration: 0.18 }}
						aria-label="Launchpad"
					>
						<div className="launchpad-controls">
							<input
								ref={inputRef}
								className="launchpad-search"
								aria-label="Apps suchen"
								placeholder="Apps suchen"
								value={search}
								disabled={editing}
								onChange={(event) => setSearch(event.target.value)}
							/>
							<button type="button" className="launchpad-edit" onClick={() => {
								setSearch("");
								setEditing(!editing);
							}}>{editing ? "Fertig" : "Anpassen"}</button>
						</div>
						<div className="launchpad-apps">
							{filtered.length ? (
								<div className="launchpad-grid">
									{filtered.map((app) => (
										<button
											type="button"
											key={`${app.path}::${app.name}`}
											className={`launchpad-app${editing && hiddenPaths.has(app.path) ? " is-hidden" : ""}`}
											data-path={app.path}
											aria-label={editing ? `${app.name} ${hiddenPaths.has(app.path) ? "einblenden" : "ausblenden"}` : app.name}
											aria-pressed={editing ? !hiddenPaths.has(app.path) : undefined}
											onClick={() => editing ? toggleHidden(app.path) : void launch(app)}
										>
											<span className="launchpad-icon">
												{icons[app.path] ? <img src={icons[app.path]} alt="" draggable={false} /> : app.name[0]}
												{editing && <span className="launchpad-badge" aria-hidden="true">{hiddenPaths.has(app.path) ? "×" : "✓"}</span>}
											</span>
											<span className="launchpad-name">{app.name}</span>
										</button>
									))}
								</div>
							) : (
								<p className="launchpad-empty">{loading ? "Apps werden geladen…" : "Keine Apps gefunden"}</p>
							)}
						</div>
						<div className="launchpad-power">
							<button type="button" onClick={() => { hide(); void invoke("power_action", { action: "sleep" }).catch(console.error); }}><Moon size={16} aria-hidden="true" />Energie sparen</button>
							<button type="button" onClick={() => { hide(); void invoke("power_action", { action: "logoff" }).catch(console.error); }}><LogOut size={16} aria-hidden="true" />Abmelden</button>
							<button type="button" onClick={() => { hide(); void invoke("power_action", { action: "shutdown" }).catch(console.error); }}><Power size={16} aria-hidden="true" />Herunterfahren</button>
						</div>
					</motion.section>
				</motion.main>
			)}
		</AnimatePresence>
	);
}
