import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { RedisInstrumentation } from "@opentelemetry/instrumentation-redis";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { PrismaInstrumentation } from "@prisma/instrumentation";

const sdk = new NodeSDK({
  serviceName: "cal.com",
  spanProcessor: new SimpleSpanProcessor(new OTLPTraceExporter()),
  instrumentations: [new RedisInstrumentation(), new HttpInstrumentation(), new PrismaInstrumentation()],
});

sdk.start();
