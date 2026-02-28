# x402 本地演示项目简介

## 项目目标
本项目用于在本地完整演示 x402 付费访问流程，并可通过 VSCode MCP 工具触发端到端调用。  
实现原则是“优先复用官方项目，最小改造完成本地闭环”。

## 目录与模块职责

| 模块 | 路径 | 职责 |
|---|---|---|
| MCP 配置 | `.vscode/mcp.json` | 在 VSCode 中注册 `x402-official-bridge`，把 MCP 调用转发到本地 x402 MCP Bridge。 |
| 本地控制脚本 | `x402-workspace/components/blockchain/stop-all.mjs` | 一键停止常用端口（8545/4021/4022）上的本地演示进程。 |
| 本地测试代币 | `x402-workspace/components/blockchain/src/LocalUSDC.sol` | 提供 EIP-3009 能力的本地 USDC 合约，用于支付签名与结算演示。 |
| MCP Bridge | `x402-workspace/components/mcp-bridge/index.ts` | 暴露工具 `get-data-from-resource-server`，处理 402、签名支付、重试请求、解析 payment response。 |
| 资源服务 | `x402-workspace/components/resource-server/index.ts` | 对 `/weather` 开启 x402 paywall，收到签名后执行业务并返回 200。 |
| Facilitator | `x402-workspace/components/facilitator/index.ts` | 负责 `verify/settle`，提交链上交易并返回结算结果；已支持自定义 `eip155:<chainId>` 链。 |

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
每一步均可通过 HTTP 响应与链上交易回执验证，保证演示闭环可复现、可核对。

## Besu 适配现状
- 已完成：Facilitator 支持自定义 `eip155:<chainId>` 网络，可用于 Besu 私链。  
- 待按需调整：当前是 anvil 路径；若切 Besu，建议新增专用 `start-besu` 脚本或改为读取外部链配置。
