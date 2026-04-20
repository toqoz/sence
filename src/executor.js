import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export function buildFenceArgs({ command, settingsPath, template }) {
  // fd 3 is wired to a pipe by the caller; fence writes monitor/debug logs
  // there while the command's own stdout/stderr stream through fd 1/2.
  const args = ["fence", "-m", "--fence-log-file", "/dev/fd/3"];
  if (settingsPath) {
    args.push("--settings", settingsPath);
  }
  if (template) {
    args.push("--template", template);
  }
  args.push("--", ...command);
  return args;
}

// Stream fence's log fd to process.stderr (tee) while delivering each line
// to onLine for caller-side bookkeeping. Returns the readline interface.
export function teeMonitorLog(stream, onLine) {
  const rl = createInterface({ input: stream });
  rl.on("line", (line) => {
    process.stderr.write(line + "\n");
    onLine(line);
  });
  return rl;
}

export function execute({ command, cwd, profile, settingsPath, template }) {
  return new Promise((resolve) => {
    const args = buildFenceArgs({ command, settingsPath, template });
    const startedAt = new Date().toISOString();

    const child = spawn(args[0], args.slice(1), {
      cwd,
      stdio: ["inherit", "inherit", "inherit", "pipe"],
    });

    const monitorLines = [];
    teeMonitorLog(child.stdio[3], (line) => monitorLines.push(line));

    let spawnError = null;
    child.on("error", (err) => {
      spawnError = err;
    });

    child.on("close", (code, signal) => {
      const finishedAt = new Date().toISOString();
      if (spawnError) {
        resolve({
          command,
          cwd: cwd ?? process.cwd(),
          exitCode: 127,
          profile: profile ?? "default",
          startedAt,
          finishedAt,
          monitorLog: "",
          spawnError: spawnError.message,
        });
        return;
      }

      const exitCode = code != null ? code : signal ? 128 : 1;
      const execResult = {
        command,
        cwd: cwd ?? process.cwd(),
        exitCode,
        profile: profile ?? "default",
        startedAt,
        finishedAt,
        monitorLog: monitorLines.join("\n"),
        stdout: "",
      };
      if (signal) execResult.signal = signal;
      resolve(execResult);
    });
  });
}
