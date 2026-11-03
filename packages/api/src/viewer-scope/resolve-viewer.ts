import type { Session } from "@homarr/auth";
import type { Database } from "@homarr/db";
import { and, eq } from "@homarr/db";
import { integrationViewerMappings, users } from "@homarr/db/schema";
import type { IntegrationKind, ViewerScopingMode } from "@homarr/definitions";
import type { IntegrationInput } from "@homarr/integrations";
import { createIntegrationAsync } from "@homarr/integrations";
import type { ViewerScopeUser } from "@homarr/integrations/types";
import { isViewerScopeIntegration } from "@homarr/integrations/types";

import type { ViewerResolution } from "./match-viewer";
import { matchViewer } from "./match-viewer";

export type { ViewerResolution } from "./match-viewer";

const cacheTimeToLiveInMilliseconds = 5 * 60 * 1000;

interface CacheEntry<TValue> {
  value: TValue;
  expiresAt: number;
}

const resolutionCache = new Map<string, CacheEntry<ViewerResolution> & { mode: ViewerScopingMode }>();
const userListCache = new Map<string, CacheEntry<Promise<ViewerScopeUser[]>>>();

const unlinked: ViewerResolution = { status: "unlinked" };

type ViewerScopedIntegration = IntegrationInput & { kind: IntegrationKind; viewerScoping: ViewerScopingMode };

const getUserListAsync = (integration: ViewerScopedIntegration): Promise<ViewerScopeUser[] | null> => {
  const cached = userListCache.get(integration.id);
  if (cached && cached.expiresAt > Date.now()) return cached.value.then((list) => list);

  const request = (async () => {
    const instance = await createIntegrationAsync(integration);
    if (!isViewerScopeIntegration(instance)) return null;
    return await instance.listViewerScopeUsersAsync();
  })();
  const entry = { value: request as Promise<ViewerScopeUser[]>, expiresAt: Date.now() + cacheTimeToLiveInMilliseconds };
  userListCache.set(integration.id, entry);
  // Failures are not cached, so the next request retries.
  request.catch(() => {
    if (userListCache.get(integration.id) === entry) userListCache.delete(integration.id);
  });
  return request;
};

/**
 * Resolves which user of the integration the signed-in viewer is.
 * A failure to list the integration's users propagates, so the caller never falls back to unfiltered data.
 */
export const resolveViewerAsync = async (
  db: Database,
  integration: ViewerScopedIntegration,
  session: Session | null,
): Promise<ViewerResolution> => {
  if (!session) return unlinked;
  const userId = session.user.id;

  const override = await db.query.integrationViewerMappings.findFirst({
    where: and(
      eq(integrationViewerMappings.integrationId, integration.id),
      eq(integrationViewerMappings.userId, userId),
    ),
  });
  if (override) return { status: "matched", externalUserId: override.externalUserId };

  if (integration.viewerScoping === "off") return unlinked;

  const cacheKey = `${integration.id}:${userId}`;
  const cached = resolutionCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() && cached.mode === integration.viewerScoping) return cached.value;

  const viewer = await db.query.users.findFirst({
    columns: { name: true, email: true, provider: true },
    where: eq(users.id, userId),
  });
  if (!viewer) return unlinked;

  const userList = await getUserListAsync(integration);
  const resolution = userList ? matchViewer(viewer, integration.viewerScoping, userList) : unlinked;

  resolutionCache.set(cacheKey, {
    value: resolution,
    mode: integration.viewerScoping,
    expiresAt: Date.now() + cacheTimeToLiveInMilliseconds,
  });
  return resolution;
};

/** Without a user ID, every entry of the integration is dropped, including its cached user list. */
export const clearViewerResolutionCache = (integrationId: string, userId?: string): void => {
  if (userId !== undefined) {
    resolutionCache.delete(`${integrationId}:${userId}`);
    return;
  }
  for (const key of resolutionCache.keys()) {
    if (key.startsWith(`${integrationId}:`)) resolutionCache.delete(key);
  }
  userListCache.delete(integrationId);
};
