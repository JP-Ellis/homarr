import { z } from "zod/v4";

import type { IntegrationKindByCategory } from "@homarr/definitions";
import { createIntegrationAsync } from "@homarr/integrations/factory";
import type { MediaRequest, MediaRequestStats } from "@homarr/integrations/types";
import { mediaRequestStatusConfiguration } from "@homarr/integrations/types";
import {
  mediaRequestListInputSchema,
  mediaRequestListRequestHandler,
} from "@homarr/request-handler/media-request-list";
import { mediaRequestStatsRequestHandler } from "@homarr/request-handler/media-request-stats";

import {
  createManyWidgetIntegrationMiddleware,
  createOneWidgetIntegrationMiddleware,
} from "../../middlewares/integration";
import { PUBLIC_INTEGRATION_ERROR, settleIntegrationQueries } from "../../settle-integrations";
import { createTRPCRouter, protectedProcedure, publicProcedure } from "../../trpc";
import { decideScopeAsync } from "../../viewer-scope/decide-scope";
import { resolveViewerAsync } from "../../viewer-scope/resolve-viewer";

interface IntegrationQueryResult<TData> {
  integration: { id: string; name: string; kind: IntegrationKindByCategory<"mediaRequest"> };
  data: TData;
  viewerUnlinked?: boolean;
  error?: string;
}

