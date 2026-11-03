// @vitest-environment node

import { stringify } from "superjson";
import { beforeEach, describe, expect, test, vi } from "vitest";

import type { Session } from "@homarr/auth";
import { createId } from "@homarr/common";
import { boards, integrationItems, integrations, integrationUserPermissions, items, users } from "@homarr/db/schema";
import { createDb } from "@homarr/db/test";
import type { ViewerScopingMode } from "@homarr/definitions";

import { mediaRequestsRouter } from "../../widgets/media-requests";

vi.hoisted(() => {
  process.env.SKIP_ENV_VALIDATION = "true";
});

const handlerInputs = vi.hoisted(() => [] as unknown[]);
const resolveViewerMock = vi.hoisted(() => vi.fn());

const requestOf = (id: number, requesterId: number | undefined) => ({
  id,
  name: `request-${id}`,
  status: "pending",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  requestedBy: requesterId === undefined ? undefined : { id: requesterId, displayName: `user-${requesterId}` },
});

vi.mock("@homarr/request-handler/media-request-list", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@homarr/request-handler/media-request-list")>()),
  mediaRequestListRequestHandler: {
    handler: (_integration: unknown, input: unknown) => {
      handlerInputs.push(input);
      return {
        getDataAsync: () => Promise.resolve({ data: [requestOf(1, 7), requestOf(2, 8), requestOf(3, undefined)] }),
      };
    },
  },
}));

vi.mock("@homarr/request-handler/media-request-stats", () => ({
  mediaRequestStatsRequestHandler: {
    handler: () => ({ getDataAsync: () => Promise.resolve({ data: { stats: { total: 1 }, users: [] } }) }),
  },
}));

vi.mock("../../../viewer-scope/resolve-viewer", () => ({
  resolveViewerAsync: resolveViewerMock,
}));

const createSession = (userId: string): Session => ({
  user: { id: userId, permissions: [], colorScheme: "light" },
  expires: new Date().toISOString(),
});

const setupAsync = async (viewerScoping: ViewerScopingMode = "username") => {
  const db = createDb();
  const ownerId = createId();
  const viewerId = createId();
  await db.insert(users).values([
    { id: ownerId, name: "owner" },
    { id: viewerId, name: "viewer" },
  ]);

  const createIntegrationAsync = async (mode: ViewerScopingMode) => {
    const id = createId();
    await db
      .insert(integrations)
      .values({ id, name: `seerr-${id}`, kind: "overseerr", url: "http://seerr.local", viewerScoping: mode });
    await db.insert(integrationUserPermissions).values({ integrationId: id, userId: viewerId, permission: "use" });
    return id;
  };
  const integrationId = await createIntegrationAsync(viewerScoping);
  const unscopedIntegrationId = await createIntegrationAsync("off");

  const boardId = createId();
  await db.insert(boards).values({ id: boardId, name: "board", isPublic: true, creatorId: ownerId });
  const itemId = createId();
  await db.insert(items).values({ id: itemId, boardId, kind: "mediaRequests-requestStats", options: stringify({}) });
  await db.insert(integrationItems).values({ itemId, integrationId });

  const caller = mediaRequestsRouter.createCaller({ db, deviceType: undefined, session: createSession(viewerId) });
  return { integrationId, unscopedIntegrationId, itemId, caller };
};

const listInput = (integrationId: string, scope?: "mine" | "everyone") => ({
  integrationIds: [integrationId],
  statuses: ["pending" as const],
  recentDays: 0,
  ...(scope ? { scope } : {}),
});

describe("mediaRequests viewer scope", () => {
  beforeEach(() => {
    handlerInputs.length = 0;
    resolveViewerMock.mockReset();
  });

  test("mine passes requestedBy to the handler", async () => {
    const { caller, integrationId } = await setupAsync();
    resolveViewerMock.mockResolvedValue({ status: "matched", externalUserId: "7" });

    const result = await caller.getLatestRequests(listInput(integrationId, "mine"));

    expect(handlerInputs).toEqual([
      { integrationIds: [integrationId], statuses: ["pending"], recentDays: 0, requestedBy: 7 },
    ]);
    expect(result.viewerUnlinked).toBe(false);
  });

  test("mine drops requests from other users even if the handler returns them", async () => {
    const { caller, integrationId } = await setupAsync();
    resolveViewerMock.mockResolvedValue({ status: "matched", externalUserId: "7" });

    const result = await caller.getLatestRequests(listInput(integrationId, "mine"));

    expect(result.requests.map(({ id }) => id)).toEqual([1]);
  });

  test("unlinked viewer gets no requests", async () => {
    const { caller, integrationId } = await setupAsync();
    resolveViewerMock.mockResolvedValue({ status: "unlinked" });

    const result = await caller.getLatestRequests(listInput(integrationId, "mine"));

    expect(result.requests).toEqual([]);
    expect(result.viewerUnlinked).toBe(true);
    expect(result.failedIntegrations).toEqual([]);
    expect(handlerInputs).toEqual([]);
  });

  test("scoping off keeps today's input", async () => {
    const { caller, integrationId } = await setupAsync("off");

    const result = await caller.getLatestRequests(listInput(integrationId, "mine"));

    expect(handlerInputs).toEqual([{ integrationIds: [integrationId], statuses: ["pending"], recentDays: 0 }]);
    expect(Object.keys(handlerInputs[0] as object)).not.toContain("requestedBy");
    expect(result.requests).toHaveLength(3);
    expect(result.viewerUnlinked).toBe(false);
    expect(resolveViewerMock).not.toHaveBeenCalled();
  });

  test("getStats via saved item is allowed for a board viewer", async () => {
    const { caller, integrationId, itemId } = await setupAsync();

    const result = await caller.getStats({ integrationIds: [integrationId], itemId });

    expect(result.failedIntegrations).toEqual([]);
    expect(result.stats).toHaveLength(1);
  });

  test("getStats without item and without interact is failed", async () => {
    const { caller, integrationId, unscopedIntegrationId } = await setupAsync();

    const result = await caller.getStats({ integrationIds: [integrationId, unscopedIntegrationId] });

    expect(result.failedIntegrations).toEqual([
      expect.objectContaining({ integrationId, error: "INTEGRATION_REQUEST_FAILED" }),
    ]);
    expect(result.stats).toHaveLength(1);
  });
});
