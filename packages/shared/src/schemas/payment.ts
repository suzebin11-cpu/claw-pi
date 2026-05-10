import { z } from "zod";

// ── Create Order ──

export const createAlipayOrderBodySchema = z.object({
  amount_cents: z.number().int().min(1),
});

export const createAlipayOrderResponseSchema = z.object({
  ok: z.boolean(),
  qr_code: z.string().optional(),
  out_trade_no: z.string().optional(),
  error: z.string().optional(),
});

// ── Query Order ──

export const queryAlipayOrderBodySchema = z.object({
  out_trade_no: z.string().min(1),
});

export const queryAlipayOrderResponseSchema = z.object({
  ok: z.boolean(),
  status: z.string().optional(),
  added_cents: z.number().optional(),
  new_balance_cents: z.number().optional(),
  error: z.string().optional(),
});

// ── Cancel Order ──

export const cancelAlipayOrderBodySchema = z.object({
  out_trade_no: z.string().min(1),
});

export const cancelAlipayOrderResponseSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});

// ── Pending Orders ──

export const pendingOrderItemSchema = z.object({
  out_trade_no: z.string(),
  amount_cents: z.number(),
  qr_code: z.string(),
  created_at: z.string(),
});

export const pendingOrdersResponseSchema = z.object({
  ok: z.boolean(),
  orders: z.array(pendingOrderItemSchema).optional(),
  error: z.string().optional(),
});
