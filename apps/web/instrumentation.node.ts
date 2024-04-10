// import { Resource } from "@opentelemetry/resources";
// import { NodeSDK } from "@opentelemetry/sdk-node";
// import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";
// import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
// import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { Resource } from "@opentelemetry/resources";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

// const sdk = new NodeSDK({
//   resource: new Resource({
//     "service.name": "cal.com",
//     // NOTE: You can replace `your-project-name` with the actual name of your project
//   }),
//   spanProcessor: new SimpleSpanProcessor(
//     new OTLPTraceExporter({
//       url: "http://localhost:4318/v1/trace",
//     })
//   ),
// });

// sdk.start();

const exporter = new OTLPTraceExporter({
  url: "http://localhost:4318/v1/trace",
});
const provider = new NodeTracerProvider({
  resource: new Resource({
    "service.name": "basic-service",
  }),
});
provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
provider.register();

// registerInstrumentations({
//   instrumentations: [
//     getNodeAutoInstrumentations({
//       // load custom configuration for http instrumentation
//       "@opentelemetry/instrumentation-http": {
//         applyCustomAttributesOnSpan: (span) => {
//           console.log("---------------------------------------------");
//           span.setAttribute("foo2", "bar2");
//         },
//       },
//     }),
//   ],
// });
