import assert from "node:assert/strict";
import { keyName, promptLength } from "../src/settings/DictationTab";

assert.equal(keyName("124"), "F13");
assert.equal(keyName("135"), "F24");
assert.equal(promptLength("  Äpfel  \r\n\r\n Öl\nBirne"), 16);
assert.equal(promptLength("😀\nfoo"), 6);
