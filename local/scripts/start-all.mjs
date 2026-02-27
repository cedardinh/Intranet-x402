#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const localDir = path.resolve(__dirname, "..");
const repoDir = path.resolve(localDir, "..");
const runtimeDir = path.join(localDir, "runtime-logs");
const statePath = path.join(runtimeDir, "services.state.json");
const mcpConfigPath = path.join(repoDir, ".vscode", "mcp.json");
const isWindows = process.platform === "win32";

const config = {
  host: "127.0.0.1",
  chainId: "84532",
  ports: {
    anvil: 8545,
    monitor: 4399,
    facilitator: 4022,
    express: 4021,
  },
  buyerMcpServer: "x402-official-bridge",
  facilitatorPrivateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  payeePrivateKey: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  initialMintAmount: "2000000000",
};

const args = new Set(process.argv.slice(2));
const bootstrap = args.has("--bootstrap");
const noClean = args.has("--no-clean");

function log(message) {
  console.log(`[start-all] ${message}`);
}

function fail(message) {
  console.error(`[start-all] ${message}`);
  process.exit(1);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function runCapture(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env || {}) },
    encoding: "utf8",
    shell: isWindows,
  });

  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    const stdout = (result.stdout || "").trim();
    const detail = stderr || stdout || `exit code ${String(result.status)}`;
    throw new Error(`${command} ${commandArgs.join(" ")} failed: ${detail}`);
  }

  return (result.stdout || "").trim();
}

