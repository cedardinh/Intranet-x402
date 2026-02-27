### Start a local blockchain node

```bash
anvil --host 127.0.0.1 --port 8545 --chain-id 84532
```

### Deploy USDC and mint tokens for buyers

```bash
export MCP_PRIVATE_KEY=0x7a9749e5ce0c270da4e89c5d0ec643909ba3cca7946447b4f6041f55342803ba
export BUYER_ADDRESS=$(cast wallet address --private-key $MCP_PRIVATE_KEY)
BUYER_ADDRESS=$BUYER_ADDRESS bash local/evm/deploy_local_usdc.sh | tee local/runtime-logs/local_usdc.address

```

### Start facilitator

```bash
PORT=4022 EVM_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 EVM_NETWORK=eip155:84532 EVM_RPC_URL=http://127.0.0.1:8545 pnpm --dir official-x402/e2e/facilitators/typescript start
```

### Start resource server

```bash
TOKEN=$(cat local/runtime-logs/local_usdc.address)
PAYEE_ADDR=$(cast wallet address --private-key 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d)
FACILITATOR_URL=http://127.0.0.1:4022 EVM_ADDRESS=$PAYEE_ADDR EVM_NETWORK=eip155:84532 EVM_PRICE_ASSET=$TOKEN EVM_PRICE_AMOUNT=1000 EVM_ASSET_NAME=USDC EVM_ASSET_VERSION=2 pnpm --dir official-x402/examples/typescript/servers/express dev
```
### Configure mcp.json

```json
{
  "servers": {
    "x402-official-bridge": {
      "type": "stdio",
      "command": "pnpm",
      "args": [
        "--silent",
        "-C",
        "/Users/dinglujie/Desktop/Intranet-x402/official-x402/examples/typescript/legacy/mcp",
        "dev"
      ],
      "env": {
        "PRIVATE_KEY": "0x7a9749e5ce0c270da4e89c5d0ec643909ba3cca7946447b4f6041f55342803ba",
        "RESOURCE_SERVER_URL": "http://127.0.0.1:4021",
        "ENDPOINT_PATH": "/weather"
      }
    }
  }
}
```



### Prompt
Can you check the weather in Guangzhou for me? Please use the get-data-from-resource-server tool with city set to Guangzhou.

After you get the result, don’t return raw JSON. Please present it in a clean, human-readable format with good visual structure.

Use this layout:
- City
- Weather
- Temperature (with unit)
- Payment status (Success/Failed)
- Transaction hash (txHash)
- Network
- Chain ID
- Trace ID

Formatting style:
- Add a short title
- Keep sections clear and easy to scan
- Align fields neatly
- End with one concise summary sentence confirming whether the paid request and data retrieval were completed successfully.


### On-chain verification of successful transaction

TX='0x34b460fcf7870c25fe37762a4013782b7c5c7e85ce6d739c24bd63bf7cd211b9'
RPC='http://127.0.0.1:8545'
USDC_DECIMALS=6
TRANSFER_TOPIC='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

R=$(mktemp)
cast receipt "$TX" --rpc-url "$RPC" --json > "$R"
TXJ=$(cast tx "$TX" --rpc-url "$RPC" --json)

BN=$(cast to-dec "$(jq -r '.blockNumber' "$R")")
LATEST=$(cast block-number --rpc-url "$RPC")
CONF=$((LATEST - BN + 1))

STATUS_DEC=$(cast to-dec "$(jq -r '.status' "$R")")
if [ "$STATUS_DEC" -eq 1 ]; then STATUS='Success'; else STATUS='Failed'; fi

TS_HEX=$(cast block "$BN" --rpc-url "$RPC" --json | jq -r '.timestamp')
TS=$(cast to-dec "$TS_HEX")
TIME_UTC=$(date -u -r "$TS" "+%Y-%m-%d %H:%M:%S UTC")

FROM=$(jq -r '.from' "$R")
TO=$(jq -r '.to' "$R")
NONCE=$(cast to-dec "$(echo "$TXJ" | jq -r '.nonce')")
TX_INDEX=$(cast to-dec "$(jq -r '.transactionIndex' "$R")")
GAS_USED=$(cast to-dec "$(jq -r '.gasUsed' "$R")")
GAS_PRICE_WEI=$(cast to-dec "$(jq -r '.effectiveGasPrice' "$R")")
FEE_WEI=$((GAS_USED * GAS_PRICE_WEI))
FEE_ETH=$(cast from-wei "$FEE_WEI" ether)
CUM_GAS=$(cast to-dec "$(jq -r '.cumulativeGasUsed' "$R")")

LOG_COUNT=$(jq '.logs | length' "$R")

TFROM_TOPIC=$(jq -r --arg t "$TRANSFER_TOPIC" '.logs[] | select(.topics[0]==$t) | .topics[1]' "$R" | head -n1)
TTO_TOPIC=$(jq -r --arg t "$TRANSFER_TOPIC" '.logs[] | select(.topics[0]==$t) | .topics[2]' "$R" | head -n1)
TVAL_HEX=$(jq -r --arg t "$TRANSFER_TOPIC" '.logs[] | select(.topics[0]==$t) | .data' "$R" | head -n1)

echo "================ Explorer-Style Verification ================"
printf "%-22s %s\n" "Transaction Hash:" "$TX"
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

if [ -n "$TVAL_HEX" ] && [ "$TVAL_HEX" != "null" ]; then
  TFROM="0x$(echo "$TFROM_TOPIC" | sed -E 's/^0x0{24}//')"
  TTO="0x$(echo "$TTO_TOPIC" | sed -E 's/^0x0{24}//')"
  TVAL_ATOMIC=$(cast to-dec "$TVAL_HEX")
  TVAL_HUMAN=$(awk -v v="$TVAL_ATOMIC" -v d="$USDC_DECIMALS" 'BEGIN { printf "%.*f", d, v/(10^d) }')
  echo "---------------- Token Transfer (ERC20) ----------------"
  printf "%-22s %s\n" "Token:" "Local USDC"
  printf "%-22s %s\n" "From:" "$TFROM"
  printf "%-22s %s\n" "To:" "$TTO"
  printf "%-22s %s\n" "Amount (atomic):" "$TVAL_ATOMIC"
  printf "%-22s %s USDC\n" "Amount (human):" "$TVAL_HUMAN"
fi

rm -f "$R"

















node local/scripts/stop-all.mjs
