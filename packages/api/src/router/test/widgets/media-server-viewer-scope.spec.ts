// @vitest-environment node

import { stringify } from "superjson";
import { beforeEach, describe, expect, test, vi } from "vitest";

import type { Session } from "@homarr/auth";
import { createId } from "@homarr/common";
import { boards, integrationItems, integrations, integrationUserPermissions, items, users } from "@homarr/db/schema";
import { createDb } from "@homarr/db/test";
import type { ViewerScopingMode } from "@homarr/definitions";

import { mediaServerRouter } from "../../widgets/media-server";

vi.hoisted(() => {
  process.env.SKIP_ENV_VALIDATION = "true";
});

const handlerInputs = vi.hoisted(() => [] as unknown[]);
const resolveViewerMock = vi.hoisted(() => vi.fn());
const failingIntegrationIds = vi.hoisted(() => new Set<string>());

const sessionsOf = (userId: string) => ({ sessionId: `session-${userId}`, user: { userId, username: userId } });

vi.mock("@homarr/request-handler/media-server", () => ({
  mediaServerRequestHandler: {
    handler: (integration: { id: string }, input: unknown) => {
      handlerInputs.push(input);
      return {
        getDataAsync: () =>
          failingIntegrationIds.has(integration.id)
            ? Promise.reject(new Error("Service unavailable"))
            : Promise.resolve({ data: [sessionsOf("u1"), sessionsOf("u2"), { sessionId: "anonymous" }] }),
      };
    },
  },
}));

vi.mock("../../../viewer-scope/resolve-viewer", () => ({
  resolveViewerAsync: resolveViewerMock,
}));

const createSession = (userId: string): Session => ({
  user: { id: userId, permissions: [], colorScheme: "light" },
  expires: new Date().toISOString(),
});

const setupAsync = async (modes: ViewerScopingMode[] = ["username"]) => {
  const db = createDb();
  const ownerId = createId();
  const viewerId = createId();
  await db.insert(users).values([
    { id: ownerId, name: "owner" },
    { id: viewerId, name: "viewer" },
  ]);

  const integrationIds: string[] = [];
  for (const viewerScoping of modes) {
    const id = createId();
    integrationIds.push(id);
    await db
      .insert(integrations)
      .values({ id, name: `plex-${id}`, kind: "plex", url: "http://plex.local", viewerScoping });
    await db.insert(integrationUserPermissions).values({ integrationId: id, userId: viewerId, permission: "use" });
  }

  const boardId = createId();
  await db.insert(boards).values({ id: boardId, name: "board", isPublic: true, creatorId: ownerId });

  const createItemAsync = async (options: object) => {
    const itemId = createId();
    await db.insert(items).values({ id: itemId, boardId, kind: "mediaServer", options: stringify(options) });
    await db.insert(integrationItems).values(integrationIds.map((integrationId) => ({ itemId, integrationId })));
    return itemId;
  };

  const caller = mediaServerRouter.createCaller({ db, deviceType: undefined, session: createSession(viewerId) });
  return { db, viewerId, integrationIds, createItemAsync, caller };
};

const findRow = <TRow extends { integrationId: string }>(rows: TRow[], integrationId: string | undefined): TRow => {
  const row = rows.find((candidate) => candidate.integrationId === integrationId);
  if (!row) throw new Error(`No row for integration ${integrationId}`);
  return row;
};

const userIdsOf = (row: { sessions: { user?: { userId: string } }[] }) => row.sessions.map(({ user }) => user?.userId);