function runInherit(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env || {}) },
    stdio: "inherit",
    shell: isWindows,
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} failed with exit code ${String(result.status)}`);
  }
}

function ensureCommand(command, versionArgs = ["--version"]) {
  const result = spawnSync(command, versionArgs, {
    stdio: "ignore",
    shell: isWindows,
  });
  if (result.status !== 0) {
    throw new Error(`Required command not found: ${command}`);
  }
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

function killPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;

  if (isWindows) {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", shell: true });
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
    return;
  } catch {
    // Fallback to direct pid if process group is unavailable.
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Ignore.
  }
}

async function waitUntilPidDead(pid, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isPidAlive(pid)) return true;
    await sleep(200);
  }
  return !isPidAlive(pid);
}

function readJsonFile(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function parsePidFile(filePath) {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, "utf8").trim();
  const pid = Number.parseInt(content, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

async function cleanupOldProcesses() {
  const serviceNames = ["anvil", "monitor", "facilitator", "express"];
  const state = readJsonFile(statePath);
  const pids = new Map();

  if (state?.services && typeof state.services === "object") {
    for (const [name, service] of Object.entries(state.services)) {
      if (service && typeof service === "object" && Number.isInteger(service.pid)) {
        pids.set(name, service.pid);
      }
    }
  }

  for (const name of serviceNames) {
    const pidPath = path.join(runtimeDir, `${name}.pid`);
    const pid = parsePidFile(pidPath);
    if (pid) {
      pids.set(name, pid);
    }
  }

  if (pids.size === 0) return;

  log("Found existing service pids, cleaning up old processes...");
  for (const [name, pid] of pids.entries()) {
    if (!isPidAlive(pid)) continue;
    log(`Stopping ${name} (pid=${pid})`);
    killPid(pid);
    const terminated = await waitUntilPidDead(pid);
    if (!terminated && !isWindows) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Ignore.
        }
      }
      await waitUntilPidDead(pid, 2000);
    }
  }
}

function checkPortOpen(host, port, timeoutMs = 400) {
  return new Promise(resolve => {
    let settled = false;
    const socket = net.createConnection({ host, port });

    const done = open => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };

    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.setTimeout(timeoutMs);
  });
}

async function waitForPort(host, port, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const open = await checkPortOpen(host, port);
    if (open) return true;
    await sleep(250);
  }
  return false;
}

async function waitForHttpStatus(url, accept, timeoutMs = 40000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (accept(response.status)) {
        clearTimeout(timer);
        return response.status;
      }
    } catch {
      // Retry until timeout.
    } finally {
      clearTimeout(timer);
    }
    await sleep(350);
  }
  return null;
}

function startDetachedService(name, command, commandArgs, options = {}) {
  const logPath = path.join(runtimeDir, `${name}.log`);
  const logFd = openSync(logPath, "w");
  const child = spawn(command, commandArgs, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env || {}) },
    stdio: ["ignore", logFd, logFd],
    detached: true,
    shell: isWindows,
  });
  closeSync(logFd);

  if (!child.pid) {
    throw new Error(`Failed to spawn ${name}`);
  }

  child.unref();
  writeFileSync(path.join(runtimeDir, `${name}.pid`), `${child.pid}\n`, "utf8");
  return { pid: child.pid, logPath };
}

function loadBuyerPrivateKey() {
  const fromEnv = process.env.X402_MCP_PRIVATE_KEY;
  if (typeof fromEnv === "string" && fromEnv.startsWith("0x")) {
    return fromEnv;
  }

  const mcpConfig = readJsonFile(mcpConfigPath);
  const server = mcpConfig?.servers?.[config.buyerMcpServer];
  const pk = server?.env?.PRIVATE_KEY;
  if (typeof pk !== "string" || !pk.startsWith("0x")) {
    throw new Error(
      `Cannot read PRIVATE_KEY from ${mcpConfigPath}. ` +
        `Set X402_MCP_PRIVATE_KEY to continue.`,
    );
  }
  return pk;
}

function parseDeployedAddress(output) {
  const match = output.match(/Deployed to:\s*(0x[a-fA-F0-9]{40})/);
  if (!match) return null;
  return match[1];
}

function normalizeAddress(address) {
  return typeof address === "string" ? address.trim().toLowerCase() : "";
}

function assertDistinctRoleAddresses(addresses) {
  const seen = new Map();
  for (const [role, address] of Object.entries(addresses)) {
    const normalized = normalizeAddress(address);
    if (!normalized) continue;
    const existingRole = seen.get(normalized);
    if (existingRole) {
      throw new Error(
        `Address conflict: ${role} and ${existingRole} resolve to ${address}. ` +
          `Use different keys for buyer/facilitator/payee.`,
      );
    }
    seen.set(normalized, role);
  }
}

async function ensurePortsFree() {
  for (const [name, port] of Object.entries(config.ports)) {
    const open = await checkPortOpen(config.host, port);
    if (open) {
      throw new Error(`Port ${port} (${name}) is already in use. Use stop-all first.`);
    }
  }
}

async function main() {
  mkdirSync(runtimeDir, { recursive: true });

  log("Checking prerequisites...");
  ensureCommand("node", ["-v"]);
  ensureCommand("pnpm", ["-v"]);
  ensureCommand("anvil", ["--version"]);
  ensureCommand("forge", ["--version"]);
  ensureCommand("cast", ["--version"]);

  if (!noClean) {
    await cleanupOldProcesses();
    await sleep(500);
  }

  await ensurePortsFree();

  if (bootstrap) {
    log("Running dependency bootstrap for first-time setup...");
    runInherit("pnpm", ["install"], { cwd: path.join(repoDir, "official-x402", "e2e") });
    runInherit("pnpm", ["install"], { cwd: path.join(repoDir, "official-x402", "examples", "typescript") });
  }

  const buyerPrivateKey = loadBuyerPrivateKey();
  const buyerAddress = runCapture("cast", ["wallet", "address", "--private-key", buyerPrivateKey]);
  const facilitatorAddress = runCapture("cast", [
    "wallet",
    "address",
    "--private-key",
    config.facilitatorPrivateKey,
  ]);
  const payeeAddress = runCapture("cast", [
    "wallet",
    "address",
    "--private-key",
    config.payeePrivateKey,
  ]);

  assertDistinctRoleAddresses({
    buyerAddress,
    facilitatorAddress,
    payeeAddress,
  });

  log("Starting anvil...");
  const anvil = startDetachedService("anvil", "anvil", [
    "--host",
    config.host,
    "--port",
    String(config.ports.anvil),
    "--chain-id",
    config.chainId,
  ]);
  const anvilReady = await waitForPort(config.host, config.ports.anvil, 15000);
  if (!anvilReady) {
    throw new Error(`anvil did not start. See ${anvil.logPath}`);
  }

  log("Deploying LocalUSDC and minting to MCP buyer wallet...");
  const evmDir = path.join(localDir, "evm");
  const deployOutput = runCapture(
    "forge",
    [
      "create",
      "src/LocalUSDC.sol:LocalUSDC",
      "--rpc-url",
      `http://${config.host}:${config.ports.anvil}`,
      "--private-key",
      config.facilitatorPrivateKey,
      "--broadcast",
    ],
    { cwd: evmDir },
  );
  const tokenAddress = parseDeployedAddress(deployOutput);
  if (!tokenAddress) {
    throw new Error(`Failed to parse LocalUSDC address from forge output:\n${deployOutput}`);
  }
  runCapture(
    "cast",
    [
      "send",
      tokenAddress,
      "mint(address,uint256)",
      buyerAddress,
      config.initialMintAmount,
      "--rpc-url",
      `http://${config.host}:${config.ports.anvil}`,
      "--private-key",
      config.facilitatorPrivateKey,
    ],
    { cwd: evmDir },
  );

  writeFileSync(path.join(runtimeDir, "local_usdc.address"), tokenAddress, "utf8");
  writeFileSync(path.join(runtimeDir, "mcp_client.address"), buyerAddress, "utf8");
  writeFileSync(path.join(runtimeDir, "facilitator.address"), facilitatorAddress, "utf8");
  writeFileSync(path.join(runtimeDir, "payee.address"), payeeAddress, "utf8");

  log("Starting monitor service...");
  const monitor = startDetachedService(
    "monitor",
    "node",
    [path.join(localDir, "monitor", "server.mjs")],
  );
  const monitorReady = await waitForHttpStatus(
    `http://${config.host}:${config.ports.monitor}`,
    status => status >= 200 && status < 500,
    12000,
  );
  if (monitorReady === null) {
    throw new Error(`monitor did not start. See ${monitor.logPath}`);
  }

  log("Starting facilitator...");
  const facilitator = startDetachedService(
    "facilitator",
    "pnpm",
    ["--dir", path.join(repoDir, "official-x402", "e2e", "facilitators", "typescript"), "start"],
    {
      env: {
        PORT: String(config.ports.facilitator),
        EVM_PRIVATE_KEY: config.facilitatorPrivateKey,
        EVM_NETWORK: `eip155:${config.chainId}`,
        EVM_RPC_URL: `http://${config.host}:${config.ports.anvil}`,
        MONITOR_URL: `http://${config.host}:${config.ports.monitor}`,
      },
    },
  );
  const facilitatorReady = await waitForHttpStatus(
    `http://${config.host}:${config.ports.facilitator}/supported`,
    status => status === 200,
    45000,
  );
  if (facilitatorReady === null) {
    throw new Error(`facilitator did not start. See ${facilitator.logPath}`);
  }

  log("Starting resource server (express)...");
  const expressService = startDetachedService(
    "express",
    "pnpm",
    [
      "--dir",
      path.join(repoDir, "official-x402", "examples", "typescript", "servers", "express"),
      "dev",
    ],
    {
      env: {
        FACILITATOR_URL: `http://${config.host}:${config.ports.facilitator}`,
        EVM_ADDRESS: payeeAddress,
        EVM_NETWORK: `eip155:${config.chainId}`,
        EVM_PRICE_ASSET: tokenAddress,
        EVM_PRICE_AMOUNT: "1000",
        EVM_ASSET_NAME: "USDC",
        EVM_ASSET_VERSION: "2",
        MONITOR_URL: `http://${config.host}:${config.ports.monitor}`,
      },
    },
  );
  const expressReady = await waitForHttpStatus(
    `http://${config.host}:${config.ports.express}/weather?city=Guangzhou`,
    status => status === 402,
    45000,
  );
  if (expressReady === null) {
    throw new Error(`express server did not become ready (expecting 402). See ${expressService.logPath}`);
  }

  const state = {
    createdAt: new Date().toISOString(),
    config,
    addresses: {
      tokenAddress,
      buyerAddress,
      facilitatorAddress,
      payeeAddress,
    },
    services: {
      anvil,
      monitor,
      facilitator,
      express: expressService,
    },
  };
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");

  log("All services are up.");
  console.log("");
  console.log(`Monitor:      http://${config.host}:${config.ports.monitor}`);
  console.log(`Facilitator:  http://${config.host}:${config.ports.facilitator}`);
  console.log(`Resource API: http://${config.host}:${config.ports.express}/weather?city=Guangzhou`);
  console.log(`Local USDC:   ${tokenAddress}`);
  console.log(`MCP Buyer:    ${buyerAddress}`);
  console.log(`Payee:        ${payeeAddress}`);
  console.log(`Facilitator:  ${facilitatorAddress}`);
  console.log("");
  console.log(`Stop command: node ${path.join("local", "scripts", "stop-all.mjs")}`);
}

main().catch(error => {
  fail(error instanceof Error ? error.message : String(error));
});
