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

/** Registers an encapsulated raw JSON parser; global JSON routes are untouched. */
export function registerPayPalWebhookRoutes(
  app: FastifyInstance,
  service: PayPalWebhookService,
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
        return service
          .handle(routeRequest(request as RawRequest))
          .then((result) => routeReply(reply).status(result.statusCode).send(result.body));
      },
    });
  });
}
