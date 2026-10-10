import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { TrayIcon } from "./icons";
import { initTheme } from "./theme";

export default function TrayCorner() {
	const [visible, setVisible] = useState(false);

	useEffect(() => initTheme(), []);

	useEffect(() => {
		const unlisten = listen<{ visible: boolean }>("tray-corner", (event) => {
			setVisible(event.payload.visible);
		});
		return () => {
			unlisten.then((fn) => fn());
		};
	}, []);

	return (
		<div className="tray-corner">
			<AnimatePresence>
				{visible && (
					<motion.button
						className="tray-corner-button"
						type="button"
						title="System Tray"
						aria-label="Open system tray"
						initial={{ opacity: 0 }}
						animate={{ opacity: 1 }}
						exit={{ opacity: 0 }}
						transition={{ duration: 0.2 }}
						onClick={() => {
							invoke("open_system_tray").catch((error) =>
								console.error("Failed to open system tray:", error)
							);
						}}
					>
						<TrayIcon />
					</motion.button>
				)}
			</AnimatePresence>
		</div>
	);
}
