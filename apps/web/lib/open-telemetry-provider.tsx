import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { SimpleSpanProcessor, WebTracerProvider } from "@opentelemetry/sdk-trace-web";

// Create a Jaeger exporter
export const exporter = new OTLPTraceExporter({
  url: "http://localhost:4318/v1/traces",
});

// Create a tracer provider
export const tracerProvider = new WebTracerProvider({
  resource: new Resource({
    "service.name": "cal.com",
  }),
});

// Add the Jaeger exporter to the tracer provider
tracerProvider.addSpanProcessor(new SimpleSpanProcessor(exporter));

// Register the tracer provider
tracerProvider.register();
