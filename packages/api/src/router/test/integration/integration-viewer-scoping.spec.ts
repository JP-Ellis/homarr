import { describe, expect, test, vi } from "vitest";
import type { z } from "zod/v4";

import type { Session } from "@homarr/auth";
import { createId } from "@homarr/common";
import { integrations } from "@homarr/db/schema";
import { createDb } from "@homarr/db/test";
import type { integrationCreateSchema } from "@homarr/validation/integration";

import { integrationRouter } from "../../integration/integration-router";

vi.mock("@homarr/auth", () => ({ auth: () => ({}) as Session }));
vi.mock("@homarr/redis", () => ({ invalidateIntegrationCacheAsync: vi.fn() }));
vi.mock("../../integration/integration-test-connection", () => ({
  testConnectionAsync: async () => await Promise.resolve({ success: true }),
}));

const setup = () => {
  const db = createDb();
  const session = {
    user: {
      id: createId(),
      permissions: ["integration-create", "integration-full-all"],
      colorScheme: "light",
    },
    expires: new Date().toISOString(),
  } satisfies Session;
  const caller = integrationRouter.createCaller({
    db,
    deviceType: undefined,
    session,
  });
  return { db, caller };
};

const jellyfinInput: Omit<z.input<typeof integrationCreateSchema>, "viewerScoping"> = {
  name: "Jellyfin",
  url: "http://jellyfin.local",
  kind: "jellyfin",
  secrets: [{ kind: "apiKey", value: "secret" }],
  attemptSearchEngineCreation: false,
};

describe("viewer scoping", () => {
  test("create stores viewerScoping", async () => {
    const { db, caller } = setup();

    const result = await caller.create({
      ...jellyfinInput,
      viewerScoping: "username",
    });

    expect(result).toHaveProperty("integration");
    const row = await db.query.integrations.findFirst();
    expect(row?.viewerScoping).toBe("username");
  });

  test("create rejects email scoping for jellyfin", async () => {
    const { db, caller } = setup();

    await expect(caller.create({ ...jellyfinInput, viewerScoping: "email" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(await db.query.integrations.findMany()).toHaveLength(0);
  });

  test("create accepts email scoping for seerr", async () => {
    const { db, caller } = setup();

    await caller.create({
      ...jellyfinInput,
      kind: "seerr",
      viewerScoping: "email",
    });

    const row = await db.query.integrations.findFirst();
    expect(row?.viewerScoping).toBe("email");
  });

  test("update changes viewerScoping", async () => {
    const { db, caller } = setup();
    await db.insert(integrations).values({
      id: "1",
      name: "Jellyfin",
      kind: "jellyfin",
      url: "http://jellyfin.local",
    });

    await caller.update({
      id: "1",
      name: "Jellyfin",
      url: "http://jellyfin.local",
      secrets: [],
      appId: null,
      viewerScoping: "username",
    });

    const row = await db.query.integrations.findFirst();
    expect(row?.viewerScoping).toBe("username");
  });

  test("update rejects email scoping for jellyfin", async () => {
    const { db, caller } = setup();
    await db.insert(integrations).values({
      id: "1",
      name: "Jellyfin",
      kind: "jellyfin",
      url: "http://jellyfin.local",
    });

    await expect(
      caller.update({
        id: "1",
        name: "Jellyfin",
        url: "http://jellyfin.local",
        secrets: [],
        appId: null,
        viewerScoping: "email",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await db.query.integrations.findFirst())?.viewerScoping).toBe("off");
  });

  test("existing rows default to off", async () => {
    const { db } = setup();
    await db.insert(integrations).values({
      id: "1",
      name: "Jellyfin",
      kind: "jellyfin",
      url: "http://jellyfin.local",
    });

    const row = await db.query.integrations.findFirst();
    expect(row?.viewerScoping).toBe("off");
  });
});
