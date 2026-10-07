import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  DEFAULT_WEBHOOK_BODY_LIMIT,
  PAYPAL_WEBHOOK_PATH,
  type PayPalWebhookService,
  type RawWebhookRouteRequest,
  type WebhookRouteReply,
} from "@mandatepay/paypal";

type RawRequest = FastifyRequest & { rawBody?: unknown };

function routeRequest(request: RawRequest): RawWebhookRouteRequest {
  const headers: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    headers[key] = value;
  }
  return { rawBody: request.rawBody, headers };
}

function routeReply(reply: FastifyReply): WebhookRouteReply {
  return {
    status(code) {
      reply.status(code);
      return this;
    },
    send(body) {
      return reply.send(body);
    },
  };
}

/**
 * Ingestion stays available during maintenance and when worker processing is off.
 * Dropping a delivery here would lose a provider event that recovery can still replay.
 */
export function registerPayPalWebhookRoutes(
  app: FastifyInstance,
  service: PayPalWebhookService,
  options: {
    recordDelivery?: (fact: {
      requestId: string;
      eventType: string | null;
      outcome: "REJECTED" | "ACCEPTED" | "DUPLICATE";
      inboxId: string | null;
    }) => Promise<void>;
  } = {},
): void {
  app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
      (request as RawRequest).rawBody = body;
      done(null, body);
    });
    scope.route({
      method: "POST",
      url: PAYPAL_WEBHOOK_PATH,
      bodyLimit: DEFAULT_WEBHOOK_BODY_LIMIT,
      handler: async (request, reply) => {
        const result = await service.handle(routeRequest(request as RawRequest));
        if (options.recordDelivery) {
          try {
            await options.recordDelivery({ requestId: randomUUID(), ...result.delivery });
          } catch {
            request.log.warn({ code: "WEBHOOK_DELIVERY_METRIC_FAILED" }, "Webhook delivery metric was not stored");
          }
        }
        return routeReply(reply).status(result.statusCode).send(result.body);
      },
    });
  });
}
