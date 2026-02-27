import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import axios from "axios";
import { config } from "dotenv";
import { decodePaymentResponseHeader, x402Client, x402HTTPClient } from "@x402/axios";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import crypto from "node:crypto";

config();

/**
 * MCP Bridge（客户端侧）的核心职责：
 * 1. 请求受保护资源（首次请求预期返回 402）。
 * 2. 解析 PAYMENT-REQUIRED，得到可接受的支付要求。
 * 3. 使用 buyer 私钥构造 PAYMENT-SIGNATURE。
 * 4. 携带签名重试请求，触发服务端 verify/settle。
 * 5. 解析 PAYMENT-RESPONSE，向上层返回“业务数据 + 结算元数据”。
 *
 * Core responsibilities of the MCP Bridge (client side):
 * 1. Request protected resources (the first attempt is expected to return 402).
 * 2. Parse PAYMENT-REQUIRED and obtain acceptable payment requirements.
 * 3. Build PAYMENT-SIGNATURE with the buyer private key.
 * 4. Retry with the signature to trigger server-side verify/settle.
 * 5. Parse PAYMENT-RESPONSE and return business data plus settlement metadata.
 */
const privateKey = process.env.PRIVATE_KEY as `0x${string}`;
const baseURL = process.env.RESOURCE_SERVER_URL as string; // 资源服务地址（例如 http://127.0.0.1:4021）/ Resource server URL.
const endpointPath = process.env.ENDPOINT_PATH as string; // 资源路径（例如 /weather）/ Protected endpoint path.

if (!privateKey || !baseURL || !endpointPath) {
  throw new Error("Missing environment variables");
}

const signer = privateKeyToAccount(privateKey);
// paymentClient 负责“协议语义”：根据 scheme/network 构造支付载荷。
// paymentClient handles protocol semantics: builds payment payloads by scheme/network.
const paymentClient = new x402Client().register("eip155:*", new ExactEvmScheme(signer));
// httpClient 负责“HTTP 线协议”：编码/解码 x402 相关头字段。
// httpClient handles HTTP wire-level behavior: encodes/decodes x402 headers.
const httpClient = new x402HTTPClient(paymentClient);
const client = axios.create({ baseURL });

// 给最终用户展示的人类可读链名映射。
// Human-readable chain names for end-user display.
const EVM_CHAIN_NAME_BY_ID: Record<string, string> = {
  "1": "Ethereum Mainnet",
  "8453": "Base Mainnet",
  "84532": "Local Anvil",
  "11155111": "Ethereum Sepolia",
};

/**
 * 统一 MCP 工具输出结构。
 * - 如果业务返回是对象：直接展开并附加 x402 字段
 * - 如果业务返回不是对象：放入 data 字段并附加 x402
 * - 目标是让上层消费者始终拿到稳定结构。
 *
 * Unified MCP tool output shape.
 * - If business data is an object: spread it and append `x402`
 * - If business data is not an object: place it into `data` and append `x402`
 * - Goal: keep a stable response contract for upper layers.
 *
 * @param data 业务响应体
 * @param settlement 结算信息（traceId 必有，txHash/network 可选）
 * @returns 上层可稳定消费的对象结构
 */
function buildToolResponsePayload(
  data: unknown,
  settlement: { traceId: string; txHash?: string; network?: string },
): Record<string, unknown> {
  // 将结算元数据规范为稳定字段，方便 UI/LLM 直接展示。
  // Normalize settlement metadata into a stable shape for UI/LLM rendering.
  const networkInfo = normalizeNetwork(settlement.network);
  const x402 = {
    traceId: settlement.traceId,
    txHash: settlement.txHash ?? null,
    network: networkInfo.network,
    chainId: networkInfo.chainId,
  };

  if (data && typeof data === "object" && !Array.isArray(data)) {
    return {
      ...(data as Record<string, unknown>),
      x402,
    };
  }

  return {
    data,
    x402,
  };
}

/**
 * 将协议网络标识（CAIP-2）转换为“展示友好”的网络信息。
 * 例：eip155:84532 -> { network: "Local Anvil", chainId: 84532 }
 *
 * Converts protocol network IDs (CAIP-2) into display-friendly network info.
 * Example: eip155:84532 -> { network: "Local Anvil", chainId: 84532 }
 *
 * @param network 协议返回网络字符串
 * @returns 人类可读 network 和可计算 chainId
 */
function normalizeNetwork(network?: string): { network: string | null; chainId: number | null } {
  // 把 CAIP-2 网络标识转成上层展示契约。
  // Convert CAIP-2 network ID into the presentation-level contract.
  if (typeof network !== "string" || network.length === 0) {
    return { network: null, chainId: null };
  }

  const evmMatch = /^eip155:(\d+)$/.exec(network.trim());
  if (!evmMatch) {
    return { network, chainId: null };
  }

  const chainIdText = evmMatch[1];
  const parsed = Number.parseInt(chainIdText, 10);
  const chainName = EVM_CHAIN_NAME_BY_ID[chainIdText] ?? `EVM Chain ${chainIdText}`;
  return {
    network: chainName,
    chainId: Number.isFinite(parsed) ? parsed : null,
  };
}

// 创建 MCP Server（stdio 传输），供 IDE/Agent 调用工具。
// Create MCP Server (stdio transport) for IDE/Agent tool calls.
const server = new McpServer({
  name: "x402 MCP Client Demo",
  version: "1.0.0",
});

