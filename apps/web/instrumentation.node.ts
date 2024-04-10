import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";

const sdk = new NodeSDK({
  resource: new Resource({
    "service.name": "cal.com",
  }),
  spanProcessor: new SimpleSpanProcessor(new OTLPTraceExporter()),
});

sdk.start();
