// @vitest-environment node

import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, test, vi } from "vitest";

import type { Board } from "../_types";
import { createBoardQuerySnapshot } from "./_query-snapshot";

const store = vi.hoisted(() => new Map<string, string>());

vi.mock("@homarr/redis", () => ({
  createGetSetChannel: (name: string) => ({
    getAsync: () => Promise.resolve(store.get(name) ?? null),
    setAsync: (value: string) => {
      store.set(name, value);
      return Promise.resolve();
    },
    removeAsync: () => {
      store.delete(name);
      return Promise.resolve();
    },
  }),
  getIntegrationCacheGenerationAsync: () => Promise.resolve({ isShared: true, value: "generation" }),
  prepareIntegrationResponseCacheAsync: () => Promise.resolve(),
}));

const board = {
  id: "board",
  items: [{ id: "item", kind: "mediaServer", integrationIds: ["integration"], options: {} }],
} as unknown as Board;
const integrations = [{ id: "integration" }] as Parameters<typeof createBoardQuerySnapshot>[1];

const streamsKey = (scope: "mine" | "everyone") => [
  ["widget", "mediaServer", "getCurrentStreams"],
  { input: { integrationIds: ["integration"], showOnlyPlaying: true, scope }, type: "query" },
];

const seed = (queryClient: QueryClient, scope: "mine" | "everyone") => {
  queryClient.getQueryCache().build(queryClient, { queryKey: streamsKey(scope), meta: { rscWidgetPrefetch: true } });
  queryClient.setQueryData(streamsKey(scope), [{ integrationId: "integration", sessions: [] }]);
};

const hasQuery = (queryClient: QueryClient, scope: "mine" | "everyone") =>
  queryClient.getQueryData(streamsKey(scope)) !== undefined;

describe("board query snapshot", () => {
  beforeEach(() => store.clear());

  test("a scope mine query is neither saved nor restored, an everyone query is", async () => {
    const source = new QueryClient();
    seed(source, "mine");
    seed(source, "everyone");

    await createBoardQuerySnapshot(board, integrations).saveAsync(source);

    const saved = [...store.values()].join("");
    expect(saved).toContain("everyone");
    expect(saved).not.toContain('"mine"');

    const restored = new QueryClient();
    await createBoardQuerySnapshot(board, integrations).restoreAsync(restored);
    expect(hasQuery(restored, "everyone")).toBe(true);
    expect(hasQuery(restored, "mine")).toBe(false);
  });

  test("a stored scope mine query is dropped on restore", async () => {
    const source = new QueryClient();
    seed(source, "everyone");
    await createBoardQuerySnapshot(board, integrations).saveAsync(source);
    for (const [name, value] of store) store.set(name, value.replaceAll("everyone", "mine"));

    const restored = new QueryClient();
    await createBoardQuerySnapshot(board, integrations).restoreAsync(restored);
    expect(hasQuery(restored, "mine")).toBe(false);
  });
});
