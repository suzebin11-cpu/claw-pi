import { z } from "zod";

// --- Enums ---

export const sessionStatusSchema = z.enum(["active", "ended"]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

// --- Input schemas ---

export const createSessionSchema = z.object({
  botId: z.string().min(1),
  sessionKey: z.string().min(1),
  title: z.string().min(1).max(500),
  channelType: z.string().optional(),
  channelId: z.string().optional(),
  status: sessionStatusSchema.optional(),
  messageCount: z.number().int().optional(),
  lastMessageAt: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type CreateSessionInput = z.infer<typeof createSessionSchema>;

export const updateSessionSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  status: sessionStatusSchema.optional(),
  messageCount: z.number().int().optional(),
  lastMessageAt: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type UpdateSessionInput = z.infer<typeof updateSessionSchema>;

// --- Response schemas ---

export const sessionResponseSchema = z.object({
  id: z.string(),
  botId: z.string(),
  sessionKey: z.string(),
  channelType: z.string().nullable(),
  channelId: z.string().nullable(),
  title: z.string(),
  status: z.string(),
  messageCount: z.number(),
  lastMessageAt: z.string().nullable(),
  metadata: z.record(z.unknown()).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

export const sessionListResponseSchema = z.object({
  sessions: z.array(sessionResponseSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});
export type SessionListResponse = z.infer<typeof sessionListResponseSchema>;
