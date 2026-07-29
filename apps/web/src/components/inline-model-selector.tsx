import {
  resolveBackendModelId,
  resolveDisplayModelId,
  subscribeModelDisplayChoice,
  withDisplayAliasModels,
} from "@/lib/model-display-alias";
import { track } from "@/lib/tracking";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  getApiInternalDesktopDefaultModel,
  getApiV1Models,
  putApiInternalDesktopDefaultModel,
} from "../../lib/api/sdk.gen";
import { ModelPickerDropdown } from "./model-picker-dropdown";

/**
 * Inline Model Selector for Hero status bar
 *
 * A compact dropdown that shows the current model and allows switching.
 * Reuses the same data flow as the Models page.
 */

interface Model {
  id: string;
  name: string;
  provider: string;
  isDefault?: boolean;
  description?: string;
}

function getProviderIdFromModelId(
  models: Model[],
  modelId: string,
): string | null {
  const matched = models.find((model) => model.id === modelId);
  if (matched) {
    return matched.provider;
  }
  const [provider] = modelId.split("/");
  return provider || null;
}

export function InlineModelSelector() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  // Fetch current model
  const { data: defaultModelData } = useQuery({
    queryKey: ["desktop-default-model"],
    queryFn: async () => {
      const { data } = await getApiInternalDesktopDefaultModel();
      return data as { modelId: string | null } | undefined;
    },
  });

  // Fetch available models
  const { data: modelsData } = useQuery({
    queryKey: ["models"],
    queryFn: async () => {
      const { data } = await getApiV1Models();
      return data;
    },
  });

  const models = withDisplayAliasModels((modelsData?.models ?? []) as Model[]);
  // Re-render when the display-alias choice changes on another page so the
  // shown model (e.g. GPT-5.6) stays in sync across 龙虾窝 / 问答 / 模型广场.
  const [, forceRerender] = useState(0);
  useEffect(
    () => subscribeModelDisplayChoice(() => forceRerender((n) => n + 1)),
    [],
  );
  const currentModelId = resolveDisplayModelId(defaultModelData?.modelId ?? "");
  const emptyModelLabel = t("models.noModelConfigured");

  // Update model mutation
  const updateModel = useMutation({
    mutationFn: async (modelId: string) => {
      const backendModelId = resolveBackendModelId(modelId);
      const toastId = toast.loading(t("models.switchingModel"));
      const { data, error } = await putApiInternalDesktopDefaultModel({
        body: { modelId: backendModelId },
      });
      if (error) {
        const message =
          typeof error === "object" &&
          error !== null &&
          "error" in error &&
          typeof error.error === "string"
            ? error.error
            : t("models.modelSwitchFailed");
        toast.error(message, { id: toastId });
        throw new Error(message);
      }
      if (data?.ok === false) {
        const message = data.error ?? t("models.modelSwitchFailed");
        toast.error(message, { id: toastId });
        throw new Error(message);
      }
      return { toastId };
    },
    onSuccess: async ({ toastId }, modelId) => {
      track("workspace_change_model_change", {
        previous_provider_name: getProviderIdFromModelId(
          models,
          currentModelId,
        ),
        previous_model_name: currentModelId || null,
        provider_name: getProviderIdFromModelId(models, modelId),
        model_name: modelId,
      });
      await queryClient.refetchQueries({ queryKey: ["desktop-default-model"] });
      queryClient.invalidateQueries({ queryKey: ["channels-live-status"] });
      toast.success(t("models.modelSwitched"), { id: toastId });
    },
  });

  return (
    <ModelPickerDropdown
      compact
      confirmSwitch
      models={models}
      currentModelId={currentModelId}
      emptyLabel={emptyModelLabel}
      onSelectModel={(modelId) => updateModel.mutate(modelId)}
      onOpenSettings={() => {}}
    />
  );
}
