import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { colorizeMonitorLine } from "../src/modes/tail.js";

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

describe("colorizeMonitorLine", () => {
  it("leaves non-denial lines untouched", () => {
    const line = "[fence] Sandbox manager initialized";
    assert.equal(colorizeMonitorLine(line), line);
  });

  it("wraps significant denials in red", () => {
    const line =
      "[fence:http] 10:00:00 ✗ CONNECT 403 example.com https://example.com:443 (0s)";
    assert.equal(colorizeMonitorLine(line), `${RED}${line}${RESET}`);
  });

  it("wraps significant file denials in red", () => {
    const line =
      "[fence:logstream] 10:00:01 ✗ file-read-data /Users/foo/.ssh/config (node:1234)";
    assert.equal(colorizeMonitorLine(line), `${RED}${line}${RESET}`);
  });

  it("wraps non-significant denials in yellow", () => {
    const line =
      "[fence:logstream] 22:37:31 ✗ network-bind /private/tmp/fence/nvim.u/x/nvim.9.0 (nvim:9)";
    assert.equal(colorizeMonitorLine(line), `${YELLOW}${line}${RESET}`);
  });

  it("returns the raw line when color is disabled", () => {
    const line =
      "[fence:http] 10:00:00 ✗ CONNECT 403 example.com https://example.com:443 (0s)";
    assert.equal(colorizeMonitorLine(line, { color: false }), line);
  });
});
