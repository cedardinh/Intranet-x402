# x402 本地闭环代码导读（按交互流程图）

## 1. 这份导读解决什么问题
这份文档按一次真实调用的时序拆解代码，目标是让你能回答三个问题：
- 每一步是谁发起的，请求里带了什么，返回了什么。
- 关键代码在哪，为什么这么写。
- 本项目相对官方示例改了哪些点，这些改造的作用是什么。

## 2. 推荐阅读顺序（先主干，后细节）
1. `local/scripts/start-all.mjs`：先看系统如何拉起。
2. `official-x402/examples/typescript/legacy/mcp/index.ts`：看客户端如何走 402 -> 签名 -> 重试。
3. `official-x402/examples/typescript/servers/express/index.ts`：看服务端 paywall 与业务执行边界。
4. `official-x402/e2e/facilitators/typescript/index.ts`：看 verify/settle 与链上交互。
5. `local/monitor/server.mjs` + `local/monitor/public/app.js`：看事件如何串成流程图。

## 2.1 阅读优先级清单（你要的“重点/非终点/可跳过”）

### A. 重点看（必须看，直接决定闭环是否成立）
1. `local/scripts/start-all.mjs`
- 为什么：决定角色地址、代币部署、服务依赖顺序、环境变量注入。
- 你至少要看：`main()`、`assertDistinctRoleAddresses()`、resource server 启动 env（`EVM_ADDRESS`）。

2. `official-x402/examples/typescript/legacy/mcp/index.ts`
- 为什么：这是“客户端支付行为”的核心，完整实现 402 -> 签名 -> 重试 -> 解码支付结果。
- 你至少要看：tool handler、`getPaymentRequiredResponse()`、`createPaymentPayload()`、`encodePaymentSignatureHeader()`、`decodePaymentResponseHeader()`。

3. `official-x402/examples/typescript/servers/express/index.ts`
- 为什么：定义付费接口规则（price/network/payTo）以及业务逻辑执行时机。
- 你至少要看：`paymentMiddleware(...)` 配置块和 `/weather` handler。

4. `official-x402/e2e/facilitators/typescript/index.ts`
- 为什么：verify/settle 真正落地在这里，链上交易 txHash 就从这里产出。
- 你至少要看：`getEvmChain()`、`/verify`、`/settle`、`onBeforeSettle` hook。

### B. 不是终点（中间层，不能只看这里就下结论）
1. `local/monitor/public/app.js`
- 作用：只做可视化映射，不是协议执行点。
- 结论：它显示“发生了什么”，但不决定“为什么成功/失败”。

2. `local/monitor/server.mjs`
- 作用：事件收集与转发，不参与支付判定。
- 结论：看到它收到事件，不代表链上一定成功；链上结果要回到 facilitator + receipt 验证。

3. `read.md` / `Operation Steps.md`
- 作用：说明和操作手册。
- 结论：它们是“描述层”，最终以代码和运行结果为准。

### C. 可暂时不看（当前目标是吃透闭环逻辑时）
1. `official-x402/typescript/packages/**`
- 原因：这是 SDK 内部实现，体量大，先不下钻。

2. `official-x402/typescript/site/**`
- 原因：官网站点代码，与本地支付闭环主路径无关。

3. `official-x402/examples/typescript/**` 里除 `legacy/mcp` 与 `servers/express` 外的大部分示例
- 原因：会分散注意力，不影响你理解当前这条闭环链路。

## 3. 一次完整请求的底层交互细节

### 3.1 启动阶段（准备链路）
- 启动脚本入口：`local/scripts/start-all.mjs:325` (`main`)。
- 角色地址加载：
  - buyer 来自 `.vscode/mcp.json` 或 `X402_MCP_PRIVATE_KEY`（`start-all.mjs:268`）。
  - facilitator 地址由 `facilitatorPrivateKey` 推导。
  - payee 地址由 `payeePrivateKey` 推导。
- 地址冲突保护：`start-all.mjs:298` (`assertDistinctRoleAddresses`)。
- 本地代币部署与铸币：
  - `forge create` 部署 LocalUSDC。
  - `cast send mint` 给 buyer 铸初始余额。
- 服务启动顺序：anvil -> monitor -> facilitator -> resource server。

### 3.2 运行阶段（单次调用）
下面按 monitor 流程图中的事件顺序解释。

1. `x402.http.initial_request.sent`
- 发起方：MCP Bridge
- 代码：`mcp/index.ts:154`
- 行为：先请求 `/weather?...&traceId=...`，预期拿到 402。

2. `x402.http.402_received`
- 发起方：Resource Server -> MCP Bridge
- 代码：`mcp/index.ts:193`
- 行为：收到 `402 Payment Required`。

3. `x402.payment_required.decoded`
- 发起方：MCP Bridge
- 代码：`mcp/index.ts:208`
- 行为：解析 `PAYMENT-REQUIRED`，得到 `accepts[]`（network/asset/amount/payTo）。

4. `x402.payment_payload.created`
- 发起方：MCP Bridge
- 代码：`mcp/index.ts`（`paymentClient.createPaymentPayload(...)`）
- 行为：buyer 私钥签出支付载荷。

5. `x402.http.retry_with_payment_signature.sent`
- 发起方：MCP Bridge
- 代码：`mcp/index.ts:235`
- 行为：带 `PAYMENT-SIGNATURE` 头重试请求。

6. `x402.server.payment_signature.received`
- 发起方：Resource Server
- 代码：`express/index.ts:73`
- 行为：检测到支付签名头，记录监控事件。

7. `x402.facilitator.verify.requested`
- 发起方：Resource Server -> Facilitator
- 代码：`facilitator/index.ts:366` (`POST /verify`)
- 行为：校验签名和 payment requirements 一致性。

