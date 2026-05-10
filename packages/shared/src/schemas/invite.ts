import { z } from "zod";

export const validateInviteSchema = z.object({
  code: z.string().min(1, "Invite code is required"),
});

export const validateInviteResponseSchema = z.object({
  valid: z.boolean(),
  message: z.string().optional(),
});

export type ValidateInviteInput = z.infer<typeof validateInviteSchema>;
export type ValidateInviteResponse = z.infer<
  typeof validateInviteResponseSchema
>;
