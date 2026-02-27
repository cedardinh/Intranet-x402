# Local x402 One-Click Scripts

## Start (Windows/macOS)

```bash
node local/scripts/start-all.mjs
```

First-time setup (install dependencies automatically):

```bash
node local/scripts/start-all.mjs --bootstrap
```

## Stop

```bash
node local/scripts/stop-all.mjs
```

## What `start-all` does

1. Checks required commands: `pnpm`, `anvil`, `forge`, `cast`.
2. Reads MCP buyer private key from `.vscode/mcp.json` (`x402-official-bridge`).
3. Starts local chain (`anvil`, `127.0.0.1:8545`).
4. Deploys `LocalUSDC` and mints tokens to MCP buyer wallet.
5. Starts facilitator (`127.0.0.1:4022`).
6. Starts resource server (`127.0.0.1:4021`).
7. Performs health checks (including `/weather` returning `402`).
