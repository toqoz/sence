// refence --proxy -- <command...>
// Runs inside fence sandbox. Opens /dev/tty for the agent so its I/O
// goes directly to the terminal, keeping fence's stderr pipe clean
// for monitor-only output.

import { spawn } from "node:child_process";
import { openSync } from "node:fs";

export function runProxy(command) {
  if (command.length === 0) {
    process.stderr.write("[refence proxy] No command specified.\n");
    process.exit(2);
  }

  let ttyFd;
  try {
    ttyFd = openSync("/dev/tty", "r+");
  } catch (err) {
    process.stderr.write(`[refence proxy] Cannot open /dev/tty: ${err.message}\n`);
    process.exit(2);
  }

  const child = spawn(command[0], command.slice(1), {
    stdio: [ttyFd, ttyFd, ttyFd],
  });

  // Forward signals to child
  const forwardSignal = (sig) => child.kill(sig);
  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));
  process.on("SIGWINCH", () => forwardSignal("SIGWINCH"));

  child.on("exit", (code, signal) => {
    process.exit(code ?? (signal ? 128 : 1));
  });
}
