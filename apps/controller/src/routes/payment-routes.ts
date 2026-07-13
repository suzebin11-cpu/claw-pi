import { type OpenAPIHono, createRoute } from "@hono/zod-openapi";
import {
  cancelAlipayOrderBodySchema,
  cancelAlipayOrderResponseSchema,
  createAlipayOrderBodySchema,
  createAlipayOrderResponseSchema,
  pendingOrdersResponseSchema,
  queryAlipayOrderBodySchema,
  queryAlipayOrderResponseSchema,
} from "@nexu/shared";
import type { ControllerContainer } from "../app/container.js";
import type { ControllerBindings } from "../types.js";

export function registerPaymentRoutes(
  app: OpenAPIHono<ControllerBindings>,
  container: ControllerContainer,
): void {
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/internal/payment/alipay/create-order",
      tags: ["Payment"],
      request: {
        body: {
          required: true,
          content: {
            "application/json": { schema: createAlipayOrderBodySchema },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: createAlipayOrderResponseSchema },
          },
          description: "Create Alipay payment order",
        },
      },
    }),
    async (c) => {
      const { amount_cents } = c.req.valid("json");
      const result =
        await container.desktopLocalService.createAlipayOrder(amount_cents);
      return c.json(result, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/internal/payment/alipay/query-order",
      tags: ["Payment"],
      request: {
        body: {
          required: true,
          content: {
            "application/json": { schema: queryAlipayOrderBodySchema },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: queryAlipayOrderResponseSchema },
          },
          description: "Query Alipay order status",
        },
      },
    }),
    async (c) => {
      const { out_trade_no } = c.req.valid("json");
      const result =
        await container.desktopLocalService.queryAlipayOrder(out_trade_no);
      return c.json(result, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/internal/payment/alipay/cancel-order",
      tags: ["Payment"],
      request: {
        body: {
          required: true,
          content: {
            "application/json": { schema: cancelAlipayOrderBodySchema },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: cancelAlipayOrderResponseSchema },
          },
          description: "Cancel pending Alipay order",
        },
      },
    }),
    async (c) => {
      const { out_trade_no } = c.req.valid("json");
      const result =
        await container.desktopLocalService.cancelAlipayOrder(out_trade_no);
      return c.json(result, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/internal/payment/alipay/pending-orders",
      tags: ["Payment"],
      responses: {
        200: {
          content: {
            "application/json": { schema: pendingOrdersResponseSchema },
          },
          description: "List pending Alipay orders",
        },
      },
    }),
    async (c) => {
      const result =
        await container.desktopLocalService.getPendingAlipayOrders();
      return c.json(result, 200);
    },
  );
}
