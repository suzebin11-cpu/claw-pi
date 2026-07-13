export type AskActivityState = {
  pendingSessionIds: string[];
  unreadSessionIds: string[];
  lastSessionId?: string;
  lastTitle?: string;
  updatedAt: number;
};

const ASK_ACTIVITY_STORAGE_KEY = "claw-pi.ask.activity.v1";
export const ASK_ACTIVITY_EVENT = "claw-pi:ask-activity";

const PENDING_STALE_MS = 30 * 60 * 1000;

function uniqueIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  return Array.from(
    new Set(
      ids.filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  );
}

function normalizeAskActivity(input: unknown): AskActivityState {
  const now = Date.now();
  if (!input || typeof input !== "object") {
    return {
      pendingSessionIds: [],
      unreadSessionIds: [],
      updatedAt: now,
    };
  }

  const candidate = input as Partial<AskActivityState>;
  const updatedAt =
    typeof candidate.updatedAt === "number" ? candidate.updatedAt : now;
  const pendingSessionIds =
    now - updatedAt > PENDING_STALE_MS
      ? []
      : uniqueIds(candidate.pendingSessionIds);

  return {
    pendingSessionIds,
    unreadSessionIds: uniqueIds(candidate.unreadSessionIds),
    lastSessionId:
      typeof candidate.lastSessionId === "string"
        ? candidate.lastSessionId
        : undefined,
    lastTitle:
      typeof candidate.lastTitle === "string" ? candidate.lastTitle : undefined,
    updatedAt,
  };
}

export function readAskActivity(): AskActivityState {
  if (typeof window === "undefined") {
    return {
      pendingSessionIds: [],
      unreadSessionIds: [],
      updatedAt: Date.now(),
    };
  }

  try {
    return normalizeAskActivity(
      JSON.parse(window.localStorage.getItem(ASK_ACTIVITY_STORAGE_KEY) ?? "null"),
    );
  } catch {
    return {
      pendingSessionIds: [],
      unreadSessionIds: [],
      updatedAt: Date.now(),
    };
  }
}

function writeAskActivity(next: AskActivityState): AskActivityState {
  const normalized = normalizeAskActivity(next);
  if (typeof window !== "undefined") {
    window.localStorage.setItem(
      ASK_ACTIVITY_STORAGE_KEY,
      JSON.stringify(normalized),
    );
    window.dispatchEvent(
      new CustomEvent<AskActivityState>(ASK_ACTIVITY_EVENT, {
        detail: normalized,
      }),
    );
  }
  return normalized;
}

export function updateAskActivity(
  updater: (previous: AskActivityState) => AskActivityState,
): AskActivityState {
  return writeAskActivity(updater(readAskActivity()));
}

export function markAskReplyStarted(sessionId: string, title?: string) {
  updateAskActivity((previous) => ({
    ...previous,
    pendingSessionIds: Array.from(
      new Set([...previous.pendingSessionIds, sessionId]),
    ),
    lastSessionId: sessionId,
    lastTitle: title ?? previous.lastTitle,
    updatedAt: Date.now(),
  }));
}

export function markAskReplyFinished(input: {
  sessionId: string;
  title?: string;
  markUnread: boolean;
}) {
  updateAskActivity((previous) => ({
    ...previous,
    pendingSessionIds: previous.pendingSessionIds.filter(
      (id) => id !== input.sessionId,
    ),
    unreadSessionIds: input.markUnread
      ? Array.from(new Set([...previous.unreadSessionIds, input.sessionId]))
      : previous.unreadSessionIds,
    lastSessionId: input.sessionId,
    lastTitle: input.title ?? previous.lastTitle,
    updatedAt: Date.now(),
  }));
}

export function clearAskUnread(sessionId?: string) {
  updateAskActivity((previous) => ({
    ...previous,
    unreadSessionIds: sessionId
      ? previous.unreadSessionIds.filter((id) => id !== sessionId)
      : [],
    updatedAt: Date.now(),
  }));
}

export function subscribeAskActivity(
  listener: (state: AskActivityState) => void,
): () => void {
  if (typeof window === "undefined") return () => {};

  const handleActivity = (event: Event) => {
    const detail = (event as CustomEvent<AskActivityState>).detail;
    listener(normalizeAskActivity(detail));
  };
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== ASK_ACTIVITY_STORAGE_KEY) return;
    listener(readAskActivity());
  };

  window.addEventListener(ASK_ACTIVITY_EVENT, handleActivity);
  window.addEventListener("storage", handleStorage);

  return () => {
    window.removeEventListener(ASK_ACTIVITY_EVENT, handleActivity);
    window.removeEventListener("storage", handleStorage);
  };
}
