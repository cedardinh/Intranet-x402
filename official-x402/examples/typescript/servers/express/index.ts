import { config } from "dotenv";
import express, { Request } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
config();

const evmAddress = process.env.EVM_ADDRESS as `0x${string}`;
const facilitatorUrl = process.env.FACILITATOR_URL;
if (!facilitatorUrl) {
  console.error("❌ FACILITATOR_URL environment variable is required");
  process.exit(1);
}
const evmNetwork = (process.env.EVM_NETWORK || "eip155:84532") as `${string}:${string}`;
const evmAsset = process.env.EVM_PRICE_ASSET as `0x${string}`;
const evmAmount = process.env.EVM_PRICE_AMOUNT || "1000";
const evmAssetName = process.env.EVM_ASSET_NAME || "USDC";
const evmAssetVersion = process.env.EVM_ASSET_VERSION || "2";
const monitorUrl = process.env.MONITOR_URL;

if (!evmAddress || !evmAsset) {
  console.error("❌ EVM_ADDRESS and EVM_PRICE_ASSET environment variables are required");
  process.exit(1);
}

const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });

const app = express();

async function emitMonitorEvent(event: Record<string, unknown>): Promise<void> {
  if (!monitorUrl) {
    return;
  }
  try {
    await fetch(`${monitorUrl.replace(/\/$/, "")}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        component: "resource-server",
        ...event,
      }),
    });
  } catch {
    // Ignore monitor failures to avoid breaking x402 payment flow.
  }
}

function getTraceId(req: Request): string | undefined {
  const fromHeader = req.header("x-trace-id");
  if (typeof fromHeader === "string" && fromHeader.length > 0) {
    return fromHeader;
  }
  const fromQuery = req.query.traceId;
  if (typeof fromQuery === "string" && fromQuery.length > 0) {
    return fromQuery;
  }
  return undefined;
}

function hasPaymentSignature(req: Request): boolean {
  return Boolean(req.header("payment-signature") || req.header("x-payment"));
}

app.use((req, res, next) => {
  if (req.method === "GET" && req.path === "/weather" && hasPaymentSignature(req)) {
    const traceId = getTraceId(req);
    if (traceId) {
      void emitMonitorEvent({
        traceId,
        step: "x402.server.payment_signature.received",
        status: "success",
        network: evmNetwork,
        scheme: "exact",
      });
    }
  }
  next();
});

app.use(
  paymentMiddleware(
    {
      "GET /weather": {
        accepts: [
          {
            scheme: "exact",
            price: {
              amount: evmAmount,
              asset: evmAsset,
              extra: {
                name: evmAssetName,
                version: evmAssetVersion,
              },
            },
            network: evmNetwork,
            payTo: evmAddress,
          },
        ],
        description: "Weather data",
        mimeType: "application/json",
      },
    },
    new x402ResourceServer(facilitatorClient).register(evmNetwork, new ExactEvmScheme()),
  ),
);

app.get("/weather", (req, res) => {
  const city = typeof req.query.city === "string" && req.query.city.length > 0 ? req.query.city : "Guangzhou";
  const traceId = getTraceId(req);
  if (traceId) {
    void emitMonitorEvent({
      traceId,
      step: "x402.resource.execution.succeeded",
      status: "success",
      metadata: { city },
    });
  }
  res.send({
    report: {
      city,
      weather: "sunny",
      temperature: 70,
    },
  });
});

app.listen(4021, () => {
  console.log(`Server listening at http://localhost:${4021}`);
});
