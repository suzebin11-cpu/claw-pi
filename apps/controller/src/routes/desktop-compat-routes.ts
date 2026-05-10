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
import { resolveModelId } from "../lib/openclaw-config-compiler.js";
import type { ControllerBindings } from "../types.js";

const defaultModelBodySchema = z.object({ modelId: z.string() });
const defaultModelResponseSchema = z.object({ modelId: z.string().nullable() });
const defaultModelSetResponseSchema = z.object({
  ok: z.boolean(),
  modelId: z.string(),
  configPushed: z.boolean(),
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
      const { configPushed } = await container.openclawSyncService.syncAll();
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
      const { configPushed } = await container.openclawSyncService.syncAll();
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
      await container.desktopLocalService.setDefaultModel(body.modelId);
      // Update the runtime-model state file only — this is what the
      // `nexu-runtime-model` plugin reads to override per-turn model
      // resolution. We deliberately do not push a fresh openclaw.json:
      // rewriting agents.defaults.model.primary causes OpenClaw to treat
      // it as a config change and restart every active channel monitor
      // (Feishu / WeChat), which surfaces in the UI as a long
      // "connecting" / "数据同步中" stall every time someone switches
      // models. The next natural sync (provider/skill/bot change, restart,
      // …) will eventually flush the new primary into openclaw.json.
      await container.openclawSyncService.syncRuntimeModelOnly();
      return c.json(
        { ok: true, modelId: body.modelId, configPushed: false },
        200,
      );
    },
  );
}