8. `x402.facilitator.verify.succeeded`
- 发起方：Facilitator
- 代码：`facilitator/index.ts:366` 返回
- 行为：verify 通过后进入业务执行。

9. `x402.resource.execution.succeeded`
- 发起方：Resource Server
- 代码：`express/index.ts:111`
- 行为：执行业务逻辑并准备响应内容（天气数据）。

10. `x402.facilitator.settle.requested`
- 发起方：Resource Server -> Facilitator
- 代码：`facilitator/index.ts:431` (`POST /settle`)
- 行为：请求 facilitator 提交链上结算交易。

11. `x402.facilitator.settle.succeeded`
- 发起方：Facilitator
- 代码：`facilitator/index.ts:431` 返回
- 行为：拿到 `txHash`，表示链上结算成功。

12. `x402.http.200_with_payment_response.received`
- 发起方：Resource Server -> MCP Bridge
- 行为：200 响应中携带 `PAYMENT-RESPONSE`。

13. `x402.payment_response.decoded`
- 发起方：MCP Bridge
- 代码：`mcp/index.ts:270`
- 行为：解码 `PAYMENT-RESPONSE` 得到 `transaction/network`。

14. MCP 最终返回
- 代码：`mcp/index.ts:62` + `mcp/index.ts:294`
- 行为：把业务数据和 `x402{traceId,txHash,network,chainId}` 组装成统一输出。

## 4. 三个关键 HTTP 头（协议核心）
- `PAYMENT-REQUIRED`：402 时返回，描述“怎么付钱”。
- `PAYMENT-SIGNATURE`：客户端重试时提交，证明“我已授权这笔支付”。
- `PAYMENT-RESPONSE`：200 时返回，说明“这笔支付已结算”，包含 `txHash`。

## 5. 改造点清单（改了什么 / 为什么改 / 作用）

### 改造点 A：MCP 输出补充结算信息
- 位置：`official-x402/examples/typescript/legacy/mcp/index.ts:62`
- 改动：新增 `buildToolResponsePayload`，把 `traceId/txHash/network/chainId` 注入最终结果。
- 原因：原始示例只返回业务内容，不利于演示“支付真的发生且已上链”。
- 作用：上层展示和链上核验可以直接联动。

### 改造点 B：网络名称标准化显示
- 位置：`mcp/index.ts:36`
- 改动：`84532` 映射为 `Local Anvil`（而非 Base Sepolia）。
- 原因：当前链是本地 Anvil，避免误导。
- 作用：输出语义与实际运行环境一致。

### 改造点 C：Facilitator 支持自定义 EVM CAIP-2 网络
- 位置：`facilitator/index.ts:73`, `facilitator/index.ts:100`
- 改动：新增 `parseEvmChainId/createCustomEvmChain`，允许 `eip155:<chainId>` 动态建链配置。
- 原因：官方示例主要面向固定公网链，私链/本地链需要动态适配。
- 作用：同一套 facilitator 可跑在本地链、Besu 私链等自定义网络。

### 改造点 D：启动脚本加入角色拆分与防错
- 位置：`local/scripts/start-all.mjs:22`, `:298`, `:477`
- 改动：增加 `payeePrivateKey`，`EVM_ADDRESS` 使用 `payeeAddress`，并检查 buyer/facilitator/payee 不得相同。
- 原因：同地址会导致“看起来像自转账”，演示失真。
- 作用：链上 `Transfer` 能正确体现 buyer -> payee 资金流向。

### 改造点 E：全链路可观测性（trace 驱动）
- 位置：
  - MCP 发事件：`mcp/index.ts` 多处 `emitMonitorEvent`
  - Resource 发事件：`express/index.ts`
  - Facilitator 发事件：`facilitator/index.ts`
  - Monitor 收敛：`local/monitor/server.mjs:111`
- 原因：仅看日志很难还原跨进程时序。
- 作用：通过 `traceId` 把多进程行为拼成一条可视化链路。

## 6. 监控流程图是如何从事件驱动出来的
- 流程步骤定义：`local/monitor/public/app.js:1` (`FLOW_STEPS`)。
- 时序泳道定义：`app.js:28` (`SEQUENCE_ACTORS`)。
- 箭头映射：`app.js:36` (`SEQUENCE_MESSAGES`)。
- 监控后端写入路径：内存 + SSE + JSONL，见 `server.mjs:111`。
- 新开页面先下发 `snapshot`，见 `server.mjs:187`。

## 7. 核心数据怎么串起来
- `traceId`：从 MCP 生成，沿 header/query/resourceUrl 在各组件传播。
- `payTo`：由 resource server 的 `EVM_ADDRESS` 写入 `PAYMENT-REQUIRED`。
- `txHash`：由 facilitator 在 settle 成功后产出，回到 `PAYMENT-RESPONSE`，最后进入 MCP 输出。

## 8. 快速验证“底层逻辑确实跑通”
1. 先看 402：`curl -i 'http://127.0.0.1:4021/weather?city=Guangzhou'`
2. 触发 MCP 工具调用，拿到 `x402.txHash`。
3. 用 `cast receipt <txHash> --rpc-url http://127.0.0.1:8545` 看 `status=1`。
4. 在 monitor 页面用同一个 `traceId` 回看全流程。

## 9. 当前容易踩坑的点
- buyer 私钥如果和 facilitator 私钥相同，会破坏演示语义。
- `EVM_ADDRESS` 若配置成 facilitator 地址，会把“收款方”混同为执行方。
- 启动命令若使用相对路径，需保证 cwd 正确；否则优先用绝对路径。
