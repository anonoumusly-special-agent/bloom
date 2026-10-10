import React from "react";
import ReactDOM from "react-dom/client";
import TrayCorner from "./TrayCorner";
import "./TrayCorner.css";

document.addEventListener("contextmenu", (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
	<React.StrictMode>
		<TrayCorner />
	</React.StrictMode>
);
