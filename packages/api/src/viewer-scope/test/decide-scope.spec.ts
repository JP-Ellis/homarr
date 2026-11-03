// @vitest-environment node

import { stringify } from "superjson";
import { describe, expect, test } from "vitest";

import type { Session } from "@homarr/auth";
import { createId } from "@homarr/common";
import {
  boards,
  boardUserPermissions,
  groupMembers,
  groups,
  integrationGroupPermissions,
  integrationItems,
  integrations,
  integrationUserPermissions,
  items,
  users,
} from "@homarr/db/schema";
import { createDb } from "@homarr/db/test";
import type { ViewerScopingMode, WidgetKind } from "@homarr/definitions";

import { decideScopeAsync } from "../decide-scope";

const createSession = (userId: string, permissions: Session["user"]["permissions"] = []): Session => ({
  user: { id: userId, permissions, colorScheme: "light" },
  expires: new Date().toISOString(),
});

interface SetupOptions {
  scope?: "mine" | "everyone" | null;
  isPublic?: boolean;
  options?: string;
}

const setupAsync = async ({ scope = "mine", isPublic = false, options }: SetupOptions = {}) => {
  const db = createDb();
  const ownerId = createId();
  const viewerId = createId();
  await db.insert(users).values([
    { id: ownerId, name: "owner" },
    { id: viewerId, name: "viewer" },
  ]);

  const integrationId = createId();
  await db.insert(integrations).values({
    id: integrationId,
    name: "Jellyfin",
    kind: "jellyfin",
    url: "http://jellyfin.local",
    viewerScoping: "username",
  });

  const boardId = createId();
  await db.insert(boards).values({ id: boardId, name: "board", isPublic, creatorId: ownerId });

  const itemId = createId();
  await db.insert(items).values({
    id: itemId,
    boardId,
    kind: "mediaRequests-requestList",
    options: options ?? stringify(scope === null ? {} : { scope }),
  });
  await db.insert(integrationItems).values({ itemId, integrationId });

  const integration = { id: integrationId, viewerScoping: "username" as ViewerScopingMode };
  const viewerContext = { db, session: createSession(viewerId) };
  const decideAsync = (
    input: { itemId?: string; requestedScope: "mine" | "everyone"; widgetKind?: WidgetKind },
    context: { db: typeof db; session: Session | null } = viewerContext,
  ) => decideScopeAsync(context, { integration, widgetKind: "mediaRequests-requestList", ...input });

  const grantBoardView = () =>
    db.insert(boardUserPermissions).values({ boardId, userId: viewerId, permission: "view" });
  const grantIntegration = (permission: "use" | "interact") =>
    db.insert(integrationUserPermissions).values({ integrationId, userId: viewerId, permission });

  return {
    db,
    integration,
    integrationId,
    itemId,
    boardId,
    viewerId,
    viewerContext,
    decideAsync,
    grantBoardView,
    grantIntegration,
  };
};

