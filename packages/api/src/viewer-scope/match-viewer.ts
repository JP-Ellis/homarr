import type { ViewerScopingMode } from "@homarr/definitions";
import type { ViewerScopeUser } from "@homarr/integrations/types";

export type ViewerResolution = { status: "matched"; externalUserId: string } | { status: "unlinked" };

const unlinked: ViewerResolution = { status: "unlinked" };

const automaticMatchProviders = new Set(["oidc", "ldap"]);

const normalise = (value: string | null | undefined) => {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : null;
};

/**
 * Finds the one integration user that corresponds to the viewer.
 * Anything other than exactly one distinct match is unlinked, because guessing would expose another user's data.
 * Empty values never match on either side.
 */
export const matchViewer = (
  viewer: { name: string | null; email: string | null; provider: string },
  mode: ViewerScopingMode,
  users: ViewerScopeUser[],
): ViewerResolution => {
  if (mode === "off") return unlinked;
  if (!automaticMatchProviders.has(viewer.provider)) return unlinked;

  const viewerValue = normalise(mode === "email" ? viewer.email : viewer.name);
  if (viewerValue === null) return unlinked;

  const matchedIds = new Set<string>();
  for (const user of users) {
    const candidates = mode === "email" ? [user.email] : user.usernames;
    if (candidates.some((candidate) => normalise(candidate) === viewerValue)) {
      matchedIds.add(user.id);
    }
  }

  const [externalUserId, ...rest] = matchedIds;
  if (externalUserId === undefined || rest.length > 0) return unlinked;
  return { status: "matched", externalUserId };
};
