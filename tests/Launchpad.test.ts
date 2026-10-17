import assert from "node:assert/strict";
import { test } from "bun:test";

test("custom apps keep only entries with string names and paths", async () => {
	Object.defineProperty(globalThis, "localStorage", { value: {} });
	const { readCustomApps } = await import("../src/Launchpad");
	assert.deepEqual(readCustomApps(JSON.stringify([
		{ name: "Editor", path: "C:\\Apps\\editor.exe" },
		{ name: "Duplicate", path: "c:/apps/EDITOR.exe" },
		{ name: 42, path: "C:\\Apps\\wrong.exe" },
		{ name: "Blank", path: " " },
		null
	])), [{ name: "Editor", path: "C:\\Apps\\editor.exe" }]);
	assert.deepEqual(readCustomApps("not JSON"), []);
});

test("icon alpha bounds ignore faint pixels and leave full icons alone", async () => {
	const { alphaBounds } = await import("../src/Launchpad");
	const pixels = new Uint8ClampedArray(4 * 4 * 4);
	pixels[(0 * 4 + 0) * 4 + 3] = 8;
	for (const [x, y] of [[1, 1], [2, 1], [1, 2], [2, 2]]) {
		pixels[(y * 4 + x) * 4 + 3] = 255;
	}
	assert.deepEqual(alphaBounds(pixels, 4, 4), { x: 1, y: 1, width: 2, height: 2 });
	for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
	assert.equal(alphaBounds(pixels, 4, 4), null);
});
