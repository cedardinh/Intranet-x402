import { x402Facilitator } from "@x402/core/facilitator";
import {
  type Network,
  type PaymentPayload,
  type PaymentRequirements,
} from "@x402/core/types";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import dotenv from "dotenv";
import express from "express";
import { Chain, createWalletClient, defineChain, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";

dotenv.config();

const PORT = Number.parseInt(process.env.PORT || "4022", 10);
const EVM_NETWORK = process.env.EVM_NETWORK || "eip155:84532";
const EVM_RPC_URL = process.env.EVM_RPC_URL || "";

if (!process.env.EVM_PRIVATE_KEY) {
  console.error("❌ EVM_PRIVATE_KEY environment variable is required");
  process.exit(1);
}

if (!EVM_RPC_URL) {
  console.error("❌ EVM_RPC_URL environment variable is required");
  process.exit(1);
}

function parseEvmChainId(network: string): number | null {
  const matched = /^eip155:(\d+)$/.exec(network);
  if (!matched) return null;
  const chainId = Number.parseInt(matched[1], 10);
  return Number.isInteger(chainId) && chainId > 0 ? chainId : null;
}

function createEvmChain(network: string): Chain {
  const chainId = parseEvmChainId(network);
  if (!chainId) {
    throw new Error(`Invalid EVM network format: ${network}. Expected eip155:<chainId>`);
  }

  return defineChain({
    id: chainId,
    name: `EVM Chain ${chainId}`,
    network: `eip155-${chainId}`,
    nativeCurrency: {
      name: "Ether",
      symbol: "ETH",
      decimals: 18,
    },
    rpcUrls: {
      default: { http: [EVM_RPC_URL] },
      public: { http: [EVM_RPC_URL] },
    },
  });
}

const evmAccount = privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`);
const evmChain = createEvmChain(EVM_NETWORK);
const viemClient = createWalletClient({
  account: evmAccount,
  chain: evmChain,
  transport: http(EVM_RPC_URL),
}).extend(publicActions);

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
  sendTransaction: (args: { to: `0x${string}`; data: `0x${string}` }) => viemClient.sendTransaction(args),
  waitForTransactionReceipt: (args: { hash: `0x${string}` }) => viemClient.waitForTransactionReceipt(args),
  getCode: (args: { address: `0x${string}` }) => viemClient.getCode(args),
});

const facilitator = new x402Facilitator().register(EVM_NETWORK as Network, new ExactEvmScheme(evmSigner));

const app = express();
app.use(express.json());

type PaymentRequestBody = {
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
};

function parsePaymentRequestBody(body: unknown): PaymentRequestBody | null {
  if (!body || typeof body !== "object") return null;

  const candidate = body as Partial<PaymentRequestBody>;
  if (!candidate.paymentPayload || !candidate.paymentRequirements) return null;

  return {
    paymentPayload: candidate.paymentPayload,
    paymentRequirements: candidate.paymentRequirements,
  };
}

app.post("/verify", async (req, res) => {
  try {
    const parsedBody = parsePaymentRequestBody(req.body);
    if (!parsedBody) {
      return res.status(400).json({ error: "Missing paymentPayload or paymentRequirements" });
    }

    const { paymentPayload, paymentRequirements } = parsedBody;
    const response = await facilitator.verify(paymentPayload, paymentRequirements);
    res.json(response);
  } catch (error) {
    console.error("Verify error:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

app.post("/settle", async (req, res) => {
  const parsedBody = parsePaymentRequestBody(req.body);
  if (!parsedBody) {
    return res.status(400).json({ error: "Missing paymentPayload or paymentRequirements" });
  }

  try {
    const { paymentPayload, paymentRequirements } = parsedBody;
    const response = await facilitator.settle(paymentPayload, paymentRequirements);
    res.json(response);
  } catch (error) {
    console.error("Settle error:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

app.get("/supported", (req, res) => {
  try {
    res.json(facilitator.getSupported());
  } catch (error) {
    console.error("Supported error:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

app.listen(PORT, () => {
  console.log(`🌐 EVM Network: ${EVM_NETWORK}`);
  console.log(`🌐 EVM RPC URL: ${EVM_RPC_URL}`);
  console.log(`EVM Facilitator account: ${evmAccount.address}`);
  console.log(`Facilitator listening at http://localhost:${PORT}`);
});
