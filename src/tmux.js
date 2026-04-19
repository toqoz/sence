import { spawnSync } from "node:child_process";

export function isInsideTmux() {
  return !!process.env.TMUX;
}

export function currentPane() {
  if (!isInsideTmux()) return null;
  const result = spawnSync("tmux", ["display-message", "-p", "#{pane_id}"], {
    encoding: "utf-8",
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function sendEscape(pane) {
  if (!pane) return false;
  const result = spawnSync("tmux", ["send-keys", "-t", pane, "Escape"]);
  return result.status === 0;
}

export function capturePaneContent(pane, { lines = 300 } = {}) {
  if (!pane) return "";
  const result = spawnSync(
    "tmux",
    ["capture-pane", "-t", pane, "-p", "-J", "-S", `-${lines}`],
    { encoding: "utf-8" },
  );
  return result.status === 0 ? result.stdout : "";
}

export function displayPopup({ width = "80%", height = "60%", command }) {
  if (!isInsideTmux()) return false;
  const result = spawnSync(
    "tmux",
    ["display-popup", "-w", width, "-h", height, "-E", command],
    { stdio: "inherit" },
  );
  return result.status === 0;
}

export function prefillInput(pane, text) {
  if (!pane) return false;
  // send-keys without "Enter" — text appears in the input line but is not executed
  const result = spawnSync("tmux", ["send-keys", "-t", pane, "-l", text]);
  return result.status === 0;
}

export function supportsPopup() {
  if (!isInsideTmux()) return false;
  const result = spawnSync("tmux", ["-V"], { encoding: "utf-8" });
  if (result.status !== 0) return false;
  const match = result.stdout.match(/(\d+)\.(\d+)/);
  if (!match) return false;
  const major = parseInt(match[1], 10);
  const minor = parseInt(match[2], 10);
  return major > 3 || (major === 3 && minor >= 2);
}
