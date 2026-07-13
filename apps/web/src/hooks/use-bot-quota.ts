import { useQuery } from "@tanstack/react-query";
import { getApiV1BotQuota } from "../../lib/api/sdk.gen";

export function useBotQuota() {
  const { data, isLoading } = useQuery({
    queryKey: ["bot-quota"],
    queryFn: async () => {
      const { data } = await getApiV1BotQuota();
      return data;
    },
    staleTime: 30_000,
  });

  return {
    available: data?.available ?? true,
    resetsAt: data?.resetsAt ?? "",
    isLoading,
  };
}
