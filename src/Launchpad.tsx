import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { LogOut, Moon, Power } from "lucide-react";
import type { AppInfo } from "./dockApps";
import { reloadIfMirrorWasStale } from "./hooks/settingsMirror";
import { useSettingsSync } from "./hooks/useSettingsSync";
import { initTheme } from "./theme";

const HIDDEN_KEY = "bloom-launchpad-hidden";
const CUSTOM_KEY = "bloom-launchpad-custom";
type CustomApp = { name: string; path: string };
type LaunchpadApp = AppInfo & { isCustom?: boolean };

export function readCustomApps(value: string | null): CustomApp[] {
	try {
		const parsed: unknown = JSON.parse(value || "[]");
		const seen = new Set<string>();
		return Array.isArray(parsed) ? parsed.filter((app): app is CustomApp =>
			typeof app === "object" && app !== null &&
			typeof app.name === "string" && typeof app.path === "string" &&
			!!app.name.trim() && !!app.path.trim()
		).filter((app) => {
			const key = pathKey(app.path);
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		}) : [];
	} catch {
		return [];
	}
}

const pathKey = (path: string) => path.replace(/\//g, "\\").toLowerCase();
const isAumidLike = (path: string) => path.toLocaleLowerCase().startsWith("shell:appsfolder\\") || (path.includes("!") && !path.includes("\\"));

export function alphaBounds(pixels: Uint8ClampedArray, width: number, height: number) {
	let left = width, top = height, right = -1, bottom = -1;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if (pixels[(y * width + x) * 4 + 3] <= 8) continue;
			left = Math.min(left, x);
			top = Math.min(top, y);
			right = Math.max(right, x);
			bottom = Math.max(bottom, y);
		}
	}
	if (right < left) return null;
	const bounds = { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
	return bounds.width * bounds.height > width * height * 0.9 ? null : bounds;
}

