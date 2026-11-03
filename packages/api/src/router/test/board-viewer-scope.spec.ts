// @vitest-environment node

import { stringify } from "superjson";
import { describe, expect, test } from "vitest";

import type { Session } from "@homarr/auth";
import { createId } from "@homarr/common";
import { eq } from "@homarr/db";
import {
  boards,
  integrationItems,
  integrations,
  integrationUserPermissions,
  itemLayouts,
  items,
  layouts,
  sections,
  users,
} from "@homarr/db/schema";
import { createDb } from "@homarr/db/test";
import { getPermissionsWithChildren } from "@homarr/definitions";
import type {
  GroupPermissionKey,
  IntegrationKind,
  IntegrationPermission,
  ViewerScopingMode,
  WidgetKind,
} from "@homarr/definitions";

import { boardRouter } from "../board";
import { optionsRouter } from "../widgets/options";

const createSession = (userId: string, permissions: GroupPermissionKey[] = []): Session => ({
  user: { id: userId, permissions, colorScheme: "light" },
  expires: new Date(Date.now() + 60_000).toISOString(),
});

interface SetupOptions {
  integrationKind?: IntegrationKind;
  viewerScoping?: ViewerScopingMode;
  integrationPermission?: IntegrationPermission;
  sessionPermissions?: GroupPermissionKey[];
}

const setupAsync = async ({
  integrationKind = "jellyfin",
  viewerScoping = "username",
  integrationPermission = "use",
  sessionPermissions = ["board-create"],
}: SetupOptions = {}) => {
  const db = createDb();
  const userId = createId();
  await db.insert(users).values({ id: userId });

  const boardId = createId();
  await db.insert(boards).values({ id: boardId, name: "home", creatorId: userId });
  const layoutId = createId();
  await db.insert(layouts).values({ id: layoutId, name: "Base", boardId, columnCount: 12, breakpoint: 0 });
  const sectionId = createId();
  await db.insert(sections).values({ id: sectionId, boardId, kind: "empty", xOffset: 0, yOffset: 0 });

  const integrationId = createId();
  await db
    .insert(integrations)
    .values({ id: integrationId, name: "Media", kind: integrationKind, url: "http://media.local", viewerScoping });
  await db.insert(integrationUserPermissions).values({ integrationId, userId, permission: integrationPermission });

  const createItemAsync = async (kind: WidgetKind, options: object) => {
    const itemId = createId();
    await db.insert(items).values({ id: itemId, boardId, kind, options: stringify(options) });
    await db.insert(itemLayouts).values({ itemId, sectionId, layoutId, xOffset: 0, yOffset: 0, width: 1, height: 1 });
    await db.insert(integrationItems).values({ itemId, integrationId });
    return itemId;
  };

  const session = createSession(userId, sessionPermissions);
  const context = { db, deviceType: undefined, session };
  return {
    db,
    boardId,
    layoutId,
    sectionId,
    integrationId,
    createItemAsync,
    boardCaller: boardRouter.createCaller(context),
    optionsCaller: optionsRouter.createCaller(context),
  };
};

type Setup = Awaited<ReturnType<typeof setupAsync>>;

const saveSingleItemAsync = (
  setup: Setup,
  item: { id: string; kind: WidgetKind; options: Record<string, unknown>; integrationIds?: string[] },
) =>
  setup.boardCaller.saveBoard({
    id: setup.boardId,
    sections: [{ id: setup.sectionId, kind: "empty", xOffset: 0, yOffset: 0 }],
    items: [
      {
        id: item.id,
        kind: item.kind,
        options: item.options,
        integrationIds: item.integrationIds ?? [setup.integrationId],
        advancedOptions: { title: null, customCssClasses: [], borderColor: "" },
        layouts: [
          { layoutId: setup.layoutId, sectionId: setup.sectionId, xOffset: 0, yOffset: 0, width: 1, height: 1 },
        ],
      },
    ],
  });

const notFound = { code: "NOT_FOUND" };

