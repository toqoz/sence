import { CREDENTIAL_PATTERNS } from "./patterns.js";

// Path may contain spaces; capture everything up to the final " (process:pid)"
const FILE_DENIAL_RE =
  /^\[fence:logstream\]\s+\S+\s+✗\s+([\w-]+)\s+(.+)\s+\((\w+):(\d+)\)$/;

const NETWORK_DENIAL_RE =
  /^\[fence:http\]\s+\S+\s+✗\s+CONNECT\s+403\s+(\S+)\s+https?:\/\/\S+:(\d+)/;

export function isDenialLine(line) {
  return line.includes("✗");
}

function classifyFileSeverity(path) {
  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.test(path)) return "high";
  }
  if (path.startsWith("/etc/") || path.startsWith("/var/")) return "medium";
  if (path.startsWith("/tmp") || path.startsWith("/private/tmp")) return "medium";
  return "low";
}

function detectSuspiciousActions(deniedFiles) {
  const actions = [];
  for (const file of deniedFiles) {
    for (const pattern of CREDENTIAL_PATTERNS) {
      if (pattern.test(file.path)) {
        actions.push({
          kind: "credential_access",
          target: file.path,
          severity: "high",
        });
        break;
      }
    }
  }
  return actions;
}

function inferFailureCauses(exitCode, deniedNetwork, deniedFiles) {
  const causes = [];
  if (exitCode !== 0 && deniedNetwork.length > 0) {
    const hosts = deniedNetwork.map((d) => d.host).join(", ");
    causes.push(
      `network egress to ${hosts} was denied — command may require external access`,
    );
  }
  if (exitCode !== 0 && deniedFiles.some((f) => f.severity === "high")) {
    causes.push(
      "access to sensitive credential paths was denied",
    );
  }
  return causes;
}

export function audit({ exitCode, monitorLog }) {
  const lines = monitorLog.split("\n").filter((l) => l.length > 0);

  // Group repeated denials so the LLM sees one entry per (action, path) or
  // (host, port) with a count and the set of processes that hit it. The tail
  // pane still prints every raw line — this aggregation is for the audit
  // summary only. `count` is recurrence, not severity; keep `severity` out of
  // the key so it doesn't fragment equivalent denials.
  const fileMap = new Map();
  const netMap = new Map();

  for (const line of lines) {
    const fileMatch = line.match(FILE_DENIAL_RE);
    if (fileMatch) {
      const [, action, path, process] = fileMatch;
      const key = `${action}\0${path}`;
      const existing = fileMap.get(key);
      if (existing) {
        existing.count += 1;
        existing._processes.add(process);
      } else {
        fileMap.set(key, {
          path,
          action,
          processes: null,
          severity: classifyFileSeverity(path),
          count: 1,
          _processes: new Set([process]),
        });
      }
      continue;
    }

    const netMatch = line.match(NETWORK_DENIAL_RE);
    if (netMatch) {
      const [, host, port] = netMatch;
      const portNum = parseInt(port, 10);
      const key = `${host}\0${portNum}`;
      const existing = netMap.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        netMap.set(key, {
          host,
          port: portNum,
          severity: "medium",
          count: 1,
        });
      }
    }
  }

  const deniedFiles = [];
  for (const entry of fileMap.values()) {
    entry.processes = [...entry._processes].sort();
    delete entry._processes;
    deniedFiles.push(entry);
  }
  const deniedNetwork = [...netMap.values()];

  const suspiciousActions = detectSuspiciousActions(deniedFiles);
  const likelyFailureCauses = inferFailureCauses(exitCode, deniedNetwork, deniedFiles);

  return {
    status: exitCode === 0 ? "success" : "failed",
    deniedFiles,
    deniedNetwork,
    suspiciousActions,
    likelyFailureCauses,
  };
}
