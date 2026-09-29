/**
 * A deterministic worker with no tools. It is not registered in the product:
 * an example vendor must never count as an independent model in a real Gate.
 * @type {import("@cuesheet/harness").Harness}
 */
export const echoWorker = {
  id: "example-echo",
  vendor: "example",
  roles: ["worker"],
  async probe() {
    return { installed: true, authed: true, version: "example/1" };
  },
  async usage() {
    return [{ window: "local", state: "unmetered" }];
  },
  contextFiles: [],
  async writeConnectors(_connectors) {
    // There is no external runtime to configure.
  },
  confinement() {
    return "read-only";
  },
  async run(ctx) {
    ctx.signal.throwIfAborted();
    if (ctx.station.role !== "worker") {
      throw new Error("The echo example only supports worker Stations.");
    }
    ctx.emit({ t: "text", chunk: `${ctx.brief}\n` });
    // No model invocation: both the token counts and marginal cost are zero.
    ctx.meter.record({ tokensIn: 0, tokensOut: 0, usd: 0 });
    return { status: "done", cost: ctx.meter.total() };
  },
};
