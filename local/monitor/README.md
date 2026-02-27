# x402 Monitor Service

## Start

```bash
cd /Users/dinglujie/Desktop/Intranet-x402/local/monitor
node server.mjs
```

Open: <http://127.0.0.1:4399>

## Post Event

```bash
curl -X POST http://127.0.0.1:4399/events \
  -H "content-type: application/json" \
  -d '{"traceId":"demo-1","step":"mcp.tool_call.started","status":"started","component":"mcp"}'
```
