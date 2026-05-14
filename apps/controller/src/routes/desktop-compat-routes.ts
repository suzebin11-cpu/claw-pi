import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  cloudConnectResponseSchema,
  cloudDisconnectResponseSchema,
  cloudModelsBodySchema,
  cloudModelsResponseSchema,
  cloudProfileConnectBodySchema,
  cloudProfileConnectResponseSchema,
  cloudProfileCreateBodySchema,
  cloudProfileCreateResponseSchema,
  cloudProfileDeleteBodySchema,
  cloudProfileDeleteResponseSchema,
  cloudProfileDisconnectBodySchema,
  cloudProfileDisconnectResponseSchema,
  cloudProfileSelectBodySchema,
  cloudProfileSelectResponseSchema,
  cloudProfileUpdateBodySchema,
  cloudProfileUpdateResponseSchema,
  cloudProfilesImportBodySchema,
  cloudProfilesImportResponseSchema,
  cloudRefreshResponseSchema,
  cloudStatusResponseSchema,
} from "@nexu/shared";
import type { ControllerContainer } from "../app/container.js";
import {
  isBuiltInDesktopCloudImageModel,
  normalizeDesktopCloudImageModelId,
} from "../lib/desktop-cloud-models.js";
import { resolveModelId } from "../lib/openclaw-config-compiler.js";
import type { ControllerBindings } from "../types.js";

const defaultModelBodySchema = z.object({ modelId: z.string() });
const defaultModelResponseSchema = z.object({ modelId: z.string().nullable() });
const defaultModelSetResponseSchema = z.object({
  ok: z.boolean(),
  modelId: z.string(),
  configPushed: z.boolean(),
  error: z.string().optional(),
});
const defaultImageModelBodySchema = z.object({ modelId: z.string() });
const defaultImageModelResponseSchema = z.object({
  modelId: z.string().nullable(),
});
const defaultImageModelSetResponseSchema = z.object({
  ok: z.boolean(),
  modelId: z.string(),
  configPushed: z.boolean(),
  error: z.string().optional(),
});

