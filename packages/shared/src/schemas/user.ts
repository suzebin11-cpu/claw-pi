import { z } from "zod";

export const userProfileResponseSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  image: z.string().nullable().optional(),
  plan: z.string(),
  inviteAccepted: z.boolean(),
  onboardingCompleted: z.boolean(),
  authSource: z.string().nullable().optional(),
});

export type UserProfileResponse = z.infer<typeof userProfileResponseSchema>;

const imageDataUrlSchema = z
  .string()
  .regex(
    /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/,
    "Invalid image data URL",
  );

export const updateUserProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    image: z
      .union([z.string().url(), imageDataUrlSchema])
      .nullable()
      .optional(),
  })
  .refine((value) => value.name !== undefined || value.image !== undefined, {
    message: "At least one field must be provided",
  });

export type UpdateUserProfileRequest = z.infer<typeof updateUserProfileSchema>;

export const updateUserProfileResponseSchema = z.object({
  ok: z.boolean(),
  profile: userProfileResponseSchema,
});

export const updateAuthSourceSchema = z.object({
  source: z.enum(["email", "google", "slack_shared_claim", "IM", "Landing"]),
  detail: z.string().optional(),
});

export type UpdateAuthSourceRequest = z.infer<typeof updateAuthSourceSchema>;

export const updateAuthSourceResponseSchema = z.object({
  ok: z.boolean(),
});
