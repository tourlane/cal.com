export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    console.log("Registering instrumentation for Node.js");
    await import("./instrumentation.node.ts");
  }
}
