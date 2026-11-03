import type { Session } from "@homarr/auth";
import type { Database } from "@homarr/db";
import { and, inArray, ne } from "@homarr/db";
import { integrations } from "@homarr/db/schema";

import { throwIfIntegrationActionsForbiddenAsync } from "../router/integration/integration-access";
import type { WidgetScope } from "./decide-scope";

export interface ScopedItemConfiguration {
  id: string;
  kind: string;
  options: Record<string, unknown>;
  integrationIds: readonly string[];
}

const getSavedScope = (item: Pick<ScopedItemConfiguration, "kind" | "options">): WidgetScope | null => {
  switch (item.kind) {
    case "mediaServer":
    case "mediaRequests-requestList":
      // Matches decide-scope: anything other than "mine" is read as everyone or refused.
      return item.options.scope === "mine" ? "mine" : "everyone";
    case "mediaRequests-requestStats":
      return "everyone";
    default:
      return null;
  }
};

const haveSameIntegrationIds = (left: readonly string[], right: readonly string[]) => {
  if (left.length !== right.length) return false;
  const sortedRight = right.toSorted();
  return left.toSorted().every((integrationId, index) => integrationId === sortedRight[index]);
};

/**
 * Requires interact on each viewer-scoped integration of an item that shows everyone's data,
 * when the item is new or its kind, scope or integrations changed.
 * A saved everyone item is served to anyone who can view its board, so only someone allowed
 * to read everyone's data may create one.
 */
export const throwIfEveryoneScopeForbiddenAsync = async (
  ctx: { db: Database; session: Session | null },
  submittedItems: readonly ScopedItemConfiguration[],
  storedItems: readonly ScopedItemConfiguration[] = [],
) => {
  const storedItemsById = new Map(storedItems.map((item) => [item.id, item]));
  const candidateIntegrationIds = submittedItems.flatMap((item) => {
    if (getSavedScope(item) !== "everyone") return [];

    const storedItem = storedItemsById.get(item.id);
    const isUnchanged =
      storedItem !== undefined &&
      storedItem.kind === item.kind &&
      getSavedScope(storedItem) === "everyone" &&
      haveSameIntegrationIds(storedItem.integrationIds, item.integrationIds);
    return isUnchanged ? [] : item.integrationIds;
  });

  const uniqueIntegrationIds = [...new Set(candidateIntegrationIds)];
  if (uniqueIntegrationIds.length === 0) return;

  const scopedIntegrations = await ctx.db.query.integrations.findMany({
    columns: { id: true },
    where: and(inArray(integrations.id, uniqueIntegrationIds), ne(integrations.viewerScoping, "off")),
  });

  await throwIfIntegrationActionsForbiddenAsync(
    ctx,
    scopedIntegrations.map(({ id }) => id),
    "interact",
  );
};
