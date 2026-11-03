import { parse } from "superjson";

import type { Session } from "@homarr/auth";
import type { Database } from "@homarr/db";
import { eq } from "@homarr/db";
import { boards } from "@homarr/db/schema";
import type { ViewerScopingMode, WidgetKind } from "@homarr/definitions";

import { isActionAllowedAsync } from "../router/board/board-access";
import { isIntegrationActionAllowedAsync } from "../router/integration/integration-access";

export type WidgetScope = "mine" | "everyone";
export type ScopeDecision = { scope: WidgetScope } | { forbidden: true };

const forbidden: ScopeDecision = { forbidden: true };

interface DecideScopeInput {
  integration: { id: string; viewerScoping: ViewerScopingMode };
  widgetKind: WidgetKind;
  itemId?: string;
  requestedScope: WidgetScope;
}

/**
 * Decides whether the request reads the integration as the viewer or as everyone.
 * With an item, the scope saved on the item wins and the requested scope is ignored,
 * so a viewer cannot widen the data by forging the widget options.
 */
export const decideScopeAsync = async (
  ctx: { db: Database; session: Session | null },
  input: DecideScopeInput,
): Promise<ScopeDecision> => {
  if (input.integration.viewerScoping === "off") return { scope: "everyone" };

  if (input.itemId !== undefined) return await decideFromSavedItemAsync(ctx, input, input.itemId);

  if (input.requestedScope === "mine") return { scope: "mine" };

  const canInteract = await isIntegrationActionAllowedAsync(ctx, input.integration.id, "interact");
  return canInteract ? { scope: "everyone" } : forbidden;
};

const decideFromSavedItemAsync = async (
  ctx: { db: Database; session: Session | null },
  input: DecideScopeInput,
  itemId: string,
): Promise<ScopeDecision> => {
  const item = await ctx.db.query.items.findFirst({
    where: (items, { eq: equals }) => equals(items.id, itemId),
    with: { integrations: true },
  });
  if (!item) return forbidden;
  if (item.kind !== input.widgetKind) return forbidden;
  if (!item.integrations.some(({ integrationId }) => integrationId === input.integration.id)) return forbidden;
  if (!(await isActionAllowedAsync(ctx, eq(boards.id, item.boardId), "view"))) return forbidden;

  return parseSavedScope(item.options);
};

const parseSavedScope = (options: string): ScopeDecision => {
  let parsed: unknown;
  try {
    parsed = parse(options);
  } catch {
    return forbidden;
  }
  if (typeof parsed !== "object" || parsed === null) return forbidden;

  // Items saved before the scope option existed have none, which means everyone.
  const scope = (parsed as { scope?: unknown }).scope;
  if (scope === undefined) return { scope: "everyone" };
  if (scope === "mine" || scope === "everyone") return { scope };
  return forbidden;
};
