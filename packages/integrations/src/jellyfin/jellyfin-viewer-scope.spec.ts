import { describe, expect, test, vi } from "vitest";

import { JellyfinIntegration } from "./jellyfin-integration";

vi.mock("@homarr/core/infrastructure/http", () => ({
  fetchWithTrustedCertificatesAsync: vi.fn(),
  createAxiosCertificateInstanceAsync: vi.fn(() => Promise.resolve({})),
}));
vi.mock("@jellyfin/sdk/lib/utils/api/user-api", () => ({
  getUserApi: () => ({
    getUsers: () => Promise.resolve({ data: [{ Id: "abc", Name: "josh" }] }),
  }),
}));

describe("Jellyfin viewer scoping", () => {
  test("jellyfin maps users", async () => {
    const integration = new JellyfinIntegration({
      id: "jellyfin-1",
      name: "Jellyfin",
      url: "https://jellyfin.example.com",
      externalUrl: null,
      decryptedSecrets: [{ kind: "apiKey", value: "test-key" }],
    });

    const users = await integration.listViewerScopeUsersAsync();

    expect(users).toEqual([{ id: "abc", displayName: "josh", usernames: ["josh"], email: null }]);
  });
});
