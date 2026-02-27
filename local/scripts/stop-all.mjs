#!/usr/bin/env node

import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const localDir = path.resolve(__dirname, "..");
const runtimeDir = path.join(localDir, "runtime-logs");
const statePath = path.join(runtimeDir, "services.state.json");
const isWindows = process.platform === "win32";

const serviceOrder = ["express", "facilitator", "monitor", "anvil"];

function log(message) {
  console.log(`[stop-all] ${message}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readJson(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readPid(filePath) {
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, "utf8").trim();
  const pid = Number.parseInt(raw, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function terminatePid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (isWindows) {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", shell: true });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
    return;
  } catch {
    // Fallback when process group does not exist.
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Ignore already-dead pid.
  }
}

async function waitForExit(pid, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isPidAlive(pid)) return true;
    await sleep(200);
  }
  return !isPidAlive(pid);
}

async function stopService(name, pid) {
  if (!pid) return;
  if (!isPidAlive(pid)) {
    log(`${name}: already stopped (pid=${pid})`);
    return;
  }

  log(`Stopping ${name} (pid=${pid})`);
  terminatePid(pid);
  const stopped = await waitForExit(pid);

  if (!stopped && !isWindows) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Ignore.
      }
    }
    await waitForExit(pid, 2000);
  }
}

async function main() {
  const state = readJson(statePath);
  const statePids = new Map();
  if (state?.services && typeof state.services === "object") {
    for (const [name, service] of Object.entries(state.services)) {
      if (service && typeof service === "object" && Number.isInteger(service.pid)) {
        statePids.set(name, service.pid);
      }
    }
  }

  for (const name of serviceOrder) {
    const pidPath = path.join(runtimeDir, `${name}.pid`);
    const pid = statePids.get(name) || readPid(pidPath);
    await stopService(name, pid);
  }

  for (const name of serviceOrder) {
    const pidPath = path.join(runtimeDir, `${name}.pid`);
    if (existsSync(pidPath)) {
      rmSync(pidPath, { force: true });
    }
  }

  if (existsSync(statePath)) {
    rmSync(statePath, { force: true });
  }

  log("Done.");
}

main().catch(error => {
  console.error(`[stop-all] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
