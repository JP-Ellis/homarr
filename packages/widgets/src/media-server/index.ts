import { IconVideo } from "@tabler/icons-react";

import { getWidgetIntegrationConfig } from "@homarr/definitions";

import { createWidgetDefinition, widgetQueryInputMatches, widgetQueryItemIdMatches } from "../definition";
import { optionsBuilder } from "../options";

export const { componentLoader, definition } = createWidgetDefinition("mediaServer", {
  icon: IconVideo,
  supportsAdvancedFocus: true,
  queryKey: [["widget", "mediaServer", "getCurrentStreams"]],
  queryMatcher: ({ input }, scope) =>
    widgetQueryInputMatches(input, {
      integrationIds: scope.integrationIds,
      showOnlyPlaying: scope.options.showOnlyPlaying,
      scope: scope.options.scope,
    }) && widgetQueryItemIdMatches(input, scope.itemId),
  refetchInterval: 10,
  createOptions() {
    return optionsBuilder.from((factory) => ({
      showOnlyPlaying: factory.switch({ defaultValue: true, withDescription: true }),
      scope: factory.select({
        defaultValue: "everyone",
        options: [
          { value: "everyone", label: (t) => t("widget.mediaServer.option.scope.option.everyone") },
          { value: "mine", label: (t) => t("widget.mediaServer.option.scope.option.mine") },
        ],
        withDescription: true,
      }),
      showBitrate: factory.switch({ defaultValue: true, withDescription: true }),
      showLocation: factory.switch({ defaultValue: true, withDescription: true }),
    }));
  },
  ...getWidgetIntegrationConfig("mediaServer"),
}).withDynamicImport(() => import("./component"));
