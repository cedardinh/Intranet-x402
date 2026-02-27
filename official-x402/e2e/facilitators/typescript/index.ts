/**
 * TypeScript Facilitator（本地演示版）
 *
 * 核心职责：
 * 1. 暴露 /verify 与 /settle HTTP 接口。
 * 2. 基于 x402 SDK 执行支付验签与链上结算。
 * 3. 通过生命周期 Hook 约束 verify -> settle 的顺序。
 *
 * Core responsibilities:
 * 1. Expose HTTP APIs for /verify and /settle.
 * 2. Execute payment verification and on-chain settlement via x402 SDK.
 * 3. Enforce verify -> settle ordering with lifecycle hooks.
 */

import { Account, Ed25519PrivateKey, PrivateKey, PrivateKeyVariants } from "@aptos-labs/ts-sdk";
import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { toFacilitatorAptosSigner } from "@x402/aptos";
import { ExactAptosScheme } from "@x402/aptos/exact/facilitator";
import { x402Facilitator } from "@x402/core/facilitator";
import {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { ExactEvmSchemeV1 } from "@x402/evm/exact/v1/facilitator";
import { NETWORKS as EVM_V1_NETWORKS } from "@x402/evm/v1";
import { BAZAAR, extractDiscoveryInfo } from "@x402/extensions/bazaar";
import {
  EIP2612_GAS_SPONSORING,
  ERC20_APPROVAL_GAS_SPONSORING,
  type Erc20ApprovalGasSponsoringFacilitatorExtension,
} from "@x402/extensions";
import { toFacilitatorSvmSigner } from "@x402/svm";
import { ExactSvmScheme } from "@x402/svm/exact/facilitator";
import { ExactSvmSchemeV1 } from "@x402/svm/exact/v1/facilitator";
import { NETWORKS as SVM_V1_NETWORKS } from "@x402/svm/v1";
import crypto from "crypto";
import dotenv from "dotenv";
import express from "express";
import { createWalletClient, defineChain, http, publicActions, Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, base } from "viem/chains";
import { BazaarCatalog } from "./bazaar.js";

dotenv.config();

// ---------------------------
// 运行时配置（环境变量）
// ---------------------------
// EVM_NETWORK 同时决定：协议注册网络 + viem 链客户端配置。
// Runtime configuration (environment variables).
// EVM_NETWORK controls both protocol registration and viem chain selection.
const PORT = process.env.PORT || "4022";
const EVM_NETWORK = process.env.EVM_NETWORK || "eip155:84532";
const SVM_NETWORK = process.env.SVM_NETWORK || "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const APTOS_NETWORK = process.env.APTOS_NETWORK || "aptos:2";
const EVM_RPC_URL = process.env.EVM_RPC_URL;
const SVM_RPC_URL = process.env.SVM_RPC_URL;
const APTOS_RPC_URL = process.env.APTOS_RPC_URL;
const EVM_CHAIN_NAME = process.env.EVM_CHAIN_NAME;
const EVM_NATIVE_CURRENCY_NAME = process.env.EVM_NATIVE_CURRENCY_NAME || "Ether";
const EVM_NATIVE_CURRENCY_SYMBOL = process.env.EVM_NATIVE_CURRENCY_SYMBOL || "ETH";

/**
 * 解析 CAIP-2 EVM 网络字符串。
 * Parses a CAIP-2 EVM network string.
 *
 * @param network 例如 "eip155:84532"
 * @returns chainId；解析失败返回 null
 */
function parseEvmChainId(network: string): number | null {
  // 解析 CAIP-2 样式网络 id，例如 "eip155:84532" -> 84532。
  // Parse CAIP-2 network ID, e.g. "eip155:84532" -> 84532.
  const matched = /^eip155:(\d+)$/.exec(network);
  if (!matched) {
    return null;
  }
  const id = Number.parseInt(matched[1], 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * 为自定义 EVM 网络构造 viem Chain 对象。
 * 该函数用于本地链/私链场景，不依赖 viem 内置公共网络定义。
 * Builds a viem Chain object for custom EVM networks.
 * Used for local/private chains without relying on built-in public chain presets.
 *
 * @param network CAIP-2 网络标识
 * @throws 当 network 非法或缺少 EVM_RPC_URL 时抛错
 */
function createCustomEvmChain(network: string): Chain {
  const chainId = parseEvmChainId(network);
  if (!chainId) {
    throw new Error(`Invalid EVM network format: ${network}. Expected eip155:<chainId>`);
  }
  if (!EVM_RPC_URL) {
    throw new Error(`EVM_RPC_URL is required for custom EVM network ${network}`);
  }

  return defineChain({
    id: chainId,
    // 本地/私链场景下链名可配置，避免固定公网命名造成误导。
    // Allow configurable names for local/private chains to avoid public-chain confusion.
    name: EVM_CHAIN_NAME || `EVM Chain ${chainId}`,
    network: `eip155-${chainId}`,
    nativeCurrency: {
      name: EVM_NATIVE_CURRENCY_NAME,
      symbol: EVM_NATIVE_CURRENCY_SYMBOL,
      decimals: 18,
    },
    rpcUrls: {
      // default/public 都使用同一 RPC，确保私链行为一致可控。
      // Use the same RPC for both default/public to keep private-chain behavior deterministic.
      default: { http: [EVM_RPC_URL] },
      public: { http: [EVM_RPC_URL] },
    },
  });
}

/**
 * 根据网络标识返回 viem Chain。
 * - 已知公共链使用内置定义
 * - 其余网络走自定义链构造逻辑
 *
 * Resolves a viem Chain from network ID.
 * - Known public networks use built-in definitions.
 * - Other networks fall back to custom chain construction.
 */
function getEvmChain(network: string): Chain {
  switch (network) {
    case "eip155:8453":
      return base;
    case "eip155:84532":
      return baseSepolia;
    default:
      // 项目改造点：支持任意 eip155:<chainId>，而不仅是固定公网链。
      // Project customization: support any eip155:<chainId>, not only fixed public chains.
      return createCustomEvmChain(network);
  }
}

console.log(`🌐 EVM Network: ${EVM_NETWORK}`);
console.log(`🌐 SVM Network: ${SVM_NETWORK}`);
console.log(`🌐 Aptos Network: ${APTOS_NETWORK}`);
if (EVM_RPC_URL) console.log(`🌐 EVM RPC URL: ${EVM_RPC_URL}`);
if (SVM_RPC_URL) console.log(`🌐 SVM RPC URL: ${SVM_RPC_URL}`);
if (APTOS_RPC_URL) console.log(`🌐 Aptos RPC URL: ${APTOS_RPC_URL}`);

// 必需环境变量校验（facilitator 至少要有 EVM 侧签名能力）
// Required env validation (facilitator must have at least EVM signing capability).
if (!process.env.EVM_PRIVATE_KEY) {
  console.error("❌ EVM_PRIVATE_KEY environment variable is required");
  process.exit(1);
}


// ---------------------------
// 账户与签名器初始化
// ---------------------------
// 1) EVM 账户
// Account and signer initialization.
// 1) EVM account.
const evmAccount = privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`);
console.info(`EVM Facilitator account: ${evmAccount.address}`);

// 2) SVM 账户（可选）
// 2) Optional SVM account.
const svmPrivateKey = process.env.SVM_PRIVATE_KEY;
const svmAccount = svmPrivateKey
  ? await createKeyPairSignerFromBytes(base58.decode(svmPrivateKey))
  : undefined;
if (svmAccount) {
  console.info(`SVM Facilitator account: ${svmAccount.address}`);
} else {
  console.warn("⚠️  SVM_PRIVATE_KEY not provided, SVM scheme will not be registered");
}

// 3) Aptos 账户（可选，且会先按 AIP-80 规范化私钥）
// 3) Optional Aptos account (private key normalized to AIP-80 first).
let aptosAccount: Account | undefined;
if (process.env.APTOS_PRIVATE_KEY) {
  const formattedAptosKey = PrivateKey.formatPrivateKey(process.env.APTOS_PRIVATE_KEY as string, PrivateKeyVariants.Ed25519);
  const aptosPrivateKey = new Ed25519PrivateKey(formattedAptosKey);
  aptosAccount = Account.fromPrivateKey({ privateKey: aptosPrivateKey });
  console.info(`Aptos Facilitator account: ${aptosAccount.accountAddress.toStringLong()}`);
}

// 创建 viem 客户端（同时具备 wallet + public 能力）
// 该客户端承担 EVM 侧所有动作：读合约、验签、写合约、等待回执等。
// Create viem client (wallet + public actions).
// It covers all EVM operations: read, signature verify, write, and receipt waiting.
const evmChain = getEvmChain(EVM_NETWORK);
const viemClient = createWalletClient({
  account: evmAccount,
  chain: evmChain,
  transport: http(EVM_RPC_URL),
}).extend(publicActions);

// 将 viem 客户端能力适配为 x402 Facilitator 所需的 EVM signer 接口。
// Adapt viem capabilities into the EVM signer interface required by x402 Facilitator.
const evmSigner = toFacilitatorEvmSigner({
  address: evmAccount.address,
  readContract: (args: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }) =>
    viemClient.readContract({
      ...args,
      args: args.args || [],
    }),
  verifyTypedData: (args: {
    address: `0x${string}`;
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
    signature: `0x${string}`;
  }) => viemClient.verifyTypedData(args as any),
  writeContract: (args: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
  }) =>
    viemClient.writeContract({
      ...args,
      args: args.args || [],
    }),
  sendTransaction: (args: { to: `0x${string}`; data: `0x${string}` }) =>
    viemClient.sendTransaction(args),
  waitForTransactionReceipt: (args: { hash: `0x${string}` }) =>
    viemClient.waitForTransactionReceipt(args),
  getCode: (args: { address: `0x${string}` }) => viemClient.getCode(args),
});

// SVM signer：如果提供自定义 RPC，会用于默认网络访问。
// SVM signer: if custom RPC is set, use it as default network RPC.
const svmSigner = svmAccount
  ? toFacilitatorSvmSigner(svmAccount, SVM_RPC_URL ? { defaultRpcUrl: SVM_RPC_URL } : undefined)
  : undefined;

// Aptos signer：同样支持可选自定义 RPC。
// Aptos signer: also supports optional custom RPC.
const aptosSigner = aptosAccount ? toFacilitatorAptosSigner(aptosAccount, APTOS_RPC_URL ? { defaultRpcUrl: APTOS_RPC_URL } : undefined) : undefined;

// verify 阶段通过的 paymentPayload 哈希缓存：key=paymentHash, value=verify 时间戳（毫秒）。
// 用于 settle 阶段执行“必须先 verify”与“verify 结果有效期”校验。
// Cache for payload hashes that passed verify: key=paymentHash, value=verify timestamp(ms).
// Used by settle stage to enforce "verify first" and verification TTL.
const verifiedPayments = new Map<string, number>();
// bazaar 资源目录缓存：用于对外暴露 discovery/resources 查询接口。
// Bazaar resource catalog cache, exposed via discovery/resources endpoint.
const bazaarCatalog = new BazaarCatalog();

/**
 * 为一次 paymentPayload 生成稳定哈希，用于跨接口关联。
 * 典型用途：/verify 阶段记录，/settle 阶段校验是否已验证过。
 * Generates a stable hash for one paymentPayload to correlate across APIs.
 * Typical use: record in /verify and validate precondition in /settle.
 *
 * @param paymentPayload 客户端提交的支付载荷
 * @returns SHA-256 十六进制字符串（同一 payload 生成同一哈希）
 */
function createPaymentHash(paymentPayload: PaymentPayload): string {
  // 为 verify/settle 两阶段提供同一“支付身份”。
  // Provide the same "payment identity" for both verify and settle phases.
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(paymentPayload))
    .digest("hex");
}

const facilitator = new x402Facilitator();

// 注册协议方案：
// - v2: 使用 CAIP-2 network（如 eip155:84532）
// - v1: 兼容旧网络枚举
// Register payment schemes:
// - v2 uses CAIP-2 network strings (e.g. eip155:84532)
// - v1 keeps backward compatibility with legacy network enums
facilitator
  .register(EVM_NETWORK as Network, new ExactEvmScheme(evmSigner))
  .registerV1(EVM_V1_NETWORKS as Network[], new ExactEvmSchemeV1(evmSigner));
if (svmSigner) {
  facilitator
    .register(SVM_NETWORK as Network, new ExactSvmScheme(svmSigner))
    .registerV1(SVM_V1_NETWORKS as Network[], new ExactSvmSchemeV1(svmSigner));
}
if (aptosSigner) {
  facilitator.register(APTOS_NETWORK as Network, new ExactAptosScheme(aptosSigner));
}

/**
 * ERC20 授权 Gas 代付扩展配置：
 * - 复用现成扩展模板。
 * - 注入 sendRawTransaction 能力，供扩展在特定流程下发送原始交易。
 *
 * ERC20 approval gas-sponsoring extension setup:
 * - Reuse the existing extension template.
 * - Inject sendRawTransaction for extension paths that require raw tx broadcast.
 */
const erc20GasSponsorshipExtension: Erc20ApprovalGasSponsoringFacilitatorExtension = {
  ...ERC20_APPROVAL_GAS_SPONSORING,
  signer: {
    ...evmSigner,
    sendRawTransaction: (args: { serializedTransaction: `0x${string}` }) =>
      viemClient.sendRawTransaction(args),
  },
};

// 扩展与生命周期钩子：
// 1) onAfterVerify：记录“已验证支付”，供 settle 前置校验使用
// 2) onBeforeSettle：强制 verify -> settle 顺序 + 超时控制
// 3) onAfterSettle/onSettleFailure：统一清理状态，避免内存残留
// Extensions and lifecycle hooks:
// 1) onAfterVerify: record verified payments for settle precondition checks
// 2) onBeforeSettle: enforce verify -> settle ordering and timeout
// 3) onAfterSettle/onSettleFailure: unified cleanup to avoid stale in-memory state
facilitator.registerExtension(BAZAAR)
  .registerExtension(EIP2612_GAS_SPONSORING)
  .registerExtension(erc20GasSponsorshipExtension)
  /**
   * onAfterVerify 钩子：
   * - 仅当 verify 通过时记录支付哈希。
   * - 同步提取 discovery 信息并写入目录，供后续查询。
   *
   * onAfterVerify hook:
   * - Record payment hash only when verify succeeds.
   * - Extract discovery info and store it into catalog for later querying.
   */
  .onAfterVerify(async (context) => {
    // 钩子 1：记录 verify 成功的支付哈希，作为 settle 阶段准入条件。
    // Hook 1: track verified payment hashes as settle-stage admission precondition.
    if (context.result.isValid) {
      const paymentHash = createPaymentHash(context.paymentPayload);
      verifiedPayments.set(paymentHash, Date.now());

      // 钩子 2：提取并记录 bazaar discovery 信息（便于资源发现）。
      // Hook 2: extract and catalog bazaar discovery information.
      const discovered = extractDiscoveryInfo(context.paymentPayload, context.requirements);
      if (discovered) {
        bazaarCatalog.catalogResource(
          discovered.resourceUrl,
          discovered.method,
          discovered.x402Version,
          discovered.discoveryInfo,
          context.requirements,
        );
        console.log(`📦 Discovered resource: ${discovered.method} ${discovered.resourceUrl}`);
      }
    }
  })
  /**
   * onBeforeSettle 钩子：
   * - 强制“先 verify 再 settle”。
   * - verify 通过超过 5 分钟则拒绝，避免历史签名长期复用。
   *
   * onBeforeSettle hook:
   * - Enforce "verify before settle".
   * - Reject if verification is older than 5 minutes to avoid stale authorization reuse.
   */
  .onBeforeSettle(async (context) => {
    // 钩子 3：settle 前校验该支付是否已 verify，确保协议时序。
    // Hook 3: ensure payment has been verified before settlement.
    const paymentHash = createPaymentHash(context.paymentPayload);
    const verificationTimestamp = verifiedPayments.get(paymentHash);

    if (!verificationTimestamp) {
      return {
        abort: true,
        reason: "Payment must be verified before settlement",
      };
    }

    // verify 结果设置 5 分钟有效期，避免旧授权被长时间滥用。
    // Verification result has a 5-minute TTL to reduce replay/stale-authorization risk.
    const age = Date.now() - verificationTimestamp;
    if (age > 5 * 60 * 1000) {
      verifiedPayments.delete(paymentHash);
      return {
        abort: true,
        reason: "Payment verification expired (must settle within 5 minutes)",
      };
    }
  })
  /**
   * onAfterSettle 钩子：
   * - settle 完成后立刻清理 verify 缓存，避免重复消费。
   *
   * onAfterSettle hook:
   * - Clear verify cache immediately after settle to prevent repeated consumption.
   */
  .onAfterSettle(async (context) => {
    // 钩子 4：settle 成功后清理哈希记录，防止重复使用。
    // Hook 4: clear hash record after successful settle to prevent reuse.
    const paymentHash = createPaymentHash(context.paymentPayload);
    verifiedPayments.delete(paymentHash);

    if (context.result.success) {
      console.log(`✅ Settlement completed: ${context.result.transaction}`);
    }
  })
  /**
   * onSettleFailure 钩子：
   * - settle 抛错时同样清理缓存，保证状态一致性。
   *
   * onSettleFailure hook:
   * - Also clear cache when settle fails, keeping state consistent.
   */
  .onSettleFailure(async (context) => {
    // 钩子 5：settle 失败时同样清理，保持状态一致性。
    // Hook 5: perform the same cleanup on settle failure.
    const paymentHash = createPaymentHash(context.paymentPayload);
    verifiedPayments.delete(paymentHash);

    console.error(`❌ Settlement failed: ${context.error.message}`);
  });

// 初始化 HTTP 应用
// Initialize HTTP app.
const app = express();
// 解析 JSON 请求体，供 /verify 和 /settle 读取 paymentPayload/paymentRequirements。
// Parse JSON request bodies for /verify and /settle payment payload handling.
app.use(express.json());

/**
 * POST /verify
 * 功能：校验 paymentPayload 是否满足 paymentRequirements。
 * Purpose: validate whether paymentPayload satisfies paymentRequirements.
 *
 * 请求体：
 * - paymentPayload: 客户端签名后的支付载荷
 * - paymentRequirements: 服务端原始支付要求
 * Request body:
 * - paymentPayload: client-signed payment payload
 * - paymentRequirements: original payment requirements from server
 *
 * 返回：
 * - VerifyResponse（isValid/invalidReason 等）
 * Returns:
 * - VerifyResponse (isValid/invalidReason, etc.)
 *
 * 说明：
 * - 支付跟踪与 discovery 目录化由 onAfterVerify hook 自动完成。
 * Notes:
 * - Payment tracking and discovery cataloging are handled by onAfterVerify hook.
 */
app.post("/verify", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body as { paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements };

    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({
        error: "Missing paymentPayload or paymentRequirements",
      });
    }

    // Hook 会自动执行：
    // - 记录已验证支付
    // - 提取/入库 discovery 信息
    // Hooks run automatically:
    // - record verified payment
    // - extract/store discovery info
    const response: VerifyResponse = await facilitator.verify(
      paymentPayload,
      paymentRequirements,
    );

    res.json(response);
  } catch (error) {
    console.error("Verify error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * POST /settle
 * 功能：执行链上结算。
 * Purpose: execute on-chain settlement.
 *
 * 请求体：
 * - paymentPayload
 * - paymentRequirements
 * Request body:
 * - paymentPayload
 * - paymentRequirements
 *
 * 返回：
 * - SettleResponse（success/transaction/errorReason 等）
 * Returns:
 * - SettleResponse (success/transaction/errorReason, etc.)
 *
 * 说明：
 * - 是否允许 settle、是否过期、以及后置清理由 hook 自动处理。
 * Notes:
 * - settle eligibility, expiry checks, and post-cleanup are handled by hooks.
 */
app.post("/settle", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body;

    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({
        error: "Missing paymentPayload or paymentRequirements",
      });
    }

    const typedPayload = paymentPayload as PaymentPayload;
    const typedRequirements = paymentRequirements as PaymentRequirements;

    // Hook 会自动执行：
    // - settle 前 verify 状态校验（未校验则中止）
    // - verify 超时校验
    // - 成功/失败后状态清理
    // Hooks run automatically:
    // - pre-settle verify-state check (abort if missing)
    // - verification TTL check
    // - cleanup after success/failure
    const response: SettleResponse = await facilitator.settle(
      typedPayload,
      typedRequirements,
    );

    res.json(response);
  } catch (error) {
    console.error("Settle error:", error);

    // 若异常来自 hook 主动中止，则返回结构化 SettleResponse（而不是 500）
    // If aborted by hook, return structured SettleResponse instead of HTTP 500.
    if (error instanceof Error && error.message.includes("Settlement aborted:")) {
      // 这样上游 resource server 可以稳定按协议失败语义处理。
      // This allows upstream resource server to handle protocol-level failure deterministically.
      return res.json({
        success: false,
        errorReason: error.message.replace("Settlement aborted: ", ""),
        network: req.body?.paymentPayload?.network || "unknown",
      } as SettleResponse);
    }

    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /supported
 * 功能：返回当前 facilitator 支持的支付种类、网络与扩展能力。
 * Returns currently supported payment kinds, networks, and extensions.
 */
app.get("/supported", async (req, res) => {
  try {
    const response = facilitator.getSupported();
    res.json(response);
  } catch (error) {
    console.error("Supported error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /discovery/resources
 * 功能：分页读取 facilitator 在 verify 阶段归档的资源发现信息。
 * Reads discovery resources archived during verify, with pagination.
 *
 * 查询参数：
 * - limit: 返回条数，默认 100
 * - offset: 起始偏移，默认 0
 * Query parameters:
 * - limit: number of records, default 100
 * - offset: pagination offset, default 0
 */
app.get("/discovery/resources", (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 100;
    const offset = parseInt(req.query.offset as string) || 0;

    const response = bazaarCatalog.getResources(limit, offset);
    res.json(response);
  } catch (error) {
    console.error("Discovery resources error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /health
 * 功能：健康检查 + 运行时配置摘要。
 * Health check plus runtime configuration summary.
 */
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    evmNetwork: EVM_NETWORK,
    svmNetwork: SVM_NETWORK,
    aptosNetwork: aptosAccount ? APTOS_NETWORK : "(not configured)",
    facilitator: "typescript",
    version: "2.0.0",
    extensions: [BAZAAR.key],
    discoveredResources: bazaarCatalog.getCount(),
  });
});

/**
 * POST /close
 * 功能：优雅退出（先返回响应，再短延时结束进程）。
 * Graceful shutdown (respond first, then exit after a short delay).
 */
app.post("/close", (req, res) => {
  res.json({ message: "Facilitator shutting down gracefully" });
  console.log("Received shutdown request");

  // 预留极短时间确保响应先返回给调用方，再退出进程。
  // Keep a short delay to ensure response is flushed before process exit.
  setTimeout(() => {
    process.exit(0);
  }, 100);
});

/**
 * 启动 facilitator HTTP 服务。
 * 启动后打印关键运行参数与所有对外接口，便于演示时快速核对环境。
 * Starts facilitator HTTP service and prints runtime/endpoints for quick demo validation.
 */
app.listen(parseInt(PORT), () => {
  console.log(`
╔════════════════════════════════════════════════════════╗
║           x402 TypeScript Facilitator                  ║
╠════════════════════════════════════════════════════════╣
║  Server:       http://localhost:${PORT}                ║
║  EVM Network:  ${EVM_NETWORK}                          ║
║  SVM Network:  ${SVM_NETWORK}                          ║
║  Aptos Network: ${APTOS_NETWORK}                       ║
║  EVM Address:  ${evmAccount.address}                   ║
║  Aptos Address: ${aptosAccount ? aptosAccount.accountAddress.toStringLong().slice(0, 20) + "..." : "(not configured)"}
║  Extensions:   bazaar                                  ║
║                                                        ║
║  Endpoints:                                            ║
║  • POST /verify              (verify payment)          ║
║  • POST /settle              (settle payment)          ║
║  • GET  /supported           (get supported kinds)     ║
║  • GET  /discovery/resources (list discovered)         ║
║  • GET  /health              (health check)            ║
║  • POST /close               (shutdown server)         ║
╚════════════════════════════════════════════════════════╝
  `);

  // 该日志用于 e2e 场景判断 facilitator 已可用。
  // This log is used by e2e scripts to detect facilitator readiness.
  console.log("Facilitator listening");
});
