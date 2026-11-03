import { z } from "zod/v4";

import { mediaServerRequestHandler } from "@homarr/request-handler/media-server";

import { createManyWidgetIntegrationMiddleware } from "../../middlewares/integration";
import { PUBLIC_INTEGRATION_ERROR, settleIntegrationQueries } from "../../settle-integrations";
import { decideScopeAsync } from "../../viewer-scope/decide-scope";
import { resolveViewerAsync } from "../../viewer-scope/resolve-viewer";
import { createTRPCRouter, publicProcedure } from "../../trpc";

export const mediaServerRouter = createTRPCRouter({
  getCurrentStreams: publicProcedure
    .meta({
      mcp: {
        enabled: true,
        description:
          'Get currently active streams from Plex/Jellyfin/Emby/Navidrome media servers. REQUIRED: integrationIds (array of media server integration IDs from integration_all), showOnlyPlaying (boolean — true to filter to actively playing streams only). OPTIONAL: scope ("mine" to return only the signed-in user\'s own streams, "everyone" by default; "everyone" needs interact access to integrations with viewer scoping), itemId (ID of a saved widget, whose saved scope then applies)',
      },
    })
    .concat(createManyWidgetIntegrationMiddleware("query", "mediaServer"))
    .input(
      z.object({
        showOnlyPlaying: z.boolean(),
        scope: z.enum(["mine", "everyone"]).default("everyone"),
        itemId: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      return await settleIntegrationQueries(
        ctx.integrations,
        async (integration) => {
          const decision = await decideScopeAsync(ctx, {
            integration,
            widgetKind: "mediaServer",
            itemId: input.itemId,
            requestedScope: input.scope,
          });
          if ("forbidden" in decision) throw new Error("Viewer scope is not allowed for this integration");

          const { data } = await mediaServerRequestHandler
            .handler(integration, { showOnlyPlaying: input.showOnlyPlaying })
            .getDataAsync();

          if (decision.scope === "mine") {
            const resolution = await resolveViewerAsync(ctx.db, integration, ctx.session);
            const isMatched = resolution.status === "matched";
            return {
              integrationId: integration.id,
              integrationName: integration.name,
              integrationKind: integration.kind,
              sessions: isMatched ? data.filter((session) => session.user?.userId === resolution.externalUserId) : [],
              viewerUnlinked: !isMatched,
              error: undefined,
            };
          }

          return {
            integrationId: integration.id,
            integrationName: integration.name,
            integrationKind: integration.kind,
            sessions: data,
            viewerUnlinked: false,
            error: undefined,
          };
        },
        {
          fallback: (integration) => ({
            integrationId: integration.id,
            integrationName: integration.name,
            integrationKind: integration.kind,
            sessions: [],
            viewerUnlinked: false,
            error: PUBLIC_INTEGRATION_ERROR,
          }),
          throwOnAllFailures: true,
        },
      );
    }),
});
