import { IconChartBar, IconSearch } from "@tabler/icons-react";

import { getWidgetIntegrationConfig } from "@homarr/definitions";
import { openMediaRequestSearch } from "@homarr/spotlight";

import { createWidgetDefinition, widgetQueryInputMatches, widgetQueryItemIdMatches } from "../../definition";

const createOptions = () => ({});

export const { componentLoader, definition } = createWidgetDefinition("mediaRequests-requestStats", {
  supportsAdvancedFocus: false,
  icon: IconChartBar,
  queryKey: [["widget", "mediaRequests", "getStats"]],
  queryMatcher: ({ input }, scope) =>
    widgetQueryInputMatches(input, { integrationIds: scope.integrationIds }) &&
    widgetQueryItemIdMatches(input, scope.itemId),
  createOptions,
  contextActions: ({ integrationIds }) => [
    {
      key: "search",
      label: "search.mode.media.action.search.label",
      icon: IconSearch,
      onClick: () => {
        openMediaRequestSearch({ integrationIds });
      },
    },
  ],
  ...getWidgetIntegrationConfig("mediaRequests-requestStats"),
}).withDynamicImport(() => import("./component"));
