import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildFenceArgs } from "../src/executor.js";

describe("buildFenceArgs", () => {
  it("builds basic fence -m command with log fd", () => {
    const args = buildFenceArgs({ command: ["claude", "-p", "fix tests"] });
    assert.deepEqual(args, [
      "fence",
      "-m",
      "--fence-log-file",
      "/dev/fd/3",
      "--",
      "claude",
      "-p",
      "fix tests",
    ]);
  });

  it("includes --settings when profile path is given", () => {
    const args = buildFenceArgs({
      command: ["npm", "install"],
      settingsPath: "/path/to/policy.json",
    });
    assert.deepEqual(args, [
      "fence",
      "-m",
      "--fence-log-file",
      "/dev/fd/3",
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
      "--fence-log-file",
      "/dev/fd/3",
      "--template",
      "npm-install",
      "--",
      "npm",
      "install",
    ]);
  });
});
