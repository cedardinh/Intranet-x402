#!/usr/bin/env bash
set -euo pipefail

RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"
DEPLOYER_PK="${DEPLOYER_PK:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
BUYER_ADDRESS="${BUYER_ADDRESS:-0xB38e8bDb625E74c1A1CCF90e0110D10e1f407386}"
INITIAL_MINT="${INITIAL_MINT:-1000000000}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

CREATE_OUTPUT="$(forge create src/LocalUSDC.sol:LocalUSDC --rpc-url "$RPC_URL" --private-key "$DEPLOYER_PK" --broadcast)"
TOKEN_ADDRESS="$(echo "$CREATE_OUTPUT" | sed -n 's/^Deployed to: //p' | tail -n1 | tr -d '\r')"

if [[ -z "$TOKEN_ADDRESS" ]]; then
  echo "Failed to parse deployed token address"
  echo "$CREATE_OUTPUT"
  exit 1
fi

cast send "$TOKEN_ADDRESS" "mint(address,uint256)" "$BUYER_ADDRESS" "$INITIAL_MINT" \
  --rpc-url "$RPC_URL" --private-key "$DEPLOYER_PK" >/dev/null

echo "$TOKEN_ADDRESS"
