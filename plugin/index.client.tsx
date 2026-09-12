import type { PluginClientContext } from "@getpaseo/plugin/client";
import { TabGoblinPanel } from "./client/panel.js";

export default function contribute(client: PluginClientContext) {
  const removePanel = client.addWorkspacePanel({
    id: "tab-goblin",
    title: "TabGoblin",
    icon: "Globe",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: TabGoblinPanel,
  });
  const removeCommand = client.addCommandCenterItem({
    id: "open-tab-goblin",
    title: "Open TabGoblin",
    icon: "Globe",
    keywords: ["browser", "viewer", "manual control"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("tab-goblin");
    },
  });
  return () => {
    removeCommand();
    removePanel();
  };
}
