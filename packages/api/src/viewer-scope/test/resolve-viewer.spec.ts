// @vitest-environment node

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { Session } from "@homarr/auth";
import { createId } from "@homarr/common";
import { integrations, integrationViewerMappings, users } from "@homarr/db/schema";
import { createDb } from "@homarr/db/test";
import type { ViewerScopeUser } from "@homarr/integrations/types";

import { clearViewerResolutionCache, resolveViewerAsync } from "../resolve-viewer";

const listViewerScopeUsersAsync = vi.fn<() => Promise<ViewerScopeUser[]>>();

vi.mock("@homarr/integrations", () => ({
  createIntegrationAsync: vi.fn(() => Promise.resolve({ listViewerScopeUsersAsync })),
}));

const createSession = (userId: string): Session => ({
  user: { id: userId, permissions: [], colorScheme: "light" },
  expires: new Date().toISOString(),
});

const roster: ViewerScopeUser[] = [
  { id: "ext-josh", displayName: "Josh", usernames: ["josh"], email: null },
  { id: "ext-sam", displayName: "Sam", usernames: ["sam"], email: null },
];

const setupAsync = async () => {
  const db = createDb();
  const integrationId = createId();
  await db.insert(integrations).values({
    id: integrationId,
    name: "Jellyfin",
    kind: "jellyfin",
    url: "http://jellyfin.local",
    viewerScoping: "username",
  });
  const addUserAsync = async (name: string, provider: "oidc" | "credentials" = "oidc") => {
    const userId = createId();
    await db.insert(users).values({ id: userId, name, provider });
    return userId;
  };
  const integration = {
    id: integrationId,
    kind: "jellyfin" as const,
    name: "Jellyfin",
    url: "http://jellyfin.local",
    externalUrl: null,
    viewerScoping: "username" as const,
    decryptedSecrets: [],
  };
  return { db, integration, addUserAsync };
};

describe("resolveViewerAsync", () => {
  beforeEach(() => {
    listViewerScopeUsersAsync.mockReset();
    listViewerScopeUsersAsync.mockResolvedValue(roster);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("anonymous viewer is unlinked", async () => {
    const { db, integration } = await setupAsync();

    expect(await resolveViewerAsync(db, integration, null)).toEqual({ status: "unlinked" });
    expect(listViewerScopeUsersAsync).not.toHaveBeenCalled();
  });

  test("automatic match resolves an oidc user", async () => {
    const { db, integration, addUserAsync } = await setupAsync();
    const userId = await addUserAsync("josh");

    expect(await resolveViewerAsync(db, integration, createSession(userId))).toEqual({
      status: "matched",
      externalUserId: "ext-josh",
    });
  });

  test("credentials user resolves only through an override", async () => {
    const { db, integration, addUserAsync } = await setupAsync();
    const userId = await addUserAsync("josh", "credentials");

    expect(await resolveViewerAsync(db, integration, createSession(userId))).toEqual({ status: "unlinked" });

    await db
      .insert(integrationViewerMappings)
      .values({ integrationId: integration.id, userId, externalUserId: "ext-sam" });
    clearViewerResolutionCache(integration.id, userId);

    expect(await resolveViewerAsync(db, integration, createSession(userId))).toEqual({
      status: "matched",
      externalUserId: "ext-sam",
    });
  });

  test("override wins over automatic match", async () => {
    const { db, integration, addUserAsync } = await setupAsync();
    const userId = await addUserAsync("josh");
    await db
      .insert(integrationViewerMappings)
      .values({ integrationId: integration.id, userId, externalUserId: "ext-sam" });

    expect(await resolveViewerAsync(db, integration, createSession(userId))).toEqual({
      status: "matched",
      externalUserId: "ext-sam",
    });
  });

  test("override to a deleted integration user still resolves to that id", async () => {
    const { db, integration, addUserAsync } = await setupAsync();
    const userId = await addUserAsync("josh");
    await db
      .insert(integrationViewerMappings)
      .values({ integrationId: integration.id, userId, externalUserId: "ext-gone" });

    expect(await resolveViewerAsync(db, integration, createSession(userId))).toEqual({
      status: "matched",
      externalUserId: "ext-gone",
    });
  });

  test("user list is fetched once for two viewers", async () => {
    const { db, integration, addUserAsync } = await setupAsync();
    const joshId = await addUserAsync("josh");
    const samId = await addUserAsync("sam");

    const josh = await resolveViewerAsync(db, integration, createSession(joshId));
    const sam = await resolveViewerAsync(db, integration, createSession(samId));

    expect(josh).toEqual({ status: "matched", externalUserId: "ext-josh" });
    expect(sam).toEqual({ status: "matched", externalUserId: "ext-sam" });
    expect(listViewerScopeUsersAsync).toHaveBeenCalledTimes(1);
  });

  test("clearViewerResolutionCache forces a fresh lookup", async () => {
    const { db, integration, addUserAsync } = await setupAsync();
    const userId = await addUserAsync("josh");

    await resolveViewerAsync(db, integration, createSession(userId));
    await resolveViewerAsync(db, integration, createSession(userId));
    expect(listViewerScopeUsersAsync).toHaveBeenCalledTimes(1);

    clearViewerResolutionCache(integration.id, userId);
    await resolveViewerAsync(db, integration, createSession(userId));
    expect(listViewerScopeUsersAsync).toHaveBeenCalledTimes(1);

    clearViewerResolutionCache(integration.id);
    await resolveViewerAsync(db, integration, createSession(userId));
    expect(listViewerScopeUsersAsync).toHaveBeenCalledTimes(2);
  });

  test("cached resolution expires after five minutes", async () => {
    vi.useFakeTimers();
    const { db, integration, addUserAsync } = await setupAsync();
    const userId = await addUserAsync("josh");

    await resolveViewerAsync(db, integration, createSession(userId));
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    await resolveViewerAsync(db, integration, createSession(userId));

    expect(listViewerScopeUsersAsync).toHaveBeenCalledTimes(2);
  });

  test("a failing user list propagates and is not cached", async () => {
    const { db, integration, addUserAsync } = await setupAsync();
    const userId = await addUserAsync("josh");
    listViewerScopeUsersAsync.mockRejectedValueOnce(new Error("offline"));

    await expect(resolveViewerAsync(db, integration, createSession(userId))).rejects.toThrow("offline");
    expect(await resolveViewerAsync(db, integration, createSession(userId))).toEqual({
      status: "matched",
      externalUserId: "ext-josh",
    });
  });

  test("a missing user row is unlinked", async () => {
    const { db, integration } = await setupAsync();

    expect(await resolveViewerAsync(db, integration, createSession("missing"))).toEqual({ status: "unlinked" });
  });
});
