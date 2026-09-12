import { PROTOCOL_VERSION, type AdminResponse } from "@tab-goblin/protocol";
import type { GatewayClient } from "./gateway-client.js";
import type { TabGoblinSettings } from "../shared/settings.js";

export interface SettingsCache {
  read(): TabGoblinSettings;
  write(value: TabGoblinSettings): void;
}

export function ping() {
  return { protocolVersion: PROTOCOL_VERSION };
}

export function createHandlers(gateway: GatewayClient, settings: SettingsCache) {
  return {
    status: ({ workspaceId }: { workspaceId: string; cwd: string }): Promise<AdminResponse> =>
      gateway.request({ op: "status", workspaceId }),
    start: ({ workspaceId }: { workspaceId: string }): Promise<AdminResponse> =>
      gateway.request({ op: "start", workspaceId }),
    stop: ({ workspaceId }: { workspaceId: string }): Promise<AdminResponse> =>
      gateway.request({ op: "stop", workspaceId }),
    activity: ({ workspaceId }: { workspaceId: string }): Promise<AdminResponse> =>
      gateway.request({ op: "activity", workspaceId }),
    pair: ({ workspaceId }: { workspaceId: string }): Promise<AdminResponse> =>
      gateway.request({ op: "pair", workspaceId }),
    returnToAgent: ({ workspaceId }: { workspaceId: string }): Promise<AdminResponse> =>
      gateway.request({ op: "return-to-agent", workspaceId }),
    enableWorkspace: ({ cwd, enabled }: { cwd: string; enabled: boolean }) => {
      const current = settings.read();
      const enabledWorkspaceCwds = new Set(current.enabledWorkspaceCwds);
      if (enabled) enabledWorkspaceCwds.add(cwd);
      else enabledWorkspaceCwds.delete(cwd);
      settings.write({ ...current, enabledWorkspaceCwds: [...enabledWorkspaceCwds] });
      return { ok: true };
    },
  };
}