export const mediaRequestsRouter = createTRPCRouter({
  getLatestRequests: publicProcedure
    .meta({
      mcp: {
        enabled: true,
        description:
          'Get latest media requests from Overseerr/Jellyseerr with their status (pending, approved, declined, failed, completed). REQUIRED: integrationIds (array of Overseerr/Jellyseerr integration IDs from integration_all). OPTIONAL: statuses (array of statuses to include, must be non-empty), recentDays (number 0-365; 0 disables the time filter), scope ("mine" to return only the signed-in user\'s own requests, "everyone" by default; "everyone" needs interact access to integrations with viewer scoping), itemId (ID of a saved widget, whose saved scope then applies).',
      },
    })
    .concat(createManyWidgetIntegrationMiddleware("query", "mediaRequests-requestList"))
    .input(
      mediaRequestListInputSchema.omit({ requestedBy: true }).extend({
        scope: z.enum(["mine", "everyone"]).default("everyone"),
        itemId: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const results: IntegrationQueryResult<MediaRequest[]>[] = await settleIntegrationQueries(
        ctx.integrations,
        async (integration) => {
          const decision = await decideScopeAsync(ctx, {
            integration,
            widgetKind: "mediaRequests-requestList",
            itemId: input.itemId,
            requestedScope: input.scope,
          });
          if ("forbidden" in decision) throw new Error("Viewer scope is not allowed for this integration");

          const handlerInput = {
            integrationIds: input.integrationIds,
            statuses: input.statuses,
            recentDays: input.recentDays,
          };
          const integrationSummary = { id: integration.id, name: integration.name, kind: integration.kind };

          if (decision.scope === "mine") {
            const resolution = await resolveViewerAsync(ctx.db, integration, ctx.session);
            if (resolution.status !== "matched") {
              return { integration: integrationSummary, data: [], viewerUnlinked: true, error: undefined };
            }
            const requestedBy = Number(resolution.externalUserId);
            const { data } = await mediaRequestListRequestHandler
              .handler(integration, { ...handlerInput, requestedBy })
              .getDataAsync();
            return {
              integration: integrationSummary,
              data: data.filter((request) => request.requestedBy?.id === requestedBy),
              viewerUnlinked: false,
              error: undefined,
            };
          }

          const { data } = await mediaRequestListRequestHandler.handler(integration, handlerInput).getDataAsync();
          return { integration: integrationSummary, data, viewerUnlinked: false, error: undefined };
        },
        {
          fallback: (integration) => ({
            integration: { id: integration.id, name: integration.name, kind: integration.kind },
            data: [],
            viewerUnlinked: false,
            error: PUBLIC_INTEGRATION_ERROR,
          }),
          throwOnAllFailures: true,
        },
      );
      const requests = results
        .flatMap(({ data, integration }) =>
          data.map((request) => ({
            ...request,
            integrationId: integration.id,
            integration,
          })),
        )
        .toSorted((dataA, dataB) => {
          if (dataA.status === dataB.status) {
            return dataB.createdAt.getTime() - dataA.createdAt.getTime();
          }

          return (
            mediaRequestStatusConfiguration[dataA.status].position -
            mediaRequestStatusConfiguration[dataB.status].position
          );
        });
      return {
        requests,
        viewerUnlinked: results.length > 0 && results.every(({ viewerUnlinked }) => viewerUnlinked),
        failedIntegrations: results.flatMap(({ integration, error }) =>
          error ? [{ integrationId: integration.id, integrationName: integration.name, error }] : [],
        ),
      };
    }),
  getStats: publicProcedure
    .meta({
      mcp: {
        enabled: true,
        description:
          "Get media request statistics including total counts and top requesters. REQUIRED: integrationIds (array of Overseerr/Jellyseerr integration IDs from integration_all). OPTIONAL: itemId (ID of a saved widget; without it, integrations with viewer scoping need interact access)",
      },
    })
    .concat(createManyWidgetIntegrationMiddleware("query", "mediaRequests-requestStats"))
    .input(z.object({ itemId: z.string().optional() }))
    .query(async ({ ctx, input }) => {
      const results: IntegrationQueryResult<{
        stats: MediaRequestStats["stats"] | null;
        users: MediaRequestStats["users"];
      }>[] = await settleIntegrationQueries(
        ctx.integrations,
        async (integration) => {
          const decision = await decideScopeAsync(ctx, {
            integration,
            widgetKind: "mediaRequests-requestStats",
            itemId: input.itemId,
            requestedScope: "everyone",
          });
          if ("forbidden" in decision) throw new Error("Viewer scope is not allowed for this integration");

          const { data } = await mediaRequestStatsRequestHandler.handler(integration, {}).getDataAsync();
          return {
            integration: { id: integration.id, name: integration.name, kind: integration.kind },
            data,
            error: undefined,
          };
        },
        {
          fallback: (integration) => ({
            integration: { id: integration.id, name: integration.name, kind: integration.kind },
            data: { stats: null, users: [] },
            error: PUBLIC_INTEGRATION_ERROR,
          }),
          throwOnAllFailures: true,
        },
      );
      return {
        stats: results.flatMap((result) => (result.data.stats ? [result.data.stats] : [])),
        users: results
          .map((result) =>
            result.data.users.map((user) => ({
              ...user,
              integration: result.integration,
            })),
          )
          .flat()
          .toSorted(({ requestCount: countA }, { requestCount: countB }) => countB - countA),
        integrations: results.map((result) => result.integration),
        failedIntegrations: results.flatMap(({ integration, error }) =>
          error ? [{ integrationId: integration.id, integrationName: integration.name, error }] : [],
        ),
      };
    }),
  answerRequest: protectedProcedure
    .meta({
      mcp: {
        enabled: true,
        description:
          "Approve or decline a pending media request. REQUIRED: integrationId (single Overseerr/Jellyseerr integration ID), requestId (number from getLatestRequests), answer ('approve' or 'decline')",
      },
    })
    .concat(createOneWidgetIntegrationMiddleware("interact", "mediaRequests-requestList"))
    .input(
      z.object({
        requestId: z.number(),
        answer: z.enum(["approve", "decline"]),
      }),
    )
    .mutation(async ({ ctx: { integration }, input }) => {
      const integrationInstance = await createIntegrationAsync(integration);

      const answerActions = {
        approve: (id: number) => integrationInstance.approveRequestAsync(id),
        decline: (id: number) => integrationInstance.declineRequestAsync(id),
      } as const;

      await answerActions[input.answer](input.requestId);
      mediaRequestListRequestHandler.invalidateCache();
      await mediaRequestStatsRequestHandler.invalidateCacheAsync([integration.id]);
      return { success: true };
    }),
});
