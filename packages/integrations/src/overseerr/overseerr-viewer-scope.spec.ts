import { Response } from "undici";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { fetchWithTrustedCertificatesAsync } from "@homarr/core/infrastructure/http";

import { OverseerrIntegration } from "./overseerr-integration";

vi.mock("@homarr/core/infrastructure/http", () => ({
  fetchWithTrustedCertificatesAsync: vi.fn(),
  createCertificateAgentAsync: vi.fn(() => Promise.resolve({ close: vi.fn() })),
}));

const mockFetch = vi.mocked(fetchWithTrustedCertificatesAsync);
const integration = new OverseerrIntegration({
  id: "overseerr-1",
  name: "Overseerr",
  url: "https://overseerr.example.com",
  externalUrl: null,
  decryptedSecrets: [{ kind: "apiKey", value: "test-key" }],
});

const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("Overseerr viewer scoping", () => {
  beforeEach(() => vi.clearAllMocks());

  test("overseerr lists every page of users", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      displayName: `User ${index + 1}`,
      email: null,
      username: `user${index + 1}`,
    }));
    const secondPage = [
      {
        id: 101,
        displayName: "Josh",
        email: "josh@example.com",
        username: "josh",
        jellyfinUsername: "josh-jf",
        plexUsername: "josh-plex",
      },
    ];
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ pageInfo: { page: 1, pages: 2 }, results: firstPage }))
      .mockResolvedValueOnce(jsonResponse({ pageInfo: { page: 2, pages: 2 }, results: secondPage }));

    const users = await integration.listViewerScopeUsersAsync();

    expect(users).toHaveLength(101);
    expect(users.at(100)).toEqual({
      id: "101",
      displayName: "Josh",
      email: "josh@example.com",
      usernames: ["josh", "josh-jf", "josh-plex"],
    });
    expect(users.at(0)?.usernames).toEqual(["user1"]);
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain("take=100&skip=0");
    expect(String(mockFetch.mock.calls[1]?.[0])).toContain("skip=100");
  });

  test("overseerr returns an empty roster after one empty page", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ pageInfo: { page: 1, pages: 5 }, results: [] }));

    const users = await integration.listViewerScopeUsersAsync();

    expect(users).toEqual([]);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  test("overseerr stops at a short page even when more pages are reported", async () => {
    const shortPage = [{ id: 1, displayName: "Josh", email: null, username: "josh" }];
    mockFetch.mockResolvedValue(jsonResponse({ pageInfo: { page: 1, pages: 5 }, results: shortPage }));

    const users = await integration.listViewerScopeUsersAsync();

    expect(users).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  test("overseerr stops after 100 pages when the server misreports the page count", async () => {
    let requestCount = 0;
    mockFetch.mockImplementation(() => {
      requestCount += 1;
      const fullPage = Array.from({ length: 100 }, (_, index) => ({
        id: requestCount * 100 + index,
        displayName: `User ${index}`,
        email: null,
        username: `user${requestCount}-${index}`,
      }));
      return Promise.resolve(jsonResponse({ pageInfo: { page: 1, pages: 1_000_000 }, results: fullPage }));
    });

    const users = await integration.listViewerScopeUsersAsync();

    expect(mockFetch).toHaveBeenCalledTimes(100);
    expect(users).toHaveLength(10_000);
  });

  test("overseerr requestedBy fetches only that user's requests", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse({ results: [] })));

    await integration.getRequestsAsync({ requestedBy: 7 });

    expect(mockFetch).toHaveBeenCalledOnce();
    const url = String(mockFetch.mock.calls[0]?.[0]);
    expect(url).toContain("requestedBy=7");
    expect(url).toContain("take=100");
    expect(url).toContain("sort=modified");
  });

  test("overseerr without options keeps the pending and modified fetches", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse({ results: [] })));

    await integration.getRequestsAsync();

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
