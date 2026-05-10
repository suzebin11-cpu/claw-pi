import { z } from "zod";

export const poolStatusSchema = z.enum([
  "pending",
  "active",
  "draining",
  "terminated",
]);

export const poolResponseSchema = z.object({
  id: z.string(),
  poolName: z.string(),
  poolType: z.string(),
  maxBots: z.number(),
  currentBots: z.number(),
  status: poolStatusSchema,
  configVersion: z.number(),
  createdAt: z.string(),
});

export type PoolStatus = z.infer<typeof poolStatusSchema>;
export type PoolResponse = z.infer<typeof poolResponseSchema>;
