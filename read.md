# x402 本地演示项目简介

## 项目目标
本项目用于在本地完整演示 x402 付费访问流程，并可通过 VSCode MCP 工具触发端到端调用。  
实现原则是“优先复用官方项目，最小改造完成本地闭环”。

## 目录与模块职责

| 模块 | 路径 | 职责 |
|---|---|---|
| MCP 配置 | `.vscode/mcp.json` | 在 VSCode 中注册 `x402-official-bridge`，把 MCP 调用转发到本地 x402 MCP Bridge。 |
| 一键启动脚本 | `local/scripts/start-all.mjs` / `stop-all.mjs` | 启停本地链路：anvil、monitor、facilitator、resource server；并自动部署/铸造测试代币。 |
| 本地测试代币 | `local/evm/src/LocalUSDC.sol` | 提供 EIP-3009 能力的本地 USDC 合约，用于支付签名与结算演示。 |
| MCP Bridge（官方复用） | `official-x402/examples/typescript/legacy/mcp/index.ts` | 暴露工具 `get-data-from-resource-server`，处理 402、签名支付、重试请求、解析 payment response。 |
| 资源服务（官方复用） | `official-x402/examples/typescript/servers/express/index.ts` | 对 `/weather` 开启 x402 paywall，收到签名后执行业务并返回 200。 |
| Facilitator（官方复用+适配） | `official-x402/e2e/facilitators/typescript/index.ts` | 负责 `verify/settle`，提交链上交易并返回结算结果；已支持自定义 `eip155:<chainId>` 链。 |
| 监控后端 | `local/monitor/server.mjs` | 接收/存储事件（`/events`）、SSE 推送（`/events/stream`）。 |
| 监控前端 | `local/monitor/public/index.html` / `app.js` | 实时流程图可视化、节点状态染色、节点详情查看、历史请求回放。 |

## 运行拓扑（当前代码）

1. VSCode Chat 触发 MCP 工具。  
2. MCP Bridge 向 Resource Server 发起首次请求。  
3. Resource Server 返回 `402 Payment Required`。  
4. MCP Bridge 解析支付要求并生成 `PAYMENT-SIGNATURE`。  
5. MCP Bridge 带签名重试请求。  
6. Resource Server 调 Facilitator `/verify`。  
7. 验证通过后，Resource Server 执行业务。  
8. Resource Server 调 Facilitator `/settle`。  
9. Facilitator 向链上提交交易并确认。  
10. Resource Server 返回 `200 + PAYMENT-RESPONSE + content`。  
11. MCP Bridge 解码结算信息并返回给 MCP 客户端。  
12. Monitor 全程记录事件并实时展示流程状态。

## 返回数据约定（已改造）

当前 MCP 工具返回除了业务数据外，还包含 x402 结算信息：

```json
{
  "report": {
    "city": "广州",
    "weather": "sunny",
    "temperature": 70
  },
  "x402": {
    "traceId": "...",
    "txHash": "0x...",
    "network": "Local Anvil",
    "chainId": 84532
  }
}
```

说明：
- `txHash`：结算交易哈希。
- `network`：人类可读链名（不再暴露 `eip155:...`）。
- `chainId`：数值链 ID，便于程序侧使用。

## 角色地址约定（关键改造）
- `buyer`（MCP 私钥）负责生成 `PAYMENT-SIGNATURE`。
- `facilitator` 负责链上 `verify/settle` 执行。
- `payee` 作为 `payTo` 收款地址。
- 三者必须不同地址，否则链上转账会出现 `from=to`，演示语义失真。

## 与 x402 流程的一致性
项目严格遵循 x402 的核心事务顺序：  
`Initial Request -> 402 -> Payment Payload -> Retry With Signature -> Verify -> Business Work -> Settle -> 200 Response`。  
监控事件命名与页面流程节点已按该顺序映射，能够直观看到“未执行 / 执行中 / 成功 / 失败”的状态迁移。

## Besu 适配现状
- 已完成：Facilitator 支持自定义 `eip155:<chainId>` 网络，可用于 Besu 私链。  
- 待按需调整：`local/scripts/start-all.mjs` 当前仍是 anvil 路径；若切 Besu，建议新增专用 `start-besu` 脚本或改为读取外部链配置。