export function registerDesktopCompatRoutes(
  app: OpenAPIHono<ControllerBindings>,
  container: ControllerContainer,
): void {
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/internal/desktop/cloud-status",
      tags: ["Desktop"],
      responses: {
        200: {
          content: {
            "application/json": { schema: cloudStatusResponseSchema },
          },
          description: "Cloud status",
        },
      },
    }),
    async (c) =>
      c.json(await container.desktopLocalService.getCloudStatus(), 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/internal/desktop/cloud-connect",
      tags: ["Desktop"],
      responses: {
        200: {
          content: {
            "application/json": { schema: cloudConnectResponseSchema },
          },
          description: "Cloud connect",
        },
      },
    }),
    async (c) =>
      c.json(await container.desktopLocalService.connectCloud(), 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/internal/desktop/cloud-profile/connect",
      tags: ["Desktop"],
      request: {
        body: {
          required: true,
          content: {
            "application/json": { schema: cloudProfileConnectBodySchema },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: cloudProfileConnectResponseSchema },
          },
          description: "Connect cloud profile",
        },
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const result = await container.desktopLocalService.connectCloudProfile(
        body.name,
      );
      const { configPushed } =
        await container.openclawSyncService.syncAllImmediate();
      return c.json({ ...result, configPushed }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/internal/desktop/cloud-refresh",
      tags: ["Desktop"],
      responses: {
        200: {
          content: {
            "application/json": { schema: cloudRefreshResponseSchema },
          },
          description: "Cloud refresh",
        },
      },
    }),
    async (c) => {
      const status = await container.desktopLocalService.refreshCloudStatus();
      await container.modelProviderService.ensureValidDefaultModel();
      const { configPushed } =
        await container.openclawSyncService.syncAllImmediate();
      return c.json({ ...status, configPushed }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/internal/desktop/cloud-profile/create",
      tags: ["Desktop"],
      request: {
        body: {
          required: true,
          content: {
            "application/json": { schema: cloudProfileCreateBodySchema },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: cloudProfileCreateResponseSchema },
          },
          description: "Create cloud profile",
        },
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const status = await container.desktopLocalService.createCloudProfile(
        body.profile,
      );
      await container.modelProviderService.ensureValidDefaultModel();
      const { configPushed } = await container.openclawSyncService.syncAll();
      return c.json({ ok: true, ...status, configPushed }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/internal/desktop/cloud-profile/update",
      tags: ["Desktop"],
      request: {
        body: {
          required: true,
          content: {
            "application/json": { schema: cloudProfileUpdateBodySchema },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: cloudProfileUpdateResponseSchema },
          },
          description: "Update cloud profile",
        },
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const status = await container.desktopLocalService.updateCloudProfile(
        body.previousName,
        body.profile,
      );
      await container.modelProviderService.ensureValidDefaultModel();
      const { configPushed } = await container.openclawSyncService.syncAll();
      return c.json({ ok: true, ...status, configPushed }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/internal/desktop/cloud-profile/delete",
      tags: ["Desktop"],
      request: {
        body: {
          required: true,
          content: {
            "application/json": { schema: cloudProfileDeleteBodySchema },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: cloudProfileDeleteResponseSchema },
          },
          description: "Delete cloud profile",
        },
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const status = await container.desktopLocalService.deleteCloudProfile(
        body.name,
      );
      await container.modelProviderService.ensureValidDefaultModel();
      const { configPushed } = await container.openclawSyncService.syncAll();
      return c.json({ ok: true, ...status, configPushed }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/internal/desktop/cloud-disconnect",
      tags: ["Desktop"],
      responses: {
        200: {
          content: {
            "application/json": { schema: cloudDisconnectResponseSchema },
          },
          description: "Cloud disconnect",
        },
      },
    }),
    async (c) =>
      c.json(await container.desktopLocalService.disconnectCloud(), 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/internal/desktop/cloud-profile/disconnect",
      tags: ["Desktop"],
      request: {
        body: {
          required: true,
          content: {
            "application/json": {
              schema: cloudProfileDisconnectBodySchema,
            },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: cloudProfileDisconnectResponseSchema,
            },
          },
          description: "Disconnect cloud profile",
        },
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const status = await container.desktopLocalService.disconnectCloudProfile(
        body.name,
      );
      await container.modelProviderService.ensureValidDefaultModel();
      const { configPushed } = await container.openclawSyncService.syncAll();
      return c.json({ ok: true, ...status, configPushed }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/internal/desktop/cloud-profile/select",
      tags: ["Desktop"],
      request: {
        body: {
          required: true,
          content: {
            "application/json": { schema: cloudProfileSelectBodySchema },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: cloudProfileSelectResponseSchema },
          },
          description: "Switch cloud profile",
        },
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const status = await container.desktopLocalService.switchCloudProfile(
        body.name,
      );
      await container.modelProviderService.ensureValidDefaultModel();
      const { configPushed } = await container.openclawSyncService.syncAll();
      return c.json({ ok: true, ...status, configPushed }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/internal/desktop/cloud-profiles/import",
      tags: ["Desktop"],
      request: {
        body: {
          required: true,
          content: {
            "application/json": { schema: cloudProfilesImportBodySchema },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: cloudProfilesImportResponseSchema },
          },
          description: "Import cloud profiles",
        },
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const status = await container.desktopLocalService.importCloudProfiles(
        body.profiles,
      );
      await container.modelProviderService.ensureValidDefaultModel();
      const { configPushed } = await container.openclawSyncService.syncAll();
      return c.json({ ok: true, ...status, configPushed }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/api/internal/desktop/cloud-models",
      tags: ["Desktop"],
      request: {
        body: {
          content: { "application/json": { schema: cloudModelsBodySchema } },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: cloudModelsResponseSchema },
          },
          description: "Cloud models",
        },
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      return c.json(
        await container.desktopLocalService.setCloudModels(
          body.enabledModelIds,
        ),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/internal/desktop/default-model",
      tags: ["Desktop"],
      responses: {
        200: {
          content: {
            "application/json": { schema: defaultModelResponseSchema },
          },
          description: "Default model",
        },
      },
    }),
    async (c) => {
      const runtimeModelId =
        await container.runtimeModelStateService.getEffectiveModelId();
      if (runtimeModelId) {
        return c.json({ modelId: runtimeModelId }, 200);
      }

      const config = await container.configStore.getConfig();
      const rawModelId = config.runtime.defaultModelId;
      const modelId = rawModelId
        ? resolveModelId(config, container.env, rawModelId)
        : null;
      return c.json({ modelId }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/api/internal/desktop/default-model",
      tags: ["Desktop"],
      request: {
        body: {
          content: { "application/json": { schema: defaultModelBodySchema } },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: defaultModelSetResponseSchema },
          },
          description: "Set default model",
        },
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const before =
        await container.openclawSyncService.getRuntimeModelAvailability(
          body.modelId,
        );
      let configPushed = false;

      if (!before.available) {
        const result = await container.openclawSyncService.syncAllImmediate();
        configPushed = result.configPushed;
        const after =
          await container.openclawSyncService.getRuntimeModelAvailability(
            body.modelId,
          );

        if (!after.available) {
          const error =
            after.availableModelRefs.length === 0
              ? "模型服务尚未就绪，请先登录或刷新 Claw-Pi 官方服务。"
              : `当前 OpenClaw 配置无法使用模型 ${after.resolvedModelRef}。`;
          return c.json(
            { ok: false, modelId: body.modelId, configPushed, error },
            200,
          );
        }
      }

      await container.desktopLocalService.setDefaultModel(body.modelId);
      const target = await container.openclawSyncService.getRuntimeModelAvailability(
        body.modelId,
      );
      await container.openclawSyncService.syncRuntimeModelOnly();
      await container.openclawSyncService.syncSessionModelOverrides(
        target.resolvedModelRef,
      );

      const applied =
        await container.runtimeModelStateService.waitForEffectiveModelId(
          target.resolvedModelRef,
          { timeoutMs: 5000, intervalMs: 150 },
        );
      if (!applied.ok) {
        return c.json(
          {
            ok: false,
            modelId: body.modelId,
            configPushed,
            error: `模型已保存，但运行时尚未确认切换到 ${target.resolvedModelRef}。`,
          },
          200,
        );
      }

      return c.json({ ok: true, modelId: body.modelId, configPushed }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/api/internal/desktop/default-image-model",
      tags: ["Desktop"],
      responses: {
        200: {
          content: {
            "application/json": { schema: defaultImageModelResponseSchema },
          },
          description: "Default image generation model",
        },
      },
    }),
    async (c) => {
      const config = await container.configStore.getConfig();
      const modelId = config.runtime.defaultImageGenerationModelId;
      const normalizedModelId =
        typeof modelId === "string" && modelId.length > 0
          ? normalizeDesktopCloudImageModelId(modelId)
          : null;
      return c.json(
        {
          modelId:
            normalizedModelId &&
            isBuiltInDesktopCloudImageModel(normalizedModelId)
              ? normalizedModelId
              : null,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/api/internal/desktop/default-image-model",
      tags: ["Desktop"],
      request: {
        body: {
          content: {
            "application/json": { schema: defaultImageModelBodySchema },
          },
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: defaultImageModelSetResponseSchema },
          },
          description: "Set default image generation model",
        },
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const modelId = normalizeDesktopCloudImageModelId(body.modelId);
      let configPushed = false;

      if (!isBuiltInDesktopCloudImageModel(modelId)) {
        return c.json(
          {
            ok: false,
            modelId,
            configPushed,
            error: `当前不支持生图模型 ${modelId}。`,
          },
          200,
        );
      }

      const cloudStatus = await container.desktopLocalService.getCloudStatus();
      if (
        !cloudStatus.connected ||
        typeof cloudStatus.linkUrl !== "string" ||
        cloudStatus.linkUrl.length === 0
      ) {
        const result = await container.openclawSyncService.syncAllImmediate();
        configPushed = result.configPushed;
        return c.json(
          {
            ok: false,
            modelId,
            configPushed,
            error: "生图模型需要先登录或刷新 Claw-Pi 官方服务。",
          },
          200,
        );
      }

      await container.desktopLocalService.setDefaultImageGenerationModel(
        modelId,
      );
      if (!configPushed) {
        const result = await container.openclawSyncService.syncAllImmediate();
        configPushed = result.configPushed;
      }
      return c.json({ ok: true, modelId, configPushed }, 200);
    },
  );
}