async function trimTransparentBorders(src: string): Promise<string> {
	if (!src.startsWith("data:")) return src;
	try {
		const image = new Image();
		image.src = src;
		await image.decode();
		const canvas = document.createElement("canvas");
		canvas.width = image.naturalWidth;
		canvas.height = image.naturalHeight;
		const context = canvas.getContext("2d", { willReadFrequently: true });
		if (!context) return src;
		context.drawImage(image, 0, 0);
		const bounds = alphaBounds(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
		if (!bounds) return src;
		const trimmed = document.createElement("canvas");
		trimmed.width = bounds.width;
		trimmed.height = bounds.height;
		const trimmedContext = trimmed.getContext("2d");
		if (!trimmedContext) return src;
		trimmedContext.drawImage(image, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, bounds.width, bounds.height);
		return trimmed.toDataURL("image/png");
	} catch {
		return src;
	}
}

function readHiddenPaths(value: string | null): Set<string> {
	try {
		const parsed: unknown = JSON.parse(value || "[]");
		return new Set(Array.isArray(parsed) ? parsed.filter((path): path is string => typeof path === "string") : []);
	} catch {
		return new Set();
	}
}

export default function Launchpad() {
	const [scannedApps, setScannedApps] = useState<AppInfo[]>([]);
	const [customApps, setCustomApps] = useState(() => readCustomApps(localStorage.getItem(CUSTOM_KEY)));
	const [icons, setIcons] = useState<Record<string, string>>({});
	const [search, setSearch] = useState("");
	const [editing, setEditing] = useState(false);
	const [hiddenPaths, setHiddenPaths] = useState(() => readHiddenPaths(localStorage.getItem(HIDDEN_KEY)));
	const [open, setOpen] = useState(false);
	const [wallpaper, setWallpaper] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [menu, setMenu] = useState<{ app: LaunchpadApp; x: number; y: number } | null>(null);
	const [pendingApp, setPendingApp] = useState<CustomApp | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const openRef = useRef(false);
	const dialogHold = useRef(false);
	const menuRef = useRef<HTMLDivElement>(null);
	const requestedIcons = useRef(new Set<string>());
	const scanSeq = useRef(0);
	useSettingsSync({
		[HIDDEN_KEY]: (value) => {
			localStorage.setItem(HIDDEN_KEY, String(value));
			setHiddenPaths(readHiddenPaths(String(value)));
		},
		[CUSTOM_KEY]: (value) => {
			localStorage.setItem(CUSTOM_KEY, String(value));
			setCustomApps(readCustomApps(String(value)));
		}
	});

	const apps = useMemo<LaunchpadApp[]>(() => {
		const scannedPaths = new Set(scannedApps.map((app) => pathKey(app.path)));
		return [...scannedApps, ...customApps
			.filter((app) => !scannedPaths.has(pathKey(app.path)))
			.map((app) => ({ ...app, icon: null, is_running: false, isCustom: true }))]
			.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.path.localeCompare(b.path));
	}, [scannedApps, customApps]);

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
		const hiddenMirror = localStorage.getItem(HIDDEN_KEY);
		const customMirror = localStorage.getItem(CUSTOM_KEY);
		void invoke<Record<string, string>>("load_settings").then(async (settings) => {
			if (await reloadIfMirrorWasStale(settings)) return;
			if (!active) return;
			if (localStorage.getItem(HIDDEN_KEY) === hiddenMirror) {
				const value = settings[HIDDEN_KEY] ?? hiddenMirror;
				if (value !== null) localStorage.setItem(HIDDEN_KEY, value);
				setHiddenPaths(readHiddenPaths(value));
			}
			if (localStorage.getItem(CUSTOM_KEY) === customMirror) {
				const value = settings[CUSTOM_KEY] ?? customMirror;
				if (value !== null) localStorage.setItem(CUSTOM_KEY, value);
				setCustomApps(readCustomApps(value));
			}
		}).catch((error) => console.error("Failed to load Launchpad settings:", error));
		return () => { active = false; };
	}, [open]);

	useEffect(() => {
		let active = true;
		let visibilityEventSeen = false;
		let wallpaperRequest = 0;
		const loadWallpaper = () => {
			const request = ++wallpaperRequest;
			void invoke<string | null>("get_wallpaper")
				.then((image) => { if (active && request === wallpaperRequest) setWallpaper(image); })
				.catch((error) => console.error("Failed to load wallpaper:", error));
		};
		loadWallpaper();
		const loadApps = async (refresh = false) => {
			const seq = ++scanSeq.current;
			try {
				const result = await invoke<AppInfo[]>("get_installed_apps", { refresh });
				if (active && seq === scanSeq.current) {
					setScannedApps(result);
				}
			} catch (error) {
				console.error("Failed to load installed apps:", error);
			} finally {
				if (active && seq === scanSeq.current) setLoading(false);
			}
		};
		void loadApps();

		const shown = () => {
			if (openRef.current) return;
			openRef.current = true;
			setOpen(true);
			setEditing(false);
			setSearch("");
			setMenu(null);
			setPendingApp(null);
			setLoading(true);
			void loadApps(true);
			loadWallpaper();
		};
		const hidden = () => {
			openRef.current = false;
			setOpen(false);
			setEditing(false);
			setSearch("");
			setMenu(null);
			setPendingApp(null);
		};
		const visibilityUnlisten = listen<boolean>("launchpad-visibility", ({ payload }) => {
			visibilityEventSeen = true;
			if (payload) shown();
			else hidden();
		});
		const prepareUnlisten = listen<number>("launchpad-prepare", ({ payload: transition }) => {
			shown();
			if (active && openRef.current) {
				void invoke("show_launchpad_now", { transition }).catch(console.error);
			}
		});
		// A Start click can show the native window before this webview subscribes.
		void Promise.all([visibilityUnlisten, prepareUnlisten]).then(() => getCurrentWindow().isVisible()).then((visible) => {
			if (active && !visibilityEventSeen && visible && !openRef.current) shown();
		});
		return () => {
			active = false;
			scanSeq.current++;
			visibilityUnlisten.then((fn) => fn());
			prepareUnlisten.then((fn) => fn());
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
					.then(async (icon) => {
						if (icon) {
							const normalized = await trimTransparentBorders(icon);
							setIcons((previous) => ({ ...previous, [path]: normalized }));
						}
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
		setMenu(null);
		setPendingApp(null);
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

	const saveCustomApps = (next: CustomApp[]) => {
		setCustomApps(next);
		const value = JSON.stringify(next);
		localStorage.setItem(CUSTOM_KEY, value);
		void invoke("save_setting", { key: CUSTOM_KEY, value }).catch(console.error);
	};

	const pickApp = async () => {
		if (dialogHold.current) return;
		dialogHold.current = true;
		try {
			await invoke("set_launchpad_hold", { hold: true });
			const file = await openDialog({
				multiple: false,
				filters: [
					{ name: "Programme und Verknüpfungen", extensions: ["exe", "lnk", "bat", "cmd", "url"] },
					{ name: "Alle Dateien", extensions: ["*"] }
				]
			});
			if (typeof file === "string" && openRef.current) {
				const name = file.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") || file;
				setPendingApp({ name, path: file });
			}
		} catch (error) {
			console.error("Failed to choose app:", error);
		} finally {
			try {
				await getCurrentWindow().setFocus();
			} catch (error) {
				console.error("Failed to focus Launchpad:", error);
			} finally {
				await invoke("set_launchpad_hold", { hold: false }).catch(console.error);
				dialogHold.current = false;
			}
		}
	};

	const addApp = () => {
		if (!pendingApp?.name.trim()) return;
		if (!customApps.some((app) => pathKey(app.path) === pathKey(pendingApp.path)) &&
			!scannedApps.some((app) => pathKey(app.path) === pathKey(pendingApp.path))) {
			saveCustomApps([...customApps, { name: pendingApp.name.trim(), path: pendingApp.path }]);
		}
		setPendingApp(null);
	};

	useEffect(() => {
		if (!menu) return;
		const closeOutside = (event: MouseEvent) => {
			if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
		};
		const closeOnScroll = () => setMenu(null);
		document.addEventListener("mousedown", closeOutside);
		window.addEventListener("scroll", closeOnScroll, true);
		return () => {
			document.removeEventListener("mousedown", closeOutside);
			window.removeEventListener("scroll", closeOnScroll, true);
		};
	}, [menu]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (!openRef.current) return;
			if (event.key === "Escape") {
				event.preventDefault();
				if (menu) setMenu(null);
				else if (editing) setEditing(false);
				else if (pendingApp) setPendingApp(null);
				else hide();
			} else if (event.key === "Enter" && !editing && filtered[0] && event.target === inputRef.current) {
				event.preventDefault();
				void launch(filtered[0]);
			}
		};
		window.addEventListener("keydown", onKeyDown);
		const onBlur = () => { if (!dialogHold.current) hide(); };
		window.addEventListener("blur", onBlur);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("blur", onBlur);
		};
	});

	const launch = async (app: AppInfo, admin = false) => {
		try {
			await invoke("open_app", { appName: app.path, ...(admin ? { admin: true } : {}) });
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
						if (target.closest(".launchpad-menu")) return;
						if (menu) { setMenu(null); return; }
						if (target.closest("button, input")) return;
						if (target.classList.contains("launchpad-apps") && event.nativeEvent.offsetX >= target.clientWidth) return;
						hide();
					}}
				>
					{wallpaper && <div className="launchpad-wallpaper" style={{ backgroundImage: `url("${wallpaper}")` }} aria-hidden="true" />}
					<div className={`launchpad-tint${wallpaper ? "" : " launchpad-tint--solid"}`} aria-hidden="true" />
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
							<button type="button" className="launchpad-edit launchpad-add" aria-label="App hinzufügen" title="App hinzufügen" onClick={() => void pickApp()}>+</button>
						</div>
						{pendingApp && <form className="launchpad-add-form" onSubmit={(event) => { event.preventDefault(); addApp(); }}>
							<input aria-label="Name der App" value={pendingApp.name} onChange={(event) => setPendingApp({ ...pendingApp, name: event.target.value })} autoFocus />
							<button type="submit" disabled={!pendingApp.name.trim()}>Hinzufügen</button>
							<button type="button" onClick={() => setPendingApp(null)}>Abbrechen</button>
						</form>}
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
											onContextMenu={(event) => {
												event.preventDefault();
												if (editing) return;
												const width = Math.min(210, window.innerWidth - 16);
												const height = Math.min(app.isCustom ? 122 : 86, window.innerHeight - 16);
												setMenu({ app, x: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)) });
											}}
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
					{menu && <div ref={menuRef} className="launchpad-menu" role="menu" style={{ left: menu.x, top: menu.y }}>
						<button type="button" role="menuitem" onClick={() => { setMenu(null); void launch(menu.app); }}>Öffnen</button>
						{!isAumidLike(menu.app.path) && <button type="button" role="menuitem" onClick={() => { setMenu(null); void launch(menu.app, true); }}>Als Administrator starten</button>}
						{menu.app.isCustom && <button type="button" role="menuitem" onClick={() => {
							saveCustomApps(customApps.filter((app) => pathKey(app.path) !== pathKey(menu.app.path)));
							setMenu(null);
						}}>Entfernen</button>}
					</div>}
				</motion.main>
			)}
		</AnimatePresence>
	);
}
