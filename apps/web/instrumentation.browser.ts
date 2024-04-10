// import { Resource } from "@opentelemetry/resources";
// import { NodeSDK } from "@opentelemetry/sdk-node";
// import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";
// import { getWebAutoInstrumentations } from "@opentelemetry/auto-instrumentations-web";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
// import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { Resource } from "@opentelemetry/resources";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { WebTracerProvider } from "@opentelemetry/sdk-trace-web";

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
const provider = new WebTracerProvider({
  resource: new Resource({
    "service.name": "basic-service",
  }),
});
provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
provider.register();

// registerInstrumentations({
//   instrumentations: [
//     getWebAutoInstrumentations({
//       // load custom configuration for http instrumentation
//       "@opentelemetry/instrumentation-http": {
//         applyCustomAttributesOnSpan: (span) => {
//           span.setAttribute("foo2", "bar2");
//         },
//       },
//     }),
//   ],
// });
