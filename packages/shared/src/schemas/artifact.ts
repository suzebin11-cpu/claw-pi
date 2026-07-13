import { z } from "zod";

// --- Enums ---

export const artifactTypeSchema = z.enum(["code", "content", "deployment"]);
export type ArtifactType = z.infer<typeof artifactTypeSchema>;

export const artifactSourceSchema = z.enum(["coding", "content"]);
export type ArtifactSource = z.infer<typeof artifactSourceSchema>;

export const artifactStatusSchema = z.enum([
  "building",
  "live",
  "failed",
  "stopped",
]);
export type ArtifactStatus = z.infer<typeof artifactStatusSchema>;

// --- Input schemas ---

export const createArtifactSchema = z.object({
  botId: z.string().min(1),
  title: z.string().min(1).max(500),
  sessionKey: z.string().optional(),
  chatId: z.string().optional(),
  threadId: z.string().optional(),
  channelType: z.string().optional(),
  channelId: z.string().optional(),
  artifactType: artifactTypeSchema.optional(),
  source: artifactSourceSchema.optional(),
  contentType: z.string().optional(),
  status: artifactStatusSchema.optional(),
  previewUrl: z.string().url().optional(),
  deployTarget: z.string().optional(),
  linesOfCode: z.number().int().optional(),
  fileCount: z.number().int().optional(),
  durationMs: z.number().int().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type CreateArtifactInput = z.infer<typeof createArtifactSchema>;

export const updateArtifactSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  status: artifactStatusSchema.optional(),
  previewUrl: z.string().url().optional(),
  deployTarget: z.string().optional(),
  linesOfCode: z.number().int().optional(),
  fileCount: z.number().int().optional(),
  durationMs: z.number().int().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type UpdateArtifactInput = z.infer<typeof updateArtifactSchema>;

// --- Response schemas ---

export const artifactResponseSchema = z.object({
  id: z.string(),
  botId: z.string(),
  sessionKey: z.string().nullable(),
  channelType: z.string().nullable(),
  channelId: z.string().nullable(),
  title: z.string(),
  artifactType: z.string().nullable(),
  source: z.string().nullable(),
  contentType: z.string().nullable(),
  status: z.string(),
  previewUrl: z.string().nullable(),
  deployTarget: z.string().nullable(),
  linesOfCode: z.number().nullable(),
  fileCount: z.number().nullable(),
  durationMs: z.number().nullable(),
  metadata: z.record(z.unknown()).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ArtifactResponse = z.infer<typeof artifactResponseSchema>;

export const artifactListResponseSchema = z.object({
  artifacts: z.array(artifactResponseSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});
export type ArtifactListResponse = z.infer<typeof artifactListResponseSchema>;

export const artifactStatsResponseSchema = z.object({
  totalArtifacts: z.number(),
  liveCount: z.number(),
  buildingCount: z.number(),
  failedCount: z.number(),
  codingCount: z.number(),
  contentCount: z.number(),
  totalLinesOfCode: z.number(),
});
export type ArtifactStatsResponse = z.infer<typeof artifactStatsResponseSchema>;
