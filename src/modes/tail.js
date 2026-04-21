import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { isDenialLine, isSignificantDenial } from "../auditor.js";

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

// Color ✗ lines so the tail pane in interactive mode visually separates
// blocking denials (red) from benign/non-significant noise (yellow) while
// leaving informational fence output untouched.
export function colorizeMonitorLine(line, { color = true } = {}) {
  if (!color) return line;
  if (!isDenialLine(line)) return line;
  if (isSignificantDenial(line)) return `${RED}${line}${RESET}`;
  return `${YELLOW}${line}${RESET}`;
}

export function runTailMode(path) {
  const color = process.stdout.isTTY === true;
  const child = spawn("tail", ["-F", path], {
    stdio: ["ignore", "pipe", "inherit"],
  });

  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    process.stdout.write(colorizeMonitorLine(line, { color }) + "\n");
  });

  const forward = (sig) => () => {
    if (!child.killed) child.kill(sig);
  };
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));
  process.on("SIGHUP", forward("SIGHUP"));

  child.on("close", (code, signal) => {
    process.exit(code ?? (signal ? 128 : 0));
  });
}
