import { beforeEach, describe, expect, test, vi } from "vitest";

import type { Session } from "@homarr/auth";
import { createId } from "@homarr/common";
import { integrations, integrationViewerMappings, users } from "@homarr/db/schema";
import { createDb } from "@homarr/db/test";
import type { GroupPermissionKey } from "@homarr/definitions";

import type * as ResolveViewer from "../../../viewer-scope/resolve-viewer";
import { clearViewerResolutionCache } from "../../../viewer-scope/resolve-viewer";
import { integrationRouter } from "../../integration/integration-router";

const listViewerScopeUsersAsync = vi.hoisted(() => vi.fn());

vi.mock("@homarr/auth", () => ({ auth: () => ({}) as Session }));
vi.mock("@homarr/redis", () => ({ invalidateIntegrationCacheAsync: vi.fn() }));
vi.mock("../../integration/integration-test-connection", () => ({
  testConnectionAsync: async () => await Promise.resolve({ success: true }),
}));
vi.mock("@homarr/integrations", () => ({
  createIntegrationAsync: vi.fn(() => Promise.resolve({ listViewerScopeUsersAsync })),
}));
vi.mock("../../../viewer-scope/resolve-viewer", async (importOriginal) => {
  const original = await importOriginal<typeof ResolveViewer>();
  return { ...original, clearViewerResolutionCache: vi.fn(original.clearViewerResolutionCache) };
});

const integrationId = "integration-1";

const setup = (permissions: GroupPermissionKey[] = ["integration-full-all"]) => {
  const db = createDb();
  const session = {
    user: { id: createId(), permissions, colorScheme: "light" },
    expires: new Date().toISOString(),
  } satisfies Session;
  const caller = integrationRouter.createCaller({ db, deviceType: undefined, session });
  return { db, caller };
};

const insertIntegrationAsync = async (db: ReturnType<typeof createDb>) => {
  await db.insert(integrations).values({
    id: integrationId,
    name: "Jellyfin",
    kind: "jellyfin",
    url: "http://jellyfin.local",
    viewerScoping: "username",
  });
};

describe("viewer mappings", () => {
  beforeEach(() => {
    clearViewerResolutionCache(integrationId);
    vi.clearAllMocks();
  });

  test("save and delete a mapping", async () => {
    const { db, caller } = setup();
    await insertIntegrationAsync(db);
    await db.insert(users).values({ id: "user-1", name: "alice" });

    await caller.saveViewerMapping({ integrationId, userId: "user-1", externalUserId: "jf-1" });
    await caller.saveViewerMapping({ integrationId, userId: "user-1", externalUserId: "jf-2" });

    const saved = await db.query.integrationViewerMappings.findMany();
    expect(saved).toEqual([{ integrationId, userId: "user-1", externalUserId: "jf-2" }]);

    await caller.deleteViewerMapping({ integrationId, userId: "user-1" });

    expect(await db.query.integrationViewerMappings.findMany()).toHaveLength(0);
  });

  test("saving a mapping for an unknown user is rejected", async () => {
    const { db, caller } = setup();
    await insertIntegrationAsync(db);

    await expect(
      caller.saveViewerMapping({ integrationId, userId: "missing", externalUserId: "jf-1" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await db.query.integrationViewerMappings.findMany()).toHaveLength(0);
  });

  test("saving and deleting a mapping clears the resolution cache", async () => {
    const { db, caller } = setup();
    await insertIntegrationAsync(db);
    await db.insert(users).values({ id: "user-1", name: "alice" });

    await caller.saveViewerMapping({ integrationId, userId: "user-1", externalUserId: "jf-1" });
    expect(clearViewerResolutionCache).toHaveBeenLastCalledWith(integrationId, "user-1");

    vi.mocked(clearViewerResolutionCache).mockClear();
    await caller.deleteViewerMapping({ integrationId, userId: "user-1" });
    expect(clearViewerResolutionCache).toHaveBeenLastCalledWith(integrationId, "user-1");
  });

  test("updating the integration clears the whole resolution cache of the integration", async () => {
    const { db, caller } = setup();
    await insertIntegrationAsync(db);

    await caller.update({
      id: integrationId,
      name: "Jellyfin",
      url: "http://jellyfin.local",
      secrets: [],
      appId: null,
    });

    expect(clearViewerResolutionCache).toHaveBeenCalledWith(integrationId);
  });

  test("mapping procedures require full access", async () => {
    const { db, caller } = setup(["integration-interact-all"]);
    await insertIntegrationAsync(db);
    await db.insert(users).values({ id: "user-1", name: "alice" });

    await expect(caller.viewerMappings({ integrationId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      caller.saveViewerMapping({ integrationId, userId: "user-1", externalUserId: "jf-1" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller.deleteViewerMapping({ integrationId, userId: "user-1" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  test("viewerMappings lists automatic matches and overrides", async () => {
    const { db, caller } = setup();
    await insertIntegrationAsync(db);
    await db.insert(users).values([
      { id: "oidc-user", name: "alice", provider: "oidc" },
      { id: "local-user", name: "alice-local", provider: "credentials" },
      { id: "unknown-user", name: "nobody", provider: "ldap" },
    ]);
    await db
      .insert(integrationViewerMappings)
      .values({ integrationId, userId: "local-user", externalUserId: "jf-pinned" });
    const roster = [
      { id: "jf-alice", displayName: "Alice", usernames: ["alice"], email: null },
      { id: "jf-pinned", displayName: "Pinned", usernames: ["pinned"], email: null },
    ];
    listViewerScopeUsersAsync.mockResolvedValue(roster);

    const result = await caller.viewerMappings({ integrationId });

    expect(result.integrationUsers).toEqual(roster);
    const byId = new Map(result.users.map((entry) => [entry.userId, entry]));
    expect(byId.get("oidc-user")).toMatchObject({
      userName: "alice",
      provider: "oidc",
      automatic: { status: "matched", externalUserId: "jf-alice" },
      override: null,
    });
    expect(byId.get("local-user")).toMatchObject({
      automatic: { status: "unlinked" },
      override: "jf-pinned",
    });
    expect(byId.get("unknown-user")).toMatchObject({ automatic: { status: "unlinked" }, override: null });
  });

  test("viewerMappings surfaces a failing roster fetch", async () => {
    const { db, caller } = setup();
    await insertIntegrationAsync(db);
    listViewerScopeUsersAsync.mockRejectedValue(new Error("unreachable"));

    await expect(caller.viewerMappings({ integrationId })).rejects.toThrow();
  });
});
