import { z } from "zod";

export const activationRegisterBodySchema = z.object({
  code: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6),
});

export const activationLoginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

export const activationRegisterResponseSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  email: z.string().optional(),
  activatedAt: z.string().optional(),
});

export const activationLoginResponseSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  email: z.string().optional(),
});

export const activationStatusResponseSchema = z.object({
  activated: z.boolean(),
  email: z.string().nullable(),
  activatedAt: z.string().nullable(),
  codePrefix: z.string().nullable(),
});

export const activationLogoutResponseSchema = z.object({
  ok: z.boolean(),
});

export const rechargeBodySchema = z.object({
  code: z.string().min(1),
});

export const rechargeResponseSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  added_cents: z.number().optional(),
  new_balance_cents: z.number().optional(),
});

export const balanceResponseSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  balance_cents: z.number().optional(),
  total_recharged: z.number().optional(),
});

export const transactionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
});

export const transactionItemSchema = z.object({
  id: z.number(),
  type: z.string(),
  amount_cents: z.number(),
  balance_after: z.number(),
  description: z.string(),
  created_at: z.string(),
});

export const transactionsResponseSchema = z.object({
  success: z.boolean(),
  transactions: z.array(transactionItemSchema),
  total: z.number(),
  page: z.number(),
  page_size: z.number(),
  error: z.string().optional(),
});

export const usageLogsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
});

export const usageLogItemSchema = z.object({
  id: z.number(),
  model_name: z.string(),
  cost_cents: z.number(),
  prompt_tokens: z.number(),
  completion_tokens: z.number(),
  created_at: z.string(),
});

export const usageLogsResponseSchema = z.object({
  success: z.boolean(),
  logs: z.array(usageLogItemSchema),
  total: z.number(),
  page: z.number(),
  page_size: z.number(),
  error: z.string().optional(),
});
