import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AppInfo } from "./dockApps";
import { useSettingsSync } from "./hooks/useSettingsSync";
import { initTheme } from "./theme";

export default function Launchpad() {
	const [apps, setApps] = useState<AppInfo[]>([]);
	const [icons, setIcons] = useState<Record<string, string>>({});
	const [search, setSearch] = useState("");
	const [open, setOpen] = useState(false);
	const [loading, setLoading] = useState(true);
	const inputRef = useRef<HTMLInputElement>(null);
	const openRef = useRef(false);
	const requestedIcons = useRef(new Set<string>());
	const scanSeq = useRef(0);
	useSettingsSync({});

	const filtered = useMemo(() => {
		const query = search.trim().toLocaleLowerCase();
		return query ? apps.filter((app) => app.name.toLocaleLowerCase().includes(query)) : apps;
	}, [apps, search]);

	useEffect(() => {
		return initTheme();
	}, []);

	useEffect(() => {
		if (open) inputRef.current?.focus();
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
			setSearch("");
			setLoading(true);
			void loadApps(true);
		};
		const hidden = () => {
			openRef.current = false;
			setOpen(false);
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
		openRef.current = false;
		setOpen(false);
		setSearch("");
		void invoke("hide_launchpad").catch(console.error);
	};

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (!openRef.current) return;
			if (event.key === "Escape") {
				event.preventDefault();
				hide();
			} else if (event.key === "Enter" && filtered[0]) {
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
		<AnimatePresence>
			{open && (
				<motion.main
					className="launchpad-backdrop"
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					exit={{ opacity: 0 }}
					transition={{ duration: 0.16 }}
					onMouseDown={(event) => {
						if (event.target === event.currentTarget) hide();
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
						<input
							ref={inputRef}
							className="launchpad-search"
							aria-label="Apps suchen"
							placeholder="Apps suchen"
							value={search}
							onChange={(event) => setSearch(event.target.value)}
						/>
						<div className="launchpad-apps">
							{filtered.length ? (
								<div className="launchpad-grid">
									{filtered.map((app) => (
										<button
											type="button"
											key={`${app.path}::${app.name}`}
											className="launchpad-app"
											data-path={app.path}
											onClick={() => void launch(app)}
										>
											<span className="launchpad-icon">
												{icons[app.path] ? <img src={icons[app.path]} alt="" draggable={false} /> : app.name[0]}
											</span>
											<span className="launchpad-name">{app.name}</span>
										</button>
									))}
								</div>
							) : (
								<p className="launchpad-empty">{loading ? "Apps werden geladen…" : "Keine Apps gefunden"}</p>
							)}
						</div>
					</motion.section>
				</motion.main>
			)}
		</AnimatePresence>
	);
}