describe("decideScopeAsync", () => {
  test("saved mine item wins over forged everyone", async () => {
    const { decideAsync, itemId, grantBoardView } = await setupAsync({ scope: "mine" });
    await grantBoardView();

    expect(await decideAsync({ itemId, requestedScope: "everyone" })).toEqual({ scope: "mine" });
  });

  test("saved everyone item is everyone for a plain board viewer", async () => {
    const { decideAsync, itemId, grantBoardView } = await setupAsync({ scope: "everyone" });
    await grantBoardView();

    expect(await decideAsync({ itemId, requestedScope: "mine" })).toEqual({ scope: "everyone" });
  });

  test("saved item without a scope is everyone", async () => {
    const { decideAsync, itemId, grantBoardView } = await setupAsync({ scope: null });
    await grantBoardView();

    expect(await decideAsync({ itemId, requestedScope: "mine" })).toEqual({ scope: "everyone" });
  });

  test("saved item with unparsable options is forbidden", async () => {
    const { decideAsync, itemId, grantBoardView } = await setupAsync({ options: "{not json" });
    await grantBoardView();

    expect(await decideAsync({ itemId, requestedScope: "everyone" })).toEqual({ forbidden: true });
  });

  test("saved item with an unknown scope value is forbidden", async () => {
    const { decideAsync, itemId, grantBoardView } = await setupAsync({
      options: stringify({ scope: "admin" }),
    });
    await grantBoardView();

    expect(await decideAsync({ itemId, requestedScope: "everyone" })).toEqual({ forbidden: true });
  });

  test("item on a board the caller can't view is forbidden", async () => {
    const { decideAsync, itemId } = await setupAsync({ scope: "everyone" });

    expect(await decideAsync({ itemId, requestedScope: "everyone" })).toEqual({ forbidden: true });
  });

  test("unknown item is forbidden", async () => {
    const { decideAsync } = await setupAsync();

    expect(await decideAsync({ itemId: createId(), requestedScope: "mine" })).toEqual({ forbidden: true });
  });

  test("item of another widget kind is forbidden", async () => {
    const { decideAsync, itemId, grantBoardView } = await setupAsync({ scope: "mine" });
    await grantBoardView();

    expect(await decideAsync({ itemId, requestedScope: "mine", widgetKind: "clock" })).toEqual({ forbidden: true });
  });

  test("item not linked to this integration is forbidden", async () => {
    const { db, decideAsync, itemId, grantBoardView } = await setupAsync({ scope: "mine" });
    await grantBoardView();
    await db.delete(integrationItems);

    expect(await decideAsync({ itemId, requestedScope: "mine" })).toEqual({ forbidden: true });
  });

  test("no item, mine passes", async () => {
    const { decideAsync } = await setupAsync();

    expect(await decideAsync({ requestedScope: "mine" })).toEqual({ scope: "mine" });
  });

  test("no item, everyone with interact passes", async () => {
    const { decideAsync, grantIntegration } = await setupAsync();
    await grantIntegration("interact");

    expect(await decideAsync({ requestedScope: "everyone" })).toEqual({ scope: "everyone" });
  });

  test("no item, everyone with interact through a group passes", async () => {
    const { db, decideAsync, viewerId, integrationId } = await setupAsync();
    const groupId = createId();
    await db.insert(groups).values({ id: groupId, name: "family", position: 1 });
    await db.insert(groupMembers).values({ groupId, userId: viewerId });
    await db.insert(integrationGroupPermissions).values({ integrationId, groupId, permission: "interact" });

    expect(await decideAsync({ requestedScope: "everyone" })).toEqual({ scope: "everyone" });
  });

  test("no item, everyone with global interact passes", async () => {
    const { db, decideAsync, viewerId } = await setupAsync();

    expect(
      await decideAsync(
        { requestedScope: "everyone" },
        { db, session: createSession(viewerId, ["integration-interact-all"]) },
      ),
    ).toEqual({ scope: "everyone" });
  });

  test("no item, everyone with use only is forbidden", async () => {
    const { decideAsync, grantIntegration } = await setupAsync();
    await grantIntegration("use");

    expect(await decideAsync({ requestedScope: "everyone" })).toEqual({ forbidden: true });
  });

  test("no item, everyone without any permission is forbidden", async () => {
    const { decideAsync } = await setupAsync();

    expect(await decideAsync({ requestedScope: "everyone" })).toEqual({ forbidden: true });
  });

  test("anonymous viewer of a public board gets the saved scope", async () => {
    const { db, decideAsync, itemId } = await setupAsync({ scope: "mine", isPublic: true });

    expect(await decideAsync({ itemId, requestedScope: "everyone" }, { db, session: null })).toEqual({ scope: "mine" });
  });

  test("anonymous viewer of a private board is forbidden", async () => {
    const { db, decideAsync, itemId } = await setupAsync({ scope: "everyone" });

    expect(await decideAsync({ itemId, requestedScope: "everyone" }, { db, session: null })).toEqual({
      forbidden: true,
    });
  });

  test("anonymous viewer without an item can't ask for everyone", async () => {
    const { db, decideAsync } = await setupAsync();

    expect(await decideAsync({ requestedScope: "everyone" }, { db, session: null })).toEqual({ forbidden: true });
  });

  test("scoping off returns everyone even for a saved mine item", async () => {
    const { integration, itemId, viewerContext } = await setupAsync({ scope: "mine" });

    const decision = await decideScopeAsync(viewerContext, {
      integration: { ...integration, viewerScoping: "off" },
      widgetKind: "clock",
      itemId,
      requestedScope: "mine",
    });

    expect(decision).toEqual({ scope: "everyone" });
  });
});
