import { config } from "dotenv";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
config();

/**
 * 资源服务（Resource Server）职责：
 * 1. 对业务路由（/weather）挂载 x402 支付中间件。
 * 2. 在收到 PAYMENT-SIGNATURE 后，通过 facilitator 执行 verify/settle。
 * 3. 支付成功后返回业务内容，并由协议层附带 PAYMENT-RESPONSE。
 *
 * Resource Server responsibilities:
 * 1. Mount x402 payment middleware on business routes (/weather).
 * 2. After receiving PAYMENT-SIGNATURE, call facilitator verify/settle.
 * 3. Return business content after successful payment with PAYMENT-RESPONSE.
 */
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

if (!evmAddress || !evmAsset) {
  console.error("❌ EVM_ADDRESS and EVM_PRICE_ASSET environment variables are required");
  process.exit(1);
}

const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });

const app = express();

/**
 * x402 支付中间件：
 * 1. 首次请求返回 402 + PAYMENT-REQUIRED（由 accepts 定义）。
 * 2. 客户端重试并携带 PAYMENT-SIGNATURE 后，调用 facilitator verify/settle。
 * 3. 结算通过后才放行业务路由。
 *
 * x402 payment middleware:
 * 1. First request returns 402 + PAYMENT-REQUIRED (defined by `accepts`).
 * 2. Client retries with PAYMENT-SIGNATURE, then facilitator verify/settle runs.
 * 3. Business route is allowed only after settlement succeeds.
 */
app.use(
  paymentMiddleware(
    {
      "GET /weather": {
        // 这些字段会被序列化到 PAYMENT-REQUIRED 中返回给客户端：
        // 客户端据此选择方案、签名，再带 PAYMENT-SIGNATURE 重试。
        // These fields are serialized into PAYMENT-REQUIRED for client-side signing/retry.
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
    // x402ResourceServer 封装了 verify/settle 的协议调用细节。
    // x402ResourceServer wraps verify/settle protocol calls and error mapping.
    new x402ResourceServer(facilitatorClient).register(evmNetwork, new ExactEvmScheme()),
  ),
);

/**
 * GET /weather 业务处理函数：
 * - 这里不再关心支付细节，默认上游 paymentMiddleware 已放行。
 * - 只负责读取业务参数并返回天气数据。
 *
 * GET /weather business handler:
 * - Payment concerns are intentionally delegated to upstream middleware.
 * - This handler only reads business params and returns weather data.
 */
app.get("/weather", (req, res) => {
  // 能进入该处理函数，说明支付中间件已放行（通常意味着已完成 verify/settle）。
  // 因此这里仅保留业务逻辑，避免业务代码与支付协议耦合。
  // Reaching here means payment middleware already allowed the request.
  // Keep business logic isolated from payment protocol details.
  const city =
    typeof req.query.city === "string" && req.query.city.length > 0 ? req.query.city : "Guangzhou";
  res.send({
    report: {
      city,
      weather: "sunny",
      temperature: 70,
    },
  });
});

/**
 * 启动资源服务监听端口。
 * 用于本地演示链路中的“被付费访问资源端”。
 * Starts the resource server listener for the paid-access demo endpoint.
 */
app.listen(4021, () => {
  console.log(`Server listening at http://localhost:${4021}`);
});
