import type { FastifyInstance } from "fastify";

export interface UpdateStatus {
  phase:
    | "unavailable"
    | "idle"
    | "available"
    | "checking"
    | "downloading"
    | "ready"
    | "installing"
    | "error";
  currentVersion: string;
  mode?: "source" | "installer";
  currentRevision?: string;
  targetRevision?: string;
  checkout?: string;
  command?: string;
  version?: string;
  percent?: number;
  message?: string;
}

/** Source checks and optional shell installers share the same HTTP controls. */
export interface UpdateService {
  status(): UpdateStatus;
  check(): Promise<void>;
  /** Reserve the downloaded update before acknowledging the restart request. */
  prepareInstall(): void;
  restart(): void;
}

export function registerUpdateRoutes(
  app: FastifyInstance,
  service?: UpdateService,
): void {
  app.get(
    "/updates",
    async () =>
      service?.status() ?? {
        phase: "unavailable",
        currentVersion: "",
        message:
          "No updater is configured for this installation. Source checkouts can use npm run update:check.",
      },
  );

  app.post("/updates/check", async (_request, reply) => {
    if (!service)
      return reply
        .code(409)
        .send({ error: "This daemon has no configured updater." });
    // Release checks can fetch Git metadata or an installer. Poll status rather
    // than holding an HTTP connection open for an external network request.
    void service.check();
    return reply.code(202).send(service.status());
  });

  app.post("/updates/install", async (request, reply) => {
    const body = request.body as { confirm?: unknown } | null;
    if (body?.confirm !== true) {
      return reply.code(400).send({
        error:
          "Confirm the restart with { confirm: true }; active runs will be interrupted.",
      });
    }
    if (!service || service.status().phase !== "ready") {
      return reply
        .code(409)
        .send({ error: "No verified update is ready to install." });
    }
    service.prepareInstall();
    // Flush the acknowledgement before stopping the server that carries it.
    reply.raw.once("finish", () => setImmediate(() => service.restart()));
    return reply.code(202).send(service.status());
  });
}
