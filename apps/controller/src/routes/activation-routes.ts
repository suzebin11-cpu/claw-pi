import { type OpenAPIHono, createRoute } from "@hono/zod-openapi";
import {
  activationLoginBodySchema,
  activationLoginResponseSchema,
  activationLogoutResponseSchema,
  activationRegisterBodySchema,
  activationRegisterResponseSchema,
  activationStatusResponseSchema,
  balanceResponseSchema,
  rechargeBodySchema,
  rechargeResponseSchema,
  transactionsQuerySchema,
  transactionsResponseSchema,
  usageLogsQuerySchema,
  usageLogsResponseSchema,
} from "@nexu/shared";
import type { ControllerContainer } from "../app/container.js";
import type { ControllerBindings } from "../types.js";

export function registerActivationRoutes(
  app: OpenAPIHono<ControllerBindings>,
  container: ControllerContainer,
): void {
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/internal/activation/status",
      tags: ["Activation"],
      responses: {
        200: {
          content: {
            "application/json": { schema: activationStatusResponseSchema },
          },
          description: "Activation status",
        },
      },
    }),
    async (c) => {
      const status = await container.desktopLocalService.getActivationStatus();
      return c.json(status, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/internal/activation/register",
      tags: ["Activation"],
      request: {
        body: {
          required: true,
          content: {
            "application/json": { schema: activationRegisterBodySchema },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: activationRegisterResponseSchema },
          },
          description: "Register with activation code",
        },
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const result = await container.desktopLocalService.registerWithCode(body);
      return c.json(result, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/internal/activation/login",
      tags: ["Activation"],
      request: {
        body: {
          required: true,
          content: {
            "application/json": { schema: activationLoginBodySchema },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: activationLoginResponseSchema },
          },
          description: "Login with credentials",
        },
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const result =
        await container.desktopLocalService.loginWithCredentials(body);
      return c.json(result, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/internal/activation/logout",
      tags: ["Activation"],
      responses: {
        200: {
          content: {
            "application/json": { schema: activationLogoutResponseSchema },
          },
          description: "Logout and clear activation state",
        },
      },
    }),
    async (c) => {
      const result = await container.desktopLocalService.logout();
      return c.json(result, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/internal/activation/recharge",
      tags: ["Activation"],
      request: {
        body: {
          required: true,
          content: {
            "application/json": { schema: rechargeBodySchema },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: rechargeResponseSchema },
          },
          description: "Redeem a recharge code",
        },
      },
    }),
    async (c) => {
      const { code } = c.req.valid("json");
      const result =
        await container.desktopLocalService.redeemRechargeCode(code);
      return c.json(result, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/internal/activation/balance",
      tags: ["Activation"],
      responses: {
        200: {
          content: {
            "application/json": { schema: balanceResponseSchema },
          },
          description: "Get user balance",
        },
      },
    }),
    async (c) => {
      const result = await container.desktopLocalService.getBalance();
      return c.json(result, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/internal/activation/transactions",
      tags: ["Activation"],
      request: {
        query: transactionsQuerySchema,
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: transactionsResponseSchema },
          },
          description: "Transaction history",
        },
      },
    }),
    async (c) => {
      const { page, page_size } = c.req.valid("query");
      const result = await container.desktopLocalService.getTransactions(
        page,
        page_size,
      );
      return c.json(result, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/internal/activation/usage-logs",
      tags: ["Activation"],
      request: {
        query: usageLogsQuerySchema,
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: usageLogsResponseSchema },
          },
          description: "Usage logs",
        },
      },
    }),
    async (c) => {
      const { page, page_size } = c.req.valid("query");
      const result = await container.desktopLocalService.getUsageLogs(
        page,
        page_size,
      );
      return c.json(result, 200);
    },
  );
}
