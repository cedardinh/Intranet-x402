#!/usr/bin/env bash
set -euo pipefail

# Ensure local RPC requests bypass system proxies.
unset http_proxy HTTP_PROXY https_proxy HTTPS_PROXY ALL_PROXY all_proxy
export NO_PROXY="${NO_PROXY:-127.0.0.1,localhost}"
export no_proxy="${no_proxy:-127.0.0.1,localhost}"

TX_INPUT="${1:-${TX:-}}"
RPC="${2:-${RPC:-http://127.0.0.1:8545}}"
USDC_DECIMALS="${USDC_DECIMALS:-6}"
TRANSFER_TOPIC="${TRANSFER_TOPIC:-0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef}"
MAX_LOOKBACK_BLOCKS="${MAX_LOOKBACK_BLOCKS:-500}"

resolve_latest_tx_hash() {
  local latest
  latest="$(cast block-number --rpc-url "$RPC" 2>/dev/null || true)"
  if [[ -z "$latest" ]]; then
    return 1
  fi

  local min=0
  if (( latest > MAX_LOOKBACK_BLOCKS )); then
    min=$((latest - MAX_LOOKBACK_BLOCKS))
  fi

  local bn tx_hash
  for ((bn=latest; bn>=min; bn--)); do
    tx_hash="$(cast block "$bn" --rpc-url "$RPC" --json 2>/dev/null | jq -r '.transactions[-1] // empty')"
    if [[ "$tx_hash" =~ ^0x[0-9a-fA-F]{64}$ ]]; then
      echo "$tx_hash"
      return 0
    fi
  done

  return 1
}

if [[ -z "$TX_INPUT" || "$TX_INPUT" == "<REPLACE_WITH_CURRENT_X402_TX_HASH>" ]]; then
  TX_INPUT="$(resolve_latest_tx_hash || true)"
  if [[ -z "$TX_INPUT" ]]; then
    echo "No transaction found in the latest ${MAX_LOOKBACK_BLOCKS} blocks on $RPC"
    echo "Usage: bash x402-workspace/components/blockchain/verify_tx.sh <txHash> [rpcUrl]"
    exit 1
  fi
  echo "Auto-selected latest transaction hash: $TX_INPUT"
fi

if [[ ! "$TX_INPUT" =~ ^0x[0-9a-fA-F]{64}$ ]]; then
  echo "Invalid tx hash format: $TX_INPUT"
  exit 1
fi

R="$(mktemp)"
cleanup() {
  rm -f "$R"
}
trap cleanup EXIT

if ! cast receipt "$TX_INPUT" --async --rpc-url "$RPC" --json > "$R"; then
  echo "Failed to fetch receipt for $TX_INPUT on $RPC"
  exit 1
fi

if ! TXJ="$(cast tx "$TX_INPUT" --rpc-url "$RPC" --json)"; then
  echo "Failed to fetch tx details for $TX_INPUT on $RPC"
  exit 1
fi

BN="$(cast to-dec "$(jq -r '.blockNumber' "$R")")"
LATEST="$(cast block-number --rpc-url "$RPC")"
CONF=$((LATEST - BN + 1))

STATUS_DEC="$(cast to-dec "$(jq -r '.status' "$R")")"
if [[ "$STATUS_DEC" -eq 1 ]]; then STATUS='Success'; else STATUS='Failed'; fi

TS_HEX="$(cast block "$BN" --rpc-url "$RPC" --json | jq -r '.timestamp')"
TS="$(cast to-dec "$TS_HEX")"
TIME_UTC="$(date -u -r "$TS" "+%Y-%m-%d %H:%M:%S UTC")"

FROM="$(jq -r '.from' "$R")"
TO="$(jq -r '.to' "$R")"
NONCE="$(cast to-dec "$(echo "$TXJ" | jq -r '.nonce')")"
TX_INDEX="$(cast to-dec "$(jq -r '.transactionIndex' "$R")")"
GAS_USED="$(cast to-dec "$(jq -r '.gasUsed' "$R")")"
GAS_PRICE_WEI="$(cast to-dec "$(jq -r '.effectiveGasPrice' "$R")")"
FEE_WEI=$((GAS_USED * GAS_PRICE_WEI))
FEE_ETH="$(cast from-wei "$FEE_WEI" ether)"
CUM_GAS="$(cast to-dec "$(jq -r '.cumulativeGasUsed' "$R")")"

LOG_COUNT="$(jq '.logs | length' "$R")"

TFROM_TOPIC="$(jq -r --arg t "$TRANSFER_TOPIC" '.logs[] | select(.topics[0]==$t) | .topics[1]' "$R" | head -n1)"
TTO_TOPIC="$(jq -r --arg t "$TRANSFER_TOPIC" '.logs[] | select(.topics[0]==$t) | .topics[2]' "$R" | head -n1)"
TVAL_HEX="$(jq -r --arg t "$TRANSFER_TOPIC" '.logs[] | select(.topics[0]==$t) | .data' "$R" | head -n1)"

echo "================ Explorer-Style Verification ================"
printf "%-22s %s\n" "Transaction Hash:" "$TX_INPUT"
printf "%-22s %s\n" "Status:" "$STATUS"
printf "%-22s %s\n" "Block Number:" "$BN"
printf "%-22s %s\n" "Confirmations:" "$CONF"
printf "%-22s %s\n" "Timestamp:" "$TIME_UTC"
printf "%-22s %s\n" "From:" "$FROM"
printf "%-22s %s\n" "To (Contract):" "$TO"
printf "%-22s %s\n" "Nonce:" "$NONCE"
printf "%-22s %s\n" "Tx Index:" "$TX_INDEX"
printf "%-22s %s\n" "Gas Used:" "$GAS_USED"
printf "%-22s %s wei\n" "Effective Gas Price:" "$GAS_PRICE_WEI"
printf "%-22s %s ETH\n" "Tx Fee:" "$FEE_ETH"
printf "%-22s %s\n" "Cumulative Gas Used:" "$CUM_GAS"
printf "%-22s %s\n" "Logs Count:" "$LOG_COUNT"

if [[ -n "$TVAL_HEX" && "$TVAL_HEX" != "null" ]]; then
  TFROM="0x$(echo "$TFROM_TOPIC" | sed -E 's/^0x0{24}//')"
  TTO="0x$(echo "$TTO_TOPIC" | sed -E 's/^0x0{24}//')"
  TVAL_ATOMIC="$(cast to-dec "$TVAL_HEX")"
  TVAL_HUMAN="$(awk -v v="$TVAL_ATOMIC" -v d="$USDC_DECIMALS" 'BEGIN { printf "%.*f", d, v/(10^d) }')"
  echo "---------------- Token Transfer (ERC20) ----------------"
  printf "%-22s %s\n" "Token:" "Local USDC"
  printf "%-22s %s\n" "From:" "$TFROM"
  printf "%-22s %s\n" "To:" "$TTO"
  printf "%-22s %s\n" "Amount (atomic):" "$TVAL_ATOMIC"
  printf "%-22s %s USDC\n" "Amount (human):" "$TVAL_HUMAN"
fi