/**
 * MCP 工具主处理函数：
 * 1. 先请求资源，预期收到 402。
 * 2. 解析支付要求并本地签名。
 * 3. 带签名重试请求，驱动服务端 verify/settle。
 * 4. 解码 PAYMENT-RESPONSE 并返回统一结构。
 *
 * Main MCP tool handler:
 * 1. Request the resource first and expect 402.
 * 2. Parse payment requirements and sign locally.
 * 3. Retry with signature to drive server verify/settle.
 * 4. Decode PAYMENT-RESPONSE and return a unified payload.
 *
 * @param args 用户输入参数（仅支持可选 city）
 * @returns MCP 标准 content 数组，内部文本为 JSON 字符串（含业务数据 + x402 元数据）
 */
const getDataFromResourceServerHandler = async (args: { city?: string }) => {
    // 一个 traceId 对应一次端到端支付请求；所有组件都用它串联日志。
    // A single traceId represents one end-to-end paid request across all components.
    const traceId = crypto.randomUUID();
    const city = typeof args?.city === "string" && args.city.length > 0 ? args.city : undefined;
    const queryPathBase = city
      ? `${endpointPath}${endpointPath.includes("?") ? "&" : "?"}city=${encodeURIComponent(city)}`
      : endpointPath;
    const queryPath = `${queryPathBase}${queryPathBase.includes("?") ? "&" : "?"}traceId=${encodeURIComponent(traceId)}`;
    const traceHeaders = { "x-trace-id": traceId };

    try {
      // 步骤 A：首次请求（不带支付签名），预期命中 paywall 并返回 402。
      // Step A: first request without payment signature; expect paywall 402.
      const initialResponse = await client.get(queryPath, {
        headers: traceHeaders,
        validateStatus: () => true,
      });

      if (initialResponse.status !== 402) {
        // 非 402 回退分支：若服务端直接放行，也保持统一输出结构。
        // Non-402 fallback: if server allows direct access, keep response contract consistent.
        if (initialResponse.status >= 200 && initialResponse.status < 300) {
          const payload = buildToolResponsePayload(initialResponse.data, { traceId });
          return {
            content: [{ type: "text", text: JSON.stringify(payload) }],
          };
        }

        throw new Error(`Unexpected status code from resource server: ${initialResponse.status}`);
      }

      // 步骤 B：解析 PAYMENT-REQUIRED（头 + body），拿到结构化支付要求。
      // Step B: decode PAYMENT-REQUIRED from headers/body into structured requirements.
      const paymentRequired = httpClient.getPaymentRequiredResponse(
        name => {
          const key = name.toLowerCase();
          const value = initialResponse.headers[key];
          return typeof value === "string" ? value : undefined;
        },
        initialResponse.data,
      );

      // 步骤 C：选择 accepted requirement，并使用 buyer 私钥生成支付载荷。
      // accepted 表示“本次请求承诺支付的具体网络/资产/金额/收款方”。
      // Step C: choose accepted requirement and create signed payment payload.
      // `accepted` is the concrete promise: network/asset/amount/payee for this request.
      const paymentPayload = await paymentClient.createPaymentPayload(paymentRequired);

      const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

      // 步骤 D：携带 PAYMENT-SIGNATURE 重试；服务端据此触发 verify + settle。
      // Step D: retry with PAYMENT-SIGNATURE; server then runs verify + settle.
      const paidResponse = await client.get(queryPath, {
        headers: {
          ...traceHeaders,
          ...paymentHeaders,
        },
        validateStatus: () => true,
      });

      if (paidResponse.status !== 200) {
        // 非 200 说明 verify 或 settle 流程失败，直接抛错上抛给调用方。
        // Non-200 means verify/settle failed; throw directly to caller.
        throw new Error(`Payment retry failed with status ${paidResponse.status}`);
      }

      // 步骤 E：解析 PAYMENT-RESPONSE，提取 txHash/network 回传上层。
      // Step E: decode PAYMENT-RESPONSE and return txHash/network to upper layers.
      const encodedPaymentResponse =
        (paidResponse.headers["payment-response"] as string | undefined) ||
        (paidResponse.headers["x-payment-response"] as string | undefined);
      let settlementTxHash: string | undefined;
      let settlementNetwork: string | undefined;
      if (encodedPaymentResponse) {
        const settlement = decodePaymentResponseHeader(encodedPaymentResponse);
        settlementTxHash = settlement.transaction;
        settlementNetwork = settlement.network;
      }

      const payload = buildToolResponsePayload(paidResponse.data, {
        traceId,
        txHash: settlementTxHash,
        network: settlementNetwork,
      });

      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
      };
    } catch (error) {
      // 保留原始异常语义，直接上抛给调用方。
      // Preserve original error semantics and rethrow to caller.
      throw error;
    }
};

// 注册核心工具：触发一次完整的付费资源访问链路。
// Register the core tool that executes a full paid-access request flow.
server.tool(
  "get-data-from-resource-server",
  "Get data from the resource server (in this example, the weather)",
  {
    city: z.string().optional().describe("Optional city name, e.g. Guangzhou"),
  },
  getDataFromResourceServerHandler,
);

const transport = new StdioServerTransport();
// Connect MCP server over stdio transport.
await server.connect(transport);
