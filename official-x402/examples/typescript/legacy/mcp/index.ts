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

const privateKey = process.env.PRIVATE_KEY as `0x${string}`;
const baseURL = process.env.RESOURCE_SERVER_URL as string; // e.g. https://example.com
const endpointPath = process.env.ENDPOINT_PATH as string; // e.g. /weather
const monitorUrl = process.env.MONITOR_URL;

if (!privateKey || !baseURL || !endpointPath) {
  throw new Error("Missing environment variables");
}

const signer = privateKeyToAccount(privateKey);
const paymentClient = new x402Client().register("eip155:*", new ExactEvmScheme(signer));
const httpClient = new x402HTTPClient(paymentClient);
const client = axios.create({ baseURL });

const EVM_CHAIN_NAME_BY_ID: Record<string, string> = {
  "1": "Ethereum Mainnet",
  "8453": "Base Mainnet",
  "84532": "Local Anvil",
  "11155111": "Ethereum Sepolia",
};

async function emitMonitorEvent(event: Record<string, unknown>): Promise<void> {
  if (!monitorUrl) {
    return;
  }

  try {
    await fetch(`${monitorUrl.replace(/\/$/, "")}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        component: "mcp-bridge",
        ...event,
      }),
    });
  } catch {
    // Ignore monitor failures to avoid affecting payment flow.
  }
}

function buildToolResponsePayload(
  data: unknown,
  settlement: { traceId: string; txHash?: string; network?: string },
): Record<string, unknown> {
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

function normalizeNetwork(network?: string): { network: string | null; chainId: number | null } {
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

// Create an MCP server
const server = new McpServer({
  name: "x402 MCP Client Demo",
  version: "1.0.0",
});

// Add an addition tool
server.tool(
  "get-data-from-resource-server",
  "Get data from the resource server (in this example, the weather)",
  {
    city: z.string().optional().describe("Optional city name, e.g. Guangzhou"),
  },
  async (args: { city?: string }) => {
    const traceId = crypto.randomUUID();
    const startedAt = Date.now();
    const city = typeof args?.city === "string" && args.city.length > 0 ? args.city : undefined;
    const queryPathBase = city
      ? `${endpointPath}${endpointPath.includes("?") ? "&" : "?"}city=${encodeURIComponent(city)}`
      : endpointPath;
    const queryPath = `${queryPathBase}${queryPathBase.includes("?") ? "&" : "?"}traceId=${encodeURIComponent(traceId)}`;
    const traceHeaders = { "x-trace-id": traceId };

    void emitMonitorEvent({
      traceId,
      step: "chat.user_message.received",
      status: "info",
      metadata: { args },
    });
    void emitMonitorEvent({ traceId, step: "assistant.intent.resolved", status: "success" });
    void emitMonitorEvent({
      traceId,
      step: "assistant.tool_call.planned",
      status: "success",
      toolName: "get-data-from-resource-server",
    });
    void emitMonitorEvent({
      traceId,
      step: "mcp.tool_call.started",
      status: "started",
      toolName: "get-data-from-resource-server",
    });

    try {
      void emitMonitorEvent({
        traceId,
        step: "x402.http.initial_request.sent",
        status: "started",
        toolName: "get-data-from-resource-server",
      });
      const initialResponse = await client.get(queryPath, {
        headers: traceHeaders,
        validateStatus: () => true,
      });

      if (initialResponse.status !== 402) {
        if (initialResponse.status >= 200 && initialResponse.status < 300) {
          const payload = buildToolResponsePayload(initialResponse.data, { traceId });
          void emitMonitorEvent({
            traceId,
            step: "mcp.tool_call.completed",
            status: "success",
            durationMs: Date.now() - startedAt,
          });
          void emitMonitorEvent({
            traceId,
            step: "assistant.explanation.generated",
            status: "success",
          });
          void emitMonitorEvent({
            traceId,
            step: "chat.assistant_message.sent",
            status: "success",
          });
          return {
            content: [{ type: "text", text: JSON.stringify(payload) }],
          };
        }

        throw new Error(`Unexpected status code from resource server: ${initialResponse.status}`);
      }

      void emitMonitorEvent({
        traceId,
        step: "x402.http.402_received",
        status: "success",
      });

      const paymentRequired = httpClient.getPaymentRequiredResponse(
        name => {
          const key = name.toLowerCase();
          const value = initialResponse.headers[key];
          return typeof value === "string" ? value : undefined;
        },
        initialResponse.data,
      );

      void emitMonitorEvent({
        traceId,
        step: "x402.payment_required.decoded",
        status: "success",
      });

      const paymentPayload = await paymentClient.createPaymentPayload(paymentRequired);
      const accepted = paymentPayload.accepted;

      void emitMonitorEvent({
        traceId,
        step: "x402.payment_requirement.selected",
        status: "success",
        network: accepted.network,
        scheme: accepted.scheme,
        asset: accepted.asset,
        amount: accepted.amount,
        payTo: accepted.payTo,
      });
      void emitMonitorEvent({
        traceId,
        step: "x402.payment_payload.created",
        status: "success",
      });

      const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);
      void emitMonitorEvent({
        traceId,
        step: "x402.http.retry_with_payment_signature.sent",
        status: "started",
      });

      const paidResponse = await client.get(queryPath, {
        headers: {
          ...traceHeaders,
          ...paymentHeaders,
        },
        validateStatus: () => true,
      });

      if (paidResponse.status !== 200) {
        throw new Error(`Payment retry failed with status ${paidResponse.status}`);
      }

      void emitMonitorEvent({
        traceId,
        step: "x402.http.200_with_payment_response.received",
        status: "success",
      });

      const encodedPaymentResponse =
        (paidResponse.headers["payment-response"] as string | undefined) ||
        (paidResponse.headers["x-payment-response"] as string | undefined);
      let settlementTxHash: string | undefined;
      let settlementNetwork: string | undefined;
      if (encodedPaymentResponse) {
        const settlement = decodePaymentResponseHeader(encodedPaymentResponse);
        settlementTxHash = settlement.transaction;
        settlementNetwork = settlement.network;
        void emitMonitorEvent({
          traceId,
          step: "x402.payment_response.decoded",
          status: "success",
          txHash: settlementTxHash,
          network: settlementNetwork,
        });
      }

      void emitMonitorEvent({
        traceId,
        step: "mcp.tool_call.completed",
        status: "success",
        durationMs: Date.now() - startedAt,
      });
      void emitMonitorEvent({
        traceId,
        step: "assistant.explanation.generated",
        status: "success",
      });
      void emitMonitorEvent({
        traceId,
        step: "chat.assistant_message.sent",
        status: "success",
      });

      const payload = buildToolResponsePayload(paidResponse.data, {
        traceId,
        txHash: settlementTxHash,
        network: settlementNetwork,
      });

      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      void emitMonitorEvent({
        traceId,
        step: "mcp.tool_call.completed",
        status: "fail",
        errorReason: message,
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
