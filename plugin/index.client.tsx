import type { PluginClientContext } from "@getpaseo/plugin/client";
import { TabGoblinPanel } from "./client/panel.js";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "tab-goblin",
    title: "TabGoblin",
    icon: "Globe",
    context: "workspace",
    Component: TabGoblinPanel,
  });
  return () => {};
}
