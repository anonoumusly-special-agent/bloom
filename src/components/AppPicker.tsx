import { useState, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import type { AppInfo } from "../dockApps";
import "./AppPicker.css";

type AppSource = "installed" | "windows";

const samePath = (a: AppInfo, b: AppInfo) => a.path === b.path;
const pathKey = (app: AppInfo) => app.path;
const EMPTY_APPS: AppInfo[] = [];
const INSTALLED_ONLY: AppSource[] = ["installed"];

export function AppPicker({
	onClose,
	onSelect,
	containerRef,
	scale = 1,
	runningApps = EMPTY_APPS,
	pinned = EMPTY_APPS,
	bottom = 56,
	sources = INSTALLED_ONLY,
	modal = false,
	isSameApp = samePath,
	itemKey = pathKey
}: {
	onClose: () => void;
	onSelect: (app: AppInfo) => void;
	containerRef: React.RefObject<HTMLDivElement | null>;
	scale?: number;
	runningApps?: AppInfo[];
	pinned?: AppInfo[];
	bottom?: number;
	sources?: AppSource[];
	modal?: boolean;
	isSameApp?: (a: AppInfo, b: AppInfo) => boolean;
	itemKey?: (app: AppInfo) => string;
}) {
	const [source, setSource] = useState<AppSource>(sources[0] ?? "installed");
	const [apps, setApps] = useState<AppInfo[]>([]);
	const [search, setSearch] = useState("");
	const [debouncedSearch, setDebouncedSearch] = useState("");
	const [loading, setLoading] = useState(true);
	const [listIcons, setListIcons] = useState<Record<string, string>>({});
	const [selectedIndex, setSelectedIndex] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const mountedRef = useRef(false);

	useEffect(() => {
		const timer = setTimeout(() => setDebouncedSearch(search), 150);
		return () => clearTimeout(timer);
	}, [search]);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	// Reset selection when search changes
	useEffect(() => {
		setSelectedIndex(0);
	}, [debouncedSearch]);

	// Running, unpinned apps — already in memory, so the default view is
	// instant and relevant instead of the first 20 alphabetical installs.
	// Pinned matching is fuzzy: a pinned .lnk and its running .exe are the
	// same app and must not show up as pinnable again.
	const runningSuggestions = useMemo(
		() => runningApps.filter((a) => a.path !== "start" && !pinned.some((p) => isSameApp(p, a))),
		[runningApps, pinned, isSameApp]
	);

	const sections = useMemo(() => {
		const s = debouncedSearch.trim().toLowerCase();
		// No query: running apps first, then the full installed list.
		// Already-pinned entries are excluded; backend filters helper junk
		// (uninstallers, help/readme entries) out of the scan itself.
		if (!s && source === "installed") {
			const runningIds = new Set(runningSuggestions.map((a) => itemKey(a)));
			const rest = apps
				.filter(
					(a) =>
						a.path !== "start" &&
						!pinned.some((p) => isSameApp(p, a)) &&
						!runningIds.has(itemKey(a))
				)
				.slice(0, 60);
			const out: { title: string | null; items: AppInfo[] }[] = [];
			if (runningSuggestions.length > 0) out.push({ title: "Running", items: runningSuggestions });
			if (rest.length > 0) out.push({ title: "All apps", items: rest });
			return out;
		}
		const starts: AppInfo[] = [];
		const contains: AppInfo[] = [];
		for (const a of apps) {
			// Search covers everything, including pinned — unlike the browse
			// view, which skips what's already on the dock.
			if (a.path === "start") continue;
			const n = a.name.toLowerCase();
			if (n.startsWith(s)) starts.push(a);
			else if (n.includes(s)) contains.push(a);
		}
		const byName = (x: AppInfo, y: AppInfo) => x.name.localeCompare(y.name);
		starts.sort(byName);
		contains.sort(byName);
		return [{ title: null, items: [...starts, ...contains].slice(0, 50) }];
	}, [apps, debouncedSearch, pinned, runningSuggestions, source, isSameApp, itemKey]);

	// Flat selectable list; section headers are not selectable.
	const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);
	const flatIndex = useMemo(() => new Map(flat.map((a, i) => [a, i])), [flat]);

	// Keep selection in range as results narrow.
	useEffect(() => {
		setSelectedIndex((i) => Math.min(i, Math.max(0, flat.length - 1)));
	}, [flat.length]);

	// Scroll selected item into view on keyboard nav only — never on mount,
	// where it yanks the freshly-opened list and reads as jitter.
	useEffect(() => {
		if (!mountedRef.current) {
			mountedRef.current = true;
			return;
		}
		if (!listRef.current) return;
		const row = listRef.current.querySelector(
			`[data-idx="${selectedIndex}"]`
		) as HTMLElement | null;
		if (row) row.scrollIntoView({ block: "nearest" });
	}, [selectedIndex]);

	useEffect(() => {
		let active = true;
		setApps([]);
		setLoading(true);
		const load = async () => {
			try {
				const res = await invoke<AppInfo[]>(
					source === "installed" ? "get_installed_apps" : "get_active_windows"
				);
				if (active) setApps(res.sort((a, b) => a.name.localeCompare(b.name)));
			} catch (error) {
				console.error("Failed to load apps:", error);
			} finally {
				if (active) setLoading(false);
			}
		};
		load();
		return () => {
			active = false;
		};
	}, [source]);

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				onClose();
				return;
			}
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setSelectedIndex((i) => Math.min(i + 1, flat.length - 1));
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				setSelectedIndex((i) => Math.max(i - 1, 0));
			} else if (e.key === "Enter") {
				if (e.target instanceof Element && e.target.closest(".popup-source-tabs")) return;
				e.preventDefault();
				const target = flat[selectedIndex];
				if (!target) return;
				// Already on the dock: just dismiss, never pin twice.
				if (pinned.some((p) => isSameApp(p, target))) onClose();
				else onSelect(target);
			}
		};
		const handleMouseDown = (e: MouseEvent) => {
			const popup = containerRef.current;
			if (popup && !popup.contains(e.target as Node)) {
				onClose();
			}
		};
		const handleBlur = () => onClose();
		window.addEventListener("keydown", handleKeyDown);
		window.addEventListener("blur", handleBlur);
		document.addEventListener("mousedown", handleMouseDown, true);
		return () => {
			window.removeEventListener("keydown", handleKeyDown);
			window.removeEventListener("blur", handleBlur);
			document.removeEventListener("mousedown", handleMouseDown, true);
		};
	}, [onClose, containerRef, flat, selectedIndex, onSelect, pinned, isSameApp]);

	// Fetch visible icons in parallel and commit as one batch. The old
	// sequential 20ms-per-icon loop popped icons in one by one, which read as
	// the list shifting after open. Row and icon boxes are fixed-size and
	// images fade in via onLoad, so late icons never move layout.
	useEffect(() => {
		let active = true;
		const targets = flat.slice(0, 25).filter((a) => !listIcons[a.path]);
		if (targets.length === 0) return;
		Promise.all(
			targets.map(async (app) => {
				try {
					const icon = await invoke<string | null>("get_app_icon", { path: app.path });
					return [app.path, icon] as const;
				} catch (err) {
					console.error(err);
					return [app.path, null] as const;
				}
			})
		).then((pairs) => {
			if (!active) return;
			const batch: Record<string, string> = {};
			for (const [path, icon] of pairs) if (icon) batch[path] = icon;
			if (Object.keys(batch).length > 0) setListIcons((prev) => ({ ...prev, ...batch }));
		});
		return () => {
			active = false;
		};
	}, [flat, listIcons]);

	const popup = (
		<div
			className={modal ? "app-picker-modal" : "add-popup-anchor"}
			style={modal ? undefined : { zoom: scale, bottom }}
		>
			<motion.div
				ref={containerRef}
				className="add-app-popup"
				role={modal ? "dialog" : undefined}
				aria-modal={modal ? true : undefined}
				aria-label={modal ? "Choose a game" : undefined}
				style={{ transformOrigin: "bottom center" }}
				initial={{ opacity: 0, scaleY: 0 }}
				animate={{ opacity: 1, scaleY: 1 }}
				exit={{ opacity: 0, scaleY: 0, transition: { duration: 0.16, ease: "easeIn" } }}
				transition={{
					opacity: { duration: 0.15 },
					scaleY: { type: "spring", stiffness: 300, damping: 28, mass: 0.9 }
				}}
				onClick={(e) => e.stopPropagation()}
			>
				<div className="popup-search-row">
					<svg
						className="popup-search-icon"
						width="14"
						height="14"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<circle cx="11" cy="11" r="8" />
						<line x1="21" y1="21" x2="16.65" y2="16.65" />
					</svg>
					<input
						ref={inputRef}
						type="text"
						className="popup-search-input"
						aria-label="Search apps"
						placeholder="Search apps..."
						value={search}
						onChange={(e) => setSearch(e.target.value)}
					/>
				</div>
				{sources.length > 1 && (
					<div className="popup-source-tabs" role="tablist" aria-label="App source">
						{sources.map((option) => (
							<button
								type="button"
								key={option}
								role="tab"
								aria-selected={source === option}
								className={source === option ? "active" : ""}
								onClick={() => {
									setSource(option);
									setSelectedIndex(0);
									inputRef.current?.focus();
								}}
							>
								{option === "installed" ? "Installed apps" : "Open windows"}
							</button>
						))}
					</div>
				)}
				<div className="popup-apps-scroll" ref={listRef}>
					{loading ? (
						<div aria-hidden>
							{Array.from({ length: 8 }, (_, i) => (
								<div className="popup-app-row popup-skeleton-row" key={i}>
									<div className="popup-app-icon popup-skeleton-box" />
									<div className="popup-skeleton-line" />
								</div>
							))}
						</div>
					) : flat.length > 0 ? (
						sections.map((sec) => (
							<div key={sec.title ?? "all"}>
								{sec.title && <div className="popup-section-label">{sec.title}</div>}
								{sec.items.map((app) => {
									const gi = flatIndex.get(app) ?? 0;
									const icon = listIcons[app.path];
									const alreadyPinned = pinned.some((p) => isSameApp(p, app));
									return (
										<div
											key={`${app.path}::${app.name}`}
											data-idx={gi}
											className={`popup-app-row${gi === selectedIndex ? " selected" : ""}${alreadyPinned ? " is-pinned" : ""}`}
											onClick={() => (alreadyPinned ? onClose() : onSelect(app))}
											onMouseEnter={() => setSelectedIndex(gi)}
										>
											<div className="popup-app-icon">
												{icon ? (
													<img
														key={icon}
														src={icon}
														alt=""
														draggable={false}
														style={{ opacity: 0 }}
														onLoad={(e) => {
															e.currentTarget.style.opacity = "1";
														}}
													/>
												) : (
													<span className="popup-app-initial">{app.name[0]}</span>
												)}
											</div>
											<span className="popup-app-name">{app.name}</span>
											<span className="popup-app-pin">{alreadyPinned ? "✓" : "+"}</span>
										</div>
									);
								})}
							</div>
						))
					) : (
						<div className="popup-empty">
							{debouncedSearch.trim()
								? "No results"
								: source === "windows"
									? "No open windows"
									: "Running apps show up here — search to pin anything else"}
						</div>
					)}
				</div>
			</motion.div>
		</div>
	);
	return modal ? createPortal(popup, document.body) : popup;
}
