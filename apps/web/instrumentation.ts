/* eslint-disable prettier/prettier */
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerOTel } from "@vercel/otel";

// import { performance } from "universal_perf_hooks";

export async function register() {
  console.log("===========================================");
  registerOTel({
    serviceName: "your-service-name",
    traceExporter: new OTLPTraceExporter({ url: "http://localhost:4318/v1/trace" }),
  });
  // if (process.env.NEXT_RUNTIME === "nodejs" || process.env.NEXT_RUNTIME === "edge") {
  //   console.log("Registering instrumentation for Node.js");
  //   await import("./instrumentation.node.ts");
  // }
  //  else if (process.env.NEXT_RUNTIME === "edge") {
  //   await import("./instrumentation.browser.ts");
  // }
}
