# x402 本地闭环代码导读（无监控版）

## 1. 文档目标
这份导读用于快速理解一条完整的 x402 付费调用链路：
- 谁先发请求，谁返回 402。
- 客户端如何签名并重试。
- facilitator 如何 verify/settle 并产出链上交易。
- 最终如何回到业务数据与交易哈希。

## 2. 推荐阅读顺序
1. `x402-workspace/docs/Operation Steps.md`：看完整启动顺序与命令。
2. `x402-workspace/components/mcp-bridge/index.ts`：看客户端 402 -> 签名 -> 重试逻辑。
3. `x402-workspace/components/resource-server/index.ts`：看资源服务的 paywall 与业务处理边界。
4. `x402-workspace/components/facilitator/index.ts`：看 verify/settle 与链上执行。
5. `Operation Steps.md`：看演示命令与链上核验脚本。

## 2.1 阅读优先级（重点/可后看/可跳过）
### A. 重点看（直接决定闭环是否成立）
1. `x402-workspace/docs/Operation Steps.md`
- 关键点：角色地址拆分（buyer/facilitator/payee）、本地代币部署、服务启动顺序。

2. `x402-workspace/components/mcp-bridge/index.ts`
- 关键点：`getPaymentRequiredResponse`、`createPaymentPayload`、`encodePaymentSignatureHeader`、`decodePaymentResponseHeader`。

3. `x402-workspace/components/resource-server/index.ts`
- 关键点：`paymentMiddleware(...)` 的 `accepts` 配置，以及 `/weather` 的业务执行时机。

4. `x402-workspace/components/facilitator/index.ts`
- 关键点：`/verify`、`/settle`、`onBeforeSettle` 时序约束、`getEvmChain` 网络适配。

### B. 可后看（增强理解）
1. `read.md`
- 作用：模块职责总览。

2. `x402-workspace/README.md`
- 作用：目录与组件结构总览。

### C. 可跳过（当前闭环主线不依赖）
1. 其他历史遗留目录中与本地演示无关部分

## 3. 端到端交互流程（底层细节）

### 3.1 启动阶段
1. 启动 `anvil` 本地链（84532）。
2. 部署 `LocalUSDC` 合约并给 buyer 铸币。
3. 启动 facilitator（`/verify`、`/settle`）。
4. 启动 resource server（`/weather`，由 x402 paywall 保护）。

### 3.2 调用阶段（一次真实请求）
1. MCP Bridge 首次请求 `/weather`。
2. Resource Server 返回 `402 Payment Required`（含 `PAYMENT-REQUIRED`）。
3. MCP Bridge 解析支付要求并生成 `PAYMENT-SIGNATURE`。
4. MCP Bridge 携带签名重试请求。
5. Resource Server 调 facilitator `/verify` 验证签名与要求一致性。
6. verify 通过后，Resource Server 调 facilitator `/settle` 执行链上结算。
7. facilitator 返回结算结果（含 `transaction`/`txHash`）。
8. Resource Server 返回 `200 + PAYMENT-RESPONSE + 业务数据`。
9. MCP Bridge 解码 `PAYMENT-RESPONSE` 并输出统一结构：业务结果 + `x402` 元数据。

## 4. 协议关键点
- `PAYMENT-REQUIRED`：服务器告诉客户端“怎么付”。
- `PAYMENT-SIGNATURE`：客户端证明“我授权这笔支付”。
- `PAYMENT-RESPONSE`：服务端确认“这笔支付已结算”。

## 5. 关键改造点（相对官方示例）
1. 三角色地址拆分（buyer/facilitator/payee）
- 作用：避免 from/to 同地址导致演示失真。

2. facilitator 支持自定义 `eip155:<chainId>`
- 作用：可跑本地链与私链，不仅限固定公网链。

3. MCP 输出补充 `x402.traceId/txHash/network/chainId`
- 作用：便于演示和链上核验联动。

4. 网络展示修正为本地链语义（例如 `Local Anvil`）
- 作用：避免把本地链误标为公网测试网。

## 6. 如何验证“闭环真的完成”
1. 启动：
```bash
按 x402-workspace/docs/Operation\ Steps.md 顺序手工启动各组件
```

2. 验证 paywall 已就绪（应返回 402）：
```bash
curl -i 'http://127.0.0.1:4021/weather?city=Guangzhou'
```

3. 触发 MCP 工具调用，拿到 `x402.txHash`。

4. 链上验证交易：
```bash
cast receipt <txHash> --rpc-url http://127.0.0.1:8545
```

## 7. 常见坑位
1. buyer 与 payee 地址配置相同，会让资金流向展示不清。
2. `EVM_ADDRESS` 配错会导致收款方异常。
3. 手工启动服务时路径错误会导致 `pnpm --dir ...` 失败，建议使用绝对路径。
