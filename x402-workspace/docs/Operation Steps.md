### Start a local blockchain node

```bash
anvil --host 127.0.0.1 --port 8545 --chain-id 84532
```

### Deploy USDC and mint tokens for buyers

```bash
export MCP_PRIVATE_KEY=0x7a9749e5ce0c270da4e89c5d0ec643909ba3cca7946447b4f6041f55342803ba
export BUYER_ADDRESS=$(cast wallet address --private-key $MCP_PRIVATE_KEY)
BUYER_ADDRESS=$BUYER_ADDRESS bash x402-workspace/components/blockchain/deploy_local_usdc.sh | tee x402-workspace/runtime/blockchain/local_usdc.address

```

### Start facilitator

```bash
PORT=4022 EVM_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 EVM_NETWORK=eip155:84532 EVM_RPC_URL=http://127.0.0.1:8545 pnpm --dir x402-workspace/components/facilitator start
```

### Start resource server

```bash
TOKEN=$(cat x402-workspace/runtime/blockchain/local_usdc.address)
PAYEE_ADDR=$(cast wallet address --private-key 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d)
[ -n "$TOKEN" ] && [ -n "$PAYEE_ADDR" ] || { echo "TOKEN or PAYEE_ADDR is empty"; exit 1; }
curl -sf http://127.0.0.1:4022/supported >/dev/null || { echo "Facilitator is not ready on :4022"; exit 1; }
FACILITATOR_URL=http://127.0.0.1:4022 EVM_ADDRESS=$PAYEE_ADDR EVM_NETWORK=eip155:84532 EVM_PRICE_ASSET=$TOKEN EVM_PRICE_AMOUNT=1000 EVM_ASSET_NAME=USDC EVM_ASSET_VERSION=2 pnpm --dir x402-workspace/components/resource-server dev
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
        "/Users/dinglujie/Desktop/Intranet-x402/x402-workspace/components/mcp-bridge",
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

Use this exact output structure:

```text
☀️ Weather Data for Guangzhou

City:              Guangzhou
Weather:           sunny
Temperature:       70 °F

Payment status:    Success
Transaction hash:  0x...
Network:           Local Anvil
Chain ID:          84532
Trace ID:          ...

✅ Request and payment processed successfully, and the weather data was retrieved.
```


### On-chain verification of successful transaction

```bash
# Option A: pass txHash from MCP response explicitly
TX='<CURRENT_X402_TX_HASH>'
bash x402-workspace/components/blockchain/verify_tx.sh "$TX"

# Option B: auto-pick latest transaction hash on current local chain
bash x402-workspace/components/blockchain/verify_tx.sh
```

















node x402-workspace/components/blockchain/stop-all.mjs
