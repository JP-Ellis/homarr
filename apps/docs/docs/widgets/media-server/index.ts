import { WidgetDefinition } from "@site/src/types";
import { IconVideo } from "@tabler/icons-react";

export const mediaServerWidget: WidgetDefinition = {
  icon: IconVideo,
  name: "Media server streams",
  description: "Show the current streams on your media servers",
  path: "../../widgets/media-server",
  configuration: {
    items: [
      {
        name: "Show only currently playing",
        description: "Plex and Navidrome always show only currently playing streams.",
        values: { type: "boolean" },
        defaultValue: "yes",
      },
      {
        name: "Streams to show",
        description: "Only the viewer lists the signed-in viewer's own streams on integrations with viewer scoping.",
        values: { type: "select", options: ["Everyone", "Only the viewer"] },
        defaultValue: "Everyone",
      },
    ],
  },
};