describe("mediaServer.getCurrentStreams viewer scope", () => {
  beforeEach(() => {
    handlerInputs.length = 0;
    failingIntegrationIds.clear();
    resolveViewerMock.mockReset();
  });

  test("mine returns only the viewer's sessions", async () => {
    const { caller, integrationIds } = await setupAsync();
    resolveViewerMock.mockResolvedValue({ status: "matched", externalUserId: "u1" });

    const rows = await caller.getCurrentStreams({ integrationIds, showOnlyPlaying: true, scope: "mine" });
    const row = findRow(rows, integrationIds[0]);

    expect(userIdsOf(row)).toEqual(["u1"]);
    expect(row.viewerUnlinked).toBe(false);
    expect(row.error).toBeUndefined();
  });

  test("saved mine item ignores forged everyone", async () => {
    const { caller, integrationIds, createItemAsync } = await setupAsync();
    const itemId = await createItemAsync({ scope: "mine" });
    resolveViewerMock.mockResolvedValue({ status: "matched", externalUserId: "u2" });

    const rows = await caller.getCurrentStreams({ integrationIds, showOnlyPlaying: true, scope: "everyone", itemId });
    const row = findRow(rows, integrationIds[0]);

    expect(userIdsOf(row)).toEqual(["u2"]);
  });

  test("unlinked viewer gets empty sessions and viewerUnlinked", async () => {
    const { caller, integrationIds } = await setupAsync();
    resolveViewerMock.mockResolvedValue({ status: "unlinked" });

    const rows = await caller.getCurrentStreams({ integrationIds, showOnlyPlaying: true, scope: "mine" });
    const row = findRow(rows, integrationIds[0]);

    expect(row.sessions).toEqual([]);
    expect(row.viewerUnlinked).toBe(true);
    expect(row.error).toBeUndefined();
  });

  test("scoping off returns all sessions", async () => {
    const { caller, integrationIds } = await setupAsync(["off"]);

    const rows = await caller.getCurrentStreams({ integrationIds, showOnlyPlaying: true, scope: "mine" });
    const row = findRow(rows, integrationIds[0]);

    expect(row.sessions).toHaveLength(3);
    expect(row.viewerUnlinked).toBe(false);
    expect(resolveViewerMock).not.toHaveBeenCalled();
    expect(handlerInputs).toEqual([{ showOnlyPlaying: true }]);
  });

  test("two integrations, one scoped one not, evaluated separately", async () => {
    const { caller, integrationIds } = await setupAsync(["username", "off"]);
    resolveViewerMock.mockResolvedValue({ status: "matched", externalUserId: "u1" });

    const rows = await caller.getCurrentStreams({ integrationIds, showOnlyPlaying: true, scope: "mine" });

    const scopedRow = findRow(rows, integrationIds[0]);
    const unscopedRow = findRow(rows, integrationIds[1]);
    expect(userIdsOf(scopedRow)).toEqual(["u1"]);
    expect(unscopedRow.sessions).toHaveLength(3);
    expect(resolveViewerMock).toHaveBeenCalledTimes(1);
  });

  test("scopeIgnored marks only mine on an integration with scoping off", async () => {
    const { caller, integrationIds } = await setupAsync(["username", "off"]);
    resolveViewerMock.mockResolvedValue({ status: "matched", externalUserId: "u1" });

    const mineRows = await caller.getCurrentStreams({ integrationIds, showOnlyPlaying: true, scope: "mine" });
    const everyoneRows = await caller.getCurrentStreams({
      integrationIds: integrationIds.slice(1),
      showOnlyPlaying: true,
      scope: "everyone",
    });

    expect(findRow(mineRows, integrationIds[0]).scopeIgnored).toBe(false);
    expect(findRow(mineRows, integrationIds[1]).scopeIgnored).toBe(true);
    expect(findRow(everyoneRows, integrationIds[1]).scopeIgnored).toBe(false);
  });

  test("a failed unscoped integration does not report scopeIgnored", async () => {
    const { caller, integrationIds } = await setupAsync(["username", "off"]);
    resolveViewerMock.mockResolvedValue({ status: "matched", externalUserId: "u1" });
    failingIntegrationIds.add(integrationIds[1] ?? "");

    const rows = await caller.getCurrentStreams({ integrationIds, showOnlyPlaying: true, scope: "mine" });
    const failedRow = findRow(rows, integrationIds[1]);

    expect(failedRow.error).toBe("INTEGRATION_REQUEST_FAILED");
    expect(failedRow.scopeIgnored).toBe(false);
  });

  test("preview everyone without interact marks integration failed", async () => {
    const { caller, integrationIds } = await setupAsync(["username", "off"]);

    const rows = await caller.getCurrentStreams({ integrationIds, showOnlyPlaying: true, scope: "everyone" });

    const scopedRow = findRow(rows, integrationIds[0]);
    const unscopedRow = findRow(rows, integrationIds[1]);
    expect(scopedRow).toMatchObject({ sessions: [], viewerUnlinked: false, error: "INTEGRATION_REQUEST_FAILED" });
    expect(unscopedRow.sessions).toHaveLength(3);
    expect(resolveViewerMock).not.toHaveBeenCalled();
  });
});
