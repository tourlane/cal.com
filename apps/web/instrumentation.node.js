import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";

const sdk = new NodeSDK({
  serviceName: "cal.com",
  spanProcessor: new SimpleSpanProcessor(new OTLPTraceExporter()),
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();
