import { describe, expect, test } from "vitest";

import type { ViewerScopingMode } from "@homarr/definitions";
import type { ViewerScopeUser } from "@homarr/integrations/types";

import { matchViewer } from "../match-viewer";

const createUser = (overrides: Partial<ViewerScopeUser> & { id: string }): ViewerScopeUser => ({
  displayName: overrides.id,
  usernames: [],
  email: null,
  ...overrides,
});

const oidcViewer = { name: "josh", email: "josh@example.com", provider: "oidc" };

describe("matchViewer", () => {
  test.each<{
    name: string;
    viewer: { name: string | null; email: string | null; provider: string };
    mode: ViewerScopingMode;
    users: ViewerScopeUser[];
    expected: string | null;
  }>([
    {
      name: "unique username",
      viewer: oidcViewer,
      mode: "username",
      users: [createUser({ id: "1", usernames: ["josh"] }), createUser({ id: "2", usernames: ["other"] })],
      expected: "1",
    },
    {
      name: "case-different username",
      viewer: { ...oidcViewer, name: "Josh" },
      mode: "username",
      users: [createUser({ id: "1", usernames: ["josh"] })],
      expected: "1",
    },
    {
      name: "ldap provider",
      viewer: { ...oidcViewer, provider: "ldap" },
      mode: "username",
      users: [createUser({ id: "1", usernames: ["josh"] })],
      expected: "1",
    },
    {
      name: "email mode",
      viewer: oidcViewer,
      mode: "email",
      users: [
        createUser({ id: "1", usernames: ["josh"], email: "nobody@example.com" }),
        createUser({ id: "2", email: "JOSH@example.com" }),
      ],
      expected: "2",
    },
    {
      name: "no match",
      viewer: oidcViewer,
      mode: "username",
      users: [createUser({ id: "1", usernames: ["other"] })],
      expected: null,
    },
    {
      name: "ambiguous, two users share a name",
      viewer: oidcViewer,
      mode: "username",
      users: [createUser({ id: "1", usernames: ["josh"] }), createUser({ id: "2", usernames: ["josh"] })],
      expected: null,
    },
    {
      name: "cross-field conflict",
      viewer: oidcViewer,
      mode: "username",
      users: [createUser({ id: "1", usernames: ["josh", "x"] }), createUser({ id: "2", usernames: ["y", "josh"] })],
      expected: null,
    },
    {
      name: "same user hit through two fields",
      viewer: oidcViewer,
      mode: "username",
      users: [createUser({ id: "1", usernames: ["josh", "Josh"] })],
      expected: "1",
    },
    {
      name: "credentials provider",
      viewer: { ...oidcViewer, provider: "credentials" },
      mode: "username",
      users: [createUser({ id: "1", usernames: ["josh"] })],
      expected: null,
    },
    {
      name: "mode off",
      viewer: oidcViewer,
      mode: "off",
      users: [createUser({ id: "1", usernames: ["josh"] })],
      expected: null,
    },
    {
      name: "viewer name null",
      viewer: { ...oidcViewer, name: null },
      mode: "username",
      users: [createUser({ id: "1", usernames: ["josh"] })],
      expected: null,
    },
    {
      name: "empty viewer email never matches an empty integration email",
      viewer: { ...oidcViewer, email: "" },
      mode: "email",
      users: [createUser({ id: "1", email: "" })],
      expected: null,
    },
    {
      name: "whitespace-only values never match",
      viewer: { ...oidcViewer, name: "  " },
      mode: "username",
      users: [createUser({ id: "1", usernames: [" ", ""] })],
      expected: null,
    },
    {
      name: "empty integration usernames are ignored",
      viewer: oidcViewer,
      mode: "username",
      users: [createUser({ id: "1", usernames: ["", "josh"] })],
      expected: "1",
    },
  ])("$name", ({ viewer, mode, users, expected }) => {
    const result = matchViewer(viewer, mode, users);

    expect(result).toEqual(
      expected === null ? { status: "unlinked" } : { status: "matched", externalUserId: expected },
    );
  });
});
