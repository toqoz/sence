import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/cli.js";

describe("parseArgs", () => {
  it("parses bare command", () => {
    const result = parseArgs(["claude", "-p", "fix tests"]);
    assert.deepEqual(result.command, ["claude", "-p", "fix tests"]);
    assert.equal(result.suggest, "auto");
    assert.equal(result.report, "text");
    assert.equal(result.profile, "default");
    assert.equal(result.verbose, false);
  });

  it("parses command after --", () => {
    const result = parseArgs(["--", "claude", "-p", "fix tests"]);
    assert.deepEqual(result.command, ["claude", "-p", "fix tests"]);
  });

  it("parses --suggest option", () => {
    const result = parseArgs(["--suggest", "never", "--", "echo", "hi"]);
    assert.equal(result.suggest, "never");
    assert.deepEqual(result.command, ["echo", "hi"]);
  });

  it("rejects --suggest always (removed)", () => {
    const result = parseArgs(["--suggest", "always", "echo", "hi"]);
    assert.ok(result.error);
  });

  it("parses --suggest never", () => {
    const result = parseArgs(["--suggest", "never", "echo", "hi"]);
    assert.equal(result.suggest, "never");
  });

  it("parses --report json", () => {
    const result = parseArgs(["--report", "json", "echo", "hi"]);
    assert.equal(result.report, "json");
  });

  it("parses --profile option", () => {
    const result = parseArgs(["--profile", "strict", "echo", "hi"]);
    assert.equal(result.profile, "strict");
    assert.deepEqual(result.command, ["echo", "hi"]);
  });

  it("parses --verbose flag", () => {
    const result = parseArgs(["--verbose", "echo", "hi"]);
    assert.equal(result.verbose, true);
  });

  it("parses --help flag", () => {
    const result = parseArgs(["--help"]);
    assert.equal(result.help, true);
    assert.equal(result.error, null);
  });

  it("returns error when no command given", () => {
    const result = parseArgs([]);
    assert.ok(result.error);
  });

  it("returns error when only flags given", () => {
    const result = parseArgs(["--suggest", "auto"]);
    assert.ok(result.error);
  });

  it("stops parsing flags after first non-flag arg", () => {
    const result = parseArgs(["claude", "--suggest", "auto"]);
    assert.deepEqual(result.command, ["claude", "--suggest", "auto"]);
    assert.equal(result.suggest, "auto"); // default
  });

  it("rejects invalid --suggest value", () => {
    const result = parseArgs(["--suggest", "maybe", "echo", "hi"]);
    assert.ok(result.error);
    assert.ok(result.error.includes("maybe"));
  });

  it("rejects invalid --report value", () => {
    const result = parseArgs(["--report", "yaml", "echo", "hi"]);
    assert.ok(result.error);
    assert.ok(result.error.includes("yaml"));
  });

  it("parses --rollback without number", () => {
    const result = parseArgs(["--rollback"]);
    assert.equal(result.rollback, 1);
    assert.equal(result.error, null);
  });

  it("parses --rollback with number", () => {
    const result = parseArgs(["--rollback", "3"]);
    assert.equal(result.rollback, 3);
    assert.equal(result.error, null);
  });

  it("parses --patch option", () => {
    const result = parseArgs(["--patch", "/tmp/policy.json", "echo", "hi"]);
    assert.equal(result.patch, "/tmp/policy.json");
    assert.deepEqual(result.command, ["echo", "hi"]);
  });

  it("parses --suggest never with --interactive", () => {
    const result = parseArgs(["--suggest", "never", "--interactive", "--", "claude", "-p", "hi"]);
    assert.equal(result.suggest, "never");
    assert.equal(result.interactive, true);
    assert.equal(result.error, null);
  });

  it("rejects invalid --suggest with --interactive", () => {
    const result = parseArgs(["--suggest", "maybe", "--interactive", "--", "claude"]);
    assert.ok(result.error);
    assert.ok(result.error.includes("maybe"));
  });

});