describe("saveBoard everyone scope", () => {
  test("rejects a new everyone panel for a use-only user on a scoped integration", async () => {
    const setup = await setupAsync();

    await expect(
      saveSingleItemAsync(setup, {
        id: createId(),
        kind: "mediaServer",
        options: { scope: "everyone", showOnlyPlaying: true },
      }),
    ).rejects.toMatchObject(notFound);
    await expect(setup.db.$count(items)).resolves.toBe(0);
  });

  test("treats a new panel without a scope option as everyone", async () => {
    const setup = await setupAsync({ integrationKind: "overseerr" });

    await expect(
      saveSingleItemAsync(setup, { id: createId(), kind: "mediaRequests-requestList", options: {} }),
    ).rejects.toMatchObject(notFound);
  });

  test("rejects a new request stats panel for a use-only user on a scoped integration", async () => {
    const setup = await setupAsync({ integrationKind: "overseerr" });

    await expect(
      saveSingleItemAsync(setup, { id: createId(), kind: "mediaRequests-requestStats", options: {} }),
    ).rejects.toMatchObject(notFound);
  });

  test("rejects flipping a saved mine panel to everyone without interact", async () => {
    const setup = await setupAsync();
    const itemId = await setup.createItemAsync("mediaServer", { scope: "mine", showOnlyPlaying: true });

    await expect(
      saveSingleItemAsync(setup, {
        id: itemId,
        kind: "mediaServer",
        options: { scope: "everyone", showOnlyPlaying: true },
      }),
    ).rejects.toMatchObject(notFound);
    const storedItem = await setup.db.query.items.findFirst({ where: eq(items.id, itemId) });
    expect(storedItem?.options).toBe(stringify({ scope: "mine", showOnlyPlaying: true }));
  });

  test("keeps an unchanged saved everyone panel for a use-only user", async () => {
    const setup = await setupAsync();
    const itemId = await setup.createItemAsync("mediaServer", { scope: "everyone", showOnlyPlaying: true });

    await expect(
      saveSingleItemAsync(setup, {
        id: itemId,
        kind: "mediaServer",
        options: { scope: "everyone", showOnlyPlaying: false },
      }),
    ).resolves.toBeUndefined();
  });

  test("allows a use-only user to save a mine panel", async () => {
    const setup = await setupAsync();

    await expect(
      saveSingleItemAsync(setup, {
        id: createId(),
        kind: "mediaServer",
        options: { scope: "mine", showOnlyPlaying: true },
      }),
    ).resolves.toBeUndefined();
  });

  test("allows a user with interact to save an everyone panel", async () => {
    const setup = await setupAsync({ integrationPermission: "interact" });

    await expect(
      saveSingleItemAsync(setup, {
        id: createId(),
        kind: "mediaServer",
        options: { scope: "everyone", showOnlyPlaying: true },
      }),
    ).resolves.toBeUndefined();
  });

  test("allows an admin to save an everyone panel", async () => {
    const setup = await setupAsync({ sessionPermissions: getPermissionsWithChildren(["admin"]) });

    await expect(
      saveSingleItemAsync(setup, {
        id: createId(),
        kind: "mediaServer",
        options: { scope: "everyone", showOnlyPlaying: true },
      }),
    ).resolves.toBeUndefined();
  });

  test("leaves everyone panels on an unscoped integration to the use check", async () => {
    const setup = await setupAsync({ viewerScoping: "off" });

    await expect(
      saveSingleItemAsync(setup, {
        id: createId(),
        kind: "mediaServer",
        options: { scope: "everyone", showOnlyPlaying: true },
      }),
    ).resolves.toBeUndefined();
  });
});

describe("addItem everyone scope", () => {
  test("rejects an everyone panel for a use-only user on a scoped integration", async () => {
    const setup = await setupAsync();

    await expect(
      setup.boardCaller.addItem({
        boardId: setup.boardId,
        kind: "mediaServer",
        options: { scope: "everyone", showOnlyPlaying: true },
        integrationIds: [setup.integrationId],
      }),
    ).rejects.toMatchObject(notFound);
    await expect(setup.db.$count(items)).resolves.toBe(0);
  });

  test("allows a mine panel for a use-only user", async () => {
    const setup = await setupAsync();

    await expect(
      setup.boardCaller.addItem({
        boardId: setup.boardId,
        kind: "mediaServer",
        options: { scope: "mine", showOnlyPlaying: true },
        integrationIds: [setup.integrationId],
      }),
    ).resolves.toMatchObject({ itemId: expect.any(String) as string });
  });
});

describe("duplicateBoard everyone scope", () => {
  test("rejects copying an everyone panel for a use-only user", async () => {
    const setup = await setupAsync();
    await setup.createItemAsync("mediaServer", { scope: "everyone", showOnlyPlaying: true });

    await expect(setup.boardCaller.duplicateBoard({ id: setup.boardId, name: "copy" })).rejects.toMatchObject(notFound);
  });

  test("copies a mine panel for a use-only user", async () => {
    const setup = await setupAsync();
    await setup.createItemAsync("mediaServer", { scope: "mine", showOnlyPlaying: true });

    await expect(setup.boardCaller.duplicateBoard({ id: setup.boardId, name: "copy" })).resolves.toMatchObject({
      boardId: expect.any(String) as string,
    });
  });
});

describe("saveItemOptions everyone scope", () => {
  test("rejects flipping a saved mine panel to everyone without interact", async () => {
    const setup = await setupAsync({ integrationKind: "overseerr" });
    const itemId = await setup.createItemAsync("mediaRequests-requestList", { scope: "mine" });

    await expect(
      setup.optionsCaller.saveItemOptions({ itemId, boardId: setup.boardId, newOptions: { scope: "everyone" } }),
    ).rejects.toMatchObject(notFound);
  });

  test("allows a use-only user to change other options of an everyone panel", async () => {
    const setup = await setupAsync({ integrationKind: "overseerr" });
    const itemId = await setup.createItemAsync("mediaRequests-requestList", { scope: "everyone" });

    await expect(
      setup.optionsCaller.saveItemOptions({ itemId, boardId: setup.boardId, newOptions: { linksTargetNewTab: true } }),
    ).resolves.toBeUndefined();
  });
});
