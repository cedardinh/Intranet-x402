#!/usr/bin/env node

import { execSync } from "node:child_process";

const PORTS = [8545, 4021, 4022];

function listPidsByPort(port) {
  try {
    const output = execSync(`lsof -t -iTCP:${port} -sTCP:LISTEN`, {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    if (!output) return [];
    return [...new Set(output.split(/\s+/).filter(Boolean).map(Number))];
  } catch {
    return [];
  }
}

const allPids = [...new Set(PORTS.flatMap(listPidsByPort))];

if (allPids.length === 0) {
  console.log("No matching processes found on ports 8545, 4021, 4022.");
  process.exit(0);
}

for (const pid of allPids) {
  try {
    process.kill(pid, "SIGTERM");
    console.log(`Stopped process PID ${pid}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to stop PID ${pid}: ${message}`);
  }
}
