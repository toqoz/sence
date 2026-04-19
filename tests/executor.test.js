import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildFenceArgs, splitStderr } from "../src/executor.js";

describe("buildFenceArgs", () => {
  it("builds basic fence -m command", () => {
    const args = buildFenceArgs({ command: ["claude", "-p", "fix tests"] });
    assert.deepEqual(args, ["fence", "-m", "--", "claude", "-p", "fix tests"]);
  });

  it("includes --settings when profile path is given", () => {
    const args = buildFenceArgs({
      command: ["npm", "install"],
      settingsPath: "/path/to/policy.json",
    });
    assert.deepEqual(args, [
      "fence",
      "-m",
      "--settings",
      "/path/to/policy.json",
      "--",
      "npm",
      "install",
    ]);
  });

  it("includes --template when template is given", () => {
    const args = buildFenceArgs({
      command: ["npm", "install"],
      template: "npm-install",
    });
    assert.deepEqual(args, [
      "fence",
      "-m",
      "--template",
      "npm-install",
      "--",
      "npm",
      "install",
    ]);
  });
});

describe("splitStderr", () => {
  it("separates monitor log from command stderr", () => {
    const stderr = [
      "[fence:http] 10:00:00 ✗ CONNECT 403 example.com https://example.com:443 (0s)",
      "[fence:logstream] 10:00:01 ✗ file-write-create /tmp/x (node:123)",
      "Error: something went wrong",
      "    at main (/src/index.js:10:5)",
    ].join("\n");

    const result = splitStderr(stderr);

    assert.ok(result.monitorLog.includes("[fence:http]"));
    assert.ok(result.monitorLog.includes("[fence:logstream]"));
    assert.ok(result.commandStderr.includes("Error: something went wrong"));
    assert.ok(!result.commandStderr.includes("[fence:"));
  });

  it("handles empty stderr", () => {
    const result = splitStderr("");
    assert.equal(result.monitorLog, "");
    assert.equal(result.commandStderr, "");
  });
});
