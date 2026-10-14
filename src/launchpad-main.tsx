import React from "react";
import ReactDOM from "react-dom/client";
import Launchpad from "./Launchpad";
import "./Launchpad.css";

document.addEventListener("contextmenu", (event) => event.preventDefault());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
	<React.StrictMode>
		<Launchpad />
	</React.StrictMode>
);
