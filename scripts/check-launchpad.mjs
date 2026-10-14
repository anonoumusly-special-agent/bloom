import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const config = JSON.parse(read("src-tauri/tauri.conf.json"));
const capability = JSON.parse(read("src-tauri/capabilities/default.json"));
const launchpad = config.app.windows.find((window) => window.label === "launchpad");

assert.equal(launchpad?.url, "launchpad.html");
for (const [key, expected] of Object.entries({
	transparent: true,
	decorations: false,
	alwaysOnTop: true,
	skipTaskbar: true,
	visible: false
})) assert.equal(launchpad[key], expected, key);
assert.ok(capability.windows.includes("launchpad"));
assert.match(read("vite.config.ts"), /launchpad:\s*"launchpad.html"/);
assert.match(read("launchpad.html"), /src\/launchpad-main.tsx/);
assert.match(read("src-tauri/src/main.rs"), /toggle_launchpad,/);
assert.match(read("src-tauri/src/main.rs"), /hide_launchpad,/);
assert.equal(JSON.parse(read("package.json")).version, config.version);
assert.ok(read("src-tauri/Cargo.toml").includes(`version = "${config.version}"`));
assert.ok(read("src-tauri/Cargo.lock").includes(`name = "bloom"\nversion = "${config.version}"`));
assert.equal(config.version, "3.11.0");
console.log("Launchpad window wiring and version OK");
