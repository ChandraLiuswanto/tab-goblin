import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { copyText, Modal, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsCard, SettingsRow, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import type { AdminResponse } from "@tab-goblin/protocol";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ActivityList } from "./activity-list.js";
import {
  actionAvailability,
  describeState,
  initialEphemeralState,
  manualQueryPolicy,
  panelEphemeralReducer,
  refreshAfterSuccessfulAction,
  refreshPanelQueries,
  sanitizeTabs,
  statusResponseIssue,
  viewerAddress,
} from "./panel-model.js";
import { openExternal } from "./web.js";
import {
  activityRpc,
  configRpc,
  enableWorkspaceRpc,
  pairRpc,
  returnToAgentRpc,
  setGlobalEnabledRpc,
  startRpc,
  statusRpc,
  stopRpc,
  tabsRpc,
  updateConnectionRpc,
} from "../shared/rpc.js";

export { describeState } from "./panel-model.js";

type ActionName = "start" | "stop" | "pair" | "return" | "enable" | "disable" | "global" | "connection";

type ActionButtonProps = {
  label: string;
  onPress(): void;
  disabled?: boolean;
  emphasis?: "primary" | "normal" | "danger";
  colors: PluginWorkspacePanelProps["theme"]["colors"];
};

function ActionButton({ label, onPress, disabled = false, emphasis = "normal", colors }: ActionButtonProps) {
  const backgroundColor = emphasis === "primary" ? colors.accent : colors.surface2;
  const foreground = emphasis === "primary" ? colors.accentForeground : emphasis === "danger" ? colors.statusDanger : colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{
        minHeight: 42,
        justifyContent: "center",
        borderWidth: 1,
        borderColor: emphasis === "danger" ? colors.statusDanger : emphasis === "primary" ? colors.accent : colors.border,
        borderRadius: 10,
        paddingHorizontal: 14,
        paddingVertical: 9,
        backgroundColor,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text style={{ color: foreground, fontWeight: "700", textAlign: "center" }}>{label}</Text>
    </Pressable>
  );
}

function rpcMessage(response: AdminResponse): string {
  return response.ok ? "Request did not return the required data." : `${response.error.code}: The gateway rejected this request. Refresh status before deciding whether to retry.`;
}

function lastUpdated(timestamp: number): string {
  if (!timestamp) return "No successful update yet";
  return `Updated ${new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
}

export function TabGoblinPanel({ theme, host, layout, workspaceId }: PluginWorkspacePanelProps) {
  const workspace = useWorkspace(workspaceId, ({ name, directory }) => ({ name, directory }));
  const cwd = workspace?.directory ?? null;
  const scope = `${host.id}/${workspaceId}/${cwd ?? "unavailable"}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const requestRef = useRef(0);
  const generationRef = useRef({ scope, generation: -1 });
  if (generationRef.current.scope !== scope) generationRef.current = { scope, generation: -1 };

  const [ephemeral, dispatch] = useReducer(panelEphemeralReducer, scope, initialEphemeralState);
  // Effects run after render. Gate sensitive transient state synchronously so a prop switch
  // can never paint the previous workspace's pairing code, even for one frame.
  const scopedEphemeral = ephemeral.scope === scope ? ephemeral : initialEphemeralState(scope);
  const [pending, setPending] = useState<{ scope: string; request: number; action: ActionName } | null>(null);
  const [stopConfirmation, setStopConfirmation] = useState(false);
  const [globalDisableConfirmation, setGlobalDisableConfirmation] = useState(false);
  const [socketDraft, setSocketDraft] = useState("");
  const [viewerDraft, setViewerDraft] = useState("");
  const toast = useToast();

  const getConfig = useRpc(configRpc);
  const getStatus = useRpc(statusRpc);
  const getTabs = useRpc(tabsRpc);
  const getActivity = useRpc(activityRpc);
  const startBrowser = useRpc(startRpc);
  const stopBrowser = useRpc(stopRpc);
  const requestPairing = useRpc(pairRpc);
  const returnToAgent = useRpc(returnToAgentRpc);
  const setWorkspaceEnabled = useRpc(enableWorkspaceRpc);
  const setGlobalEnabled = useRpc(setGlobalEnabledRpc);
  const updateConnection = useRpc(updateConnectionRpc);
  const input = useMemo(() => cwd ? { workspaceId, cwd } : null, [cwd, workspaceId]);
  const configKey = useMemo(() => ["tabgoblin", "config", host.id, workspaceId, cwd] as const, [cwd, host.id, workspaceId]);
  const statusKey = useMemo(() => ["tabgoblin", "status", host.id, workspaceId, cwd] as const, [cwd, host.id, workspaceId]);
  const tabsKey = useMemo(() => ["tabgoblin", "tabs", host.id, workspaceId, cwd] as const, [cwd, host.id, workspaceId]);
  const activityKey = useMemo(() => ["tabgoblin", "activity", host.id, workspaceId, cwd] as const, [cwd, host.id, workspaceId]);

  useEffect(() => {
    dispatch({ type: "scope-changed", scope });
    setPending(null);
    setStopConfirmation(false);
    setGlobalDisableConfirmation(false);
    setSocketDraft("");
    setViewerDraft("");
  }, [scope]);

  useEffect(() => {
    const pairing = scopedEphemeral.pairing;
    if (!pairing) return;
    const expires = Date.parse(pairing.expiresAt);
    const delay = Number.isFinite(expires) ? expires - Date.now() : 0;
    if (delay <= 0) {
      dispatch({ type: "clear-pairing", scope });
      return;
    }
    const timer = setTimeout(() => dispatch({ type: "clear-pairing", scope }), Math.min(delay, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [scope, scopedEphemeral.pairing]);

  const configQuery = useQuery({
    queryKey: configKey,
    enabled: input !== null,
    ...manualQueryPolicy,
    queryFn: async () => {
      if (!input) throw new Error("Workspace unavailable");
      const response = await getConfig(input);
      if (!response.ok) throw new Error("Invalid workspace configuration scope");
      if (scopeRef.current !== scope) throw new Error("Workspace changed");
      return response;
    },
  });

  const statusQuery = useQuery({
    queryKey: statusKey,
    enabled: input !== null,
    ...manualQueryPolicy,
    queryFn: async () => {
      if (!input) throw new Error("Workspace unavailable");
      const response = await getStatus(input);
      const issue = statusResponseIssue(response, workspaceId, generationRef.current.generation);
      if (issue) throw new Error(issue);
      if (scopeRef.current !== scope) throw new Error("Workspace changed");
      // statusResponseIssue established that this is the successful status variant.
      const generation = response.ok && response.status ? response.status.ownership.generation : -1;
      generationRef.current = { scope, generation };
      return response;
    },
  });

  const statusForTabs = statusQuery.data?.ok ? statusQuery.data.status : null;
  const tabsQuery = useQuery({
    queryKey: tabsKey,
    enabled: input !== null && statusForTabs?.sessionState === "ready" && !statusQuery.isError,
    ...manualQueryPolicy,
    queryFn: async () => {
      if (!input) throw new Error("Workspace unavailable");
      const response = await getTabs(input);
      if (!response.ok) throw new Error(response.error.code);
      if (scopeRef.current !== scope) throw new Error("Workspace changed");
      return response;
    },
  });

  const activityQuery = useQuery({
    queryKey: activityKey,
    enabled: input !== null,
    ...manualQueryPolicy,
    queryFn: async () => {
      if (!input) throw new Error("Workspace unavailable");
      const response = await getActivity(input);
      if (!response.ok) throw new Error(response.error.code);
      if (scopeRef.current !== scope) throw new Error("Workspace changed");
      return response;
    },
  });

  const config = configQuery.data?.ok ? configQuery.data : null;
  useEffect(() => {
    setSocketDraft(config?.socketPath ?? "");
    setViewerDraft(config?.viewerUrl ?? "");
  }, [config?.socketPath, config?.viewerUrl, scope]);

  const statusResponse = statusQuery.data;
  const status = statusResponse?.ok ? statusResponse.status ?? null : null;
  const tabs = sanitizeTabs(tabsQuery.data?.ok ? tabsQuery.data.tabs : undefined);
  const state = describeState({ rpcFailed: statusQuery.isError, status });
  const viewerSource = status?.viewerUrl || config?.viewerUrl;
  const viewer = viewerAddress(viewerSource);
  const busy = pending?.scope === scope;
  const available = actionAvailability(status, statusQuery.isError, viewer !== null);
  const refetchers = {
    config: () => configQuery.refetch(),
    status: () => statusQuery.refetch(),
    tabs: () => tabsQuery.refetch(),
    activity: () => activityQuery.refetch(),
  };
  const connectionChanged = config !== null && (socketDraft !== config.socketPath || viewerDraft !== config.viewerUrl);

  async function perform(action: ActionName, call: () => Promise<AdminResponse>) {
    const request = ++requestRef.current;
    const requestScope = scope;
    dispatch({ type: "request-started", scope: requestScope, request });
    setPending({ scope: requestScope, request, action });
    try {
      const response = await call();
      if (scopeRef.current !== requestScope || requestRef.current !== request) return;
      if (!response.ok) {
        dispatch({ type: "action-failed", scope: requestScope, request, message: rpcMessage(response) });
        return;
      }
      dispatch({ type: "clear-error", scope: requestScope });
      await refreshAfterSuccessfulAction(response, refetchers);
    } catch {
      dispatch({ type: "action-failed", scope: requestScope, request, message: "Request failed. Refresh status before trying again." });
    } finally {
      setPending((current) => current?.scope === requestScope && current.request === request ? null : current);
    }
  }

  async function pair() {
    if (!input) return;
    const request = ++requestRef.current;
    const requestScope = scope;
    dispatch({ type: "request-started", scope: requestScope, request });
    setPending({ scope: requestScope, request, action: "pair" });
    try {
      const response = await requestPairing(input);
      if (scopeRef.current !== requestScope || requestRef.current !== request) return;
      if (!response.ok || !response.pairingCode || !response.pairingExpiresAt || !Number.isFinite(Date.parse(response.pairingExpiresAt)) || Date.parse(response.pairingExpiresAt) <= Date.now()) {
        dispatch({ type: "action-failed", scope: requestScope, request, message: rpcMessage(response) });
        return;
      }
      dispatch({ type: "pair-succeeded", scope: requestScope, request, code: response.pairingCode, expiresAt: response.pairingExpiresAt });
      await refreshAfterSuccessfulAction(response, refetchers);
    } catch {
      dispatch({ type: "action-failed", scope: requestScope, request, message: "Pairing request failed. No control handoff was assumed." });
    } finally {
      setPending((current) => current?.scope === requestScope && current.request === request ? null : current);
    }
  }

  async function rereadConfig(matches: (value: { globallyEnabled: boolean; workspaceEnabled: boolean; socketPath: string; viewerUrl: string }) => boolean) {
    const result = await configQuery.refetch();
    return scopeRef.current === scope && result.data?.ok === true && matches(result.data);
  }

  async function saveOptIn(enabled: boolean) {
    if (!input) return;
    const request = ++requestRef.current;
    const requestScope = scope;
    dispatch({ type: "request-started", scope: requestScope, request });
    setPending({ scope: requestScope, request, action: enabled ? "enable" : "disable" });
    try {
      const response = await setWorkspaceEnabled({ ...input, enabled });
      if (scopeRef.current !== requestScope || requestRef.current !== request) return;
      const confirmed = await rereadConfig((value) => value.workspaceEnabled === enabled);
      if (scopeRef.current !== requestScope || requestRef.current !== request) return;
      if (!response.ok || !confirmed) {
        dispatch({ type: "action-failed", scope: requestScope, request, message: "The workspace setting was not confirmed by an authoritative server reread." });
        return;
      }
      dispatch({ type: "clear-error", scope: requestScope });
      await refreshPanelQueries(refetchers, false);
      if (scopeRef.current !== requestScope || requestRef.current !== request) return;
      toast.show(`Workspace ${enabled ? "enabled" : "disabled"} on the TabGoblin server.`, { variant: "success" });
    } catch {
      dispatch({ type: "action-failed", scope: requestScope, request, message: "The server-owned workspace setting was not changed." });
    } finally {
      setPending((current) => current?.scope === requestScope && current.request === request ? null : current);
    }
  }

  async function saveGlobalEnabled(enabled: boolean) {
    if (!input) return;
    const request = ++requestRef.current;
    const requestScope = scope;
    dispatch({ type: "request-started", scope: requestScope, request });
    setPending({ scope: requestScope, request, action: "global" });
    try {
      const response = await setGlobalEnabled({ ...input, enabled });
      if (scopeRef.current !== requestScope || requestRef.current !== request) return;
      const confirmed = await rereadConfig((value) => value.globallyEnabled === enabled);
      if (scopeRef.current !== requestScope || requestRef.current !== request) return;
      if (!confirmed) {
        dispatch({ type: "action-failed", scope: requestScope, request, message: "The host-wide setting was not confirmed by an authoritative server reread." });
      } else if (!response.ok) {
        dispatch({ type: "action-failed", scope: requestScope, request, message: "TabGoblin is disabled, but authority cleanup is still pending. It was not re-enabled." });
      } else {
        dispatch({ type: "clear-error", scope: requestScope });
        await refreshPanelQueries(refetchers, false);
        if (scopeRef.current !== requestScope || requestRef.current !== request) return;
        toast.show(`TabGoblin ${enabled ? "enabled" : "disabled"} for opted-in workspaces on this host.`, { variant: "success" });
      }
    } catch {
      dispatch({ type: "action-failed", scope: requestScope, request, message: "The host-wide setting was not changed." });
    } finally {
      setGlobalDisableConfirmation(false);
      setPending((current) => current?.scope === requestScope && current.request === request ? null : current);
    }
  }

  async function saveConnection() {
    if (!input) return;
    const request = ++requestRef.current;
    const requestScope = scope;
    const next = { socketPath: socketDraft.trim(), viewerUrl: viewerDraft.trim() };
    dispatch({ type: "request-started", scope: requestScope, request });
    setPending({ scope: requestScope, request, action: "connection" });
    try {
      const response = await updateConnection({ ...input, ...next });
      if (scopeRef.current !== requestScope || requestRef.current !== request) return;
      const confirmed = await rereadConfig((value) => value.socketPath === next.socketPath && value.viewerUrl === next.viewerUrl);
      if (scopeRef.current !== requestScope || requestRef.current !== request) return;
      if (!response.ok || !confirmed) {
        dispatch({ type: "action-failed", scope: requestScope, request, message: response.ok ? "Connection settings were not confirmed by an authoritative server reread." : "Connection settings were saved, but the safe socket handover could not be confirmed." });
        return;
      }
      dispatch({ type: "clear-error", scope: requestScope });
      await refreshPanelQueries(refetchers, false);
      if (scopeRef.current !== requestScope || requestRef.current !== request) return;
      toast.show("Connection settings saved by the TabGoblin server.", { variant: "success" });
    } catch {
      dispatch({ type: "action-failed", scope: requestScope, request, message: "Use an absolute socket path and a credential-free HTTPS or loopback viewer URL." });
    } finally {
      setPending((current) => current?.scope === requestScope && current.request === request ? null : current);
    }
  }

  async function openViewer() {
    if (!viewer) return;
    try { await openExternal(viewer); }
    catch { toast.error("The viewer address could not be opened safely."); }
  }

  async function copyViewer() {
    if (!viewer) return;
    try {
      await copyText(viewer);
      toast.show("Viewer address copied. Pairing codes are never included.", { variant: "success" });
    } catch {
      toast.error("The viewer address could not be copied.");
    }
  }

  const toneColor = state.tone === "ok" ? theme.colors.statusSuccess : state.tone === "warn" ? theme.colors.statusWarning : theme.colors.foregroundMuted;
  const styles = useMemo(() => ({
    content: { padding: layout.compact ? 14 : 24, gap: layout.compact ? 16 : 22, backgroundColor: theme.colors.surface0 },
    header: { gap: 4 },
    eyebrow: { color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "700" as const, letterSpacing: 0.8, textTransform: "uppercase" as const },
    title: { color: theme.colors.foreground, fontSize: layout.compact ? 22 : 26, fontWeight: "800" as const },
    subtext: { color: theme.colors.foregroundMuted, lineHeight: 20 },
    columns: { flexDirection: layout.compact ? "column" as const : "row" as const, alignItems: "flex-start" as const, gap: layout.compact ? 16 : 22 },
    column: { flex: 1, width: layout.compact ? "100%" as const : undefined, gap: 14 },
    card: { gap: 10, padding: layout.compact ? 12 : 16, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 14, backgroundColor: theme.colors.surface1 },
    banner: { gap: 5, padding: layout.compact ? 12 : 16, borderLeftWidth: 4, borderLeftColor: toneColor, borderRadius: 12, backgroundColor: theme.colors.surface1 },
    headline: { color: theme.colors.foreground, fontSize: 18, fontWeight: "800" as const },
    detail: { color: theme.colors.foregroundMuted, lineHeight: 20 },
    meta: { color: theme.colors.foregroundMuted, fontSize: 12 },
    sectionTitle: { color: theme.colors.foreground, fontSize: 17, fontWeight: "700" as const },
    buttonRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
    pairingCode: { color: theme.colors.foreground, fontSize: layout.compact ? 26 : 32, fontWeight: "800" as const, letterSpacing: 2 },
    warning: { color: theme.colors.statusWarning, lineHeight: 20 },
    error: { color: theme.colors.statusDanger, lineHeight: 20 },
    input: { minHeight: 42, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, color: theme.colors.foreground, backgroundColor: theme.colors.surface0 },
    tabRow: { gap: 4, paddingVertical: 8, borderTopWidth: 1, borderTopColor: theme.colors.border },
    tabTitle: { color: theme.colors.foreground, fontWeight: "600" as const },
    tabUrl: { color: theme.colors.foregroundMuted, fontSize: 12 },
    modalBody: { gap: 14 },
  }), [layout.compact, theme, toneColor]);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Text style={styles.eyebrow}>Persistent workspace browser</Text>
        <Text style={styles.title}>TabGoblin · {workspace?.name ?? "Workspace unavailable"}</Text>
        <Text style={styles.subtext}>Server-owned browser state and explicit manual handoff. Snapshots load initially and after successful actions; use Refresh all for an on-demand reread.</Text>
      </View>

      <View style={styles.columns}>
        <View style={styles.column}>
          <View style={styles.banner} accessibilityLiveRegion="polite">
            <Text style={styles.headline}>{state.headline}</Text>
            <Text style={styles.detail}>{state.detail}</Text>
            <Text style={styles.meta}>{lastUpdated(statusQuery.dataUpdatedAt)} · Manual refresh mode; this retained panel does not detect every reopen.</Text>
            {status ? <Text style={styles.meta}>Ownership generation {status.ownership.generation}</Text> : null}
          </View>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Browser actions</Text>
            <View style={styles.buttonRow}>
              <ActionButton label={pending?.action === "start" ? "Starting…" : "Start browser"} onPress={() => input && void perform("start", () => startBrowser(input))} disabled={busy || !input || !available.start || config?.effectiveEnabled !== true} emphasis="primary" colors={theme.colors} />
              <ActionButton label="Stop browser" onPress={() => setStopConfirmation(true)} disabled={busy || !input || !available.stop} emphasis="danger" colors={theme.colors} />
              <ActionButton label="Refresh all" onPress={() => void refreshPanelQueries(refetchers)} disabled={!input || configQuery.isFetching || statusQuery.isFetching || tabsQuery.isFetching || activityQuery.isFetching} colors={theme.colors} />
            </View>
            <View style={styles.buttonRow}>
              <ActionButton label="Open live viewer" onPress={() => void openViewer()} disabled={!available.viewer} emphasis="primary" colors={theme.colors} />
              <ActionButton label="Copy viewer address" onPress={() => void copyViewer()} disabled={!available.viewer} colors={theme.colors} />
            </View>
            {config?.effectiveEnabled === false ? <Text style={styles.warning}>Enable the host-wide master switch and this workspace before starting a browser.</Text> : null}
            {!viewer && viewerSource ? <Text style={styles.warning}>The server returned an unsafe viewer address, so opening and copying are disabled.</Text> : null}
          </View>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Manual handoff</Text>
            <Text style={styles.detail}>Request a short-lived code, open the viewer, then enter the code there. This panel never adds it to a URL.</Text>
            <View style={styles.buttonRow}>
              <ActionButton label={pending?.action === "pair" ? "Requesting…" : "Take control"} onPress={() => void pair()} disabled={busy || !input || !available.pair} emphasis="primary" colors={theme.colors} />
              <ActionButton label="Return to agent" onPress={() => input && void perform("return", () => returnToAgent(input))} disabled={busy || !input || !available.returnToAgent} colors={theme.colors} />
            </View>
            {scopedEphemeral.pairing ? (
              <View style={styles.card} accessibilityLiveRegion="polite">
                <Text style={styles.meta}>One-time viewer code</Text>
                <Text style={styles.pairingCode}>{scopedEphemeral.pairing.code}</Text>
                <Text style={styles.detail}>Enter this code in the viewer. Expires {new Date(scopedEphemeral.pairing.expiresAt).toLocaleTimeString()}.</Text>
              </View>
            ) : null}
          </View>

          <SettingsCard>
            <SettingsSwitch
              label="Enable TabGoblin on this host"
              hint="Master switch: permits new TabGoblin agent enrollment only for workspaces that are separately opted in. Turning it off revokes current TabGoblin authority but does not stop browsers or delete profiles."
              value={config?.globallyEnabled ?? false}
              disabled={busy || !config}
              onValueChange={(enabled) => enabled ? void saveGlobalEnabled(true) : setGlobalDisableConfirmation(true)}
            />
            <SettingsSwitch
              label="Enable for this workspace"
              hint={config?.globallyEnabled ? "Controls this workspace only." : "This opt-in remains separate and is not effective until the host-wide master switch is enabled."}
              value={config?.workspaceEnabled ?? false}
              disabled={busy || !config}
              onValueChange={(enabled) => void saveOptIn(enabled)}
            />
            <SettingsRow
              label="Effective activation"
              hint={config?.effectiveEnabled ? "Host and workspace settings are both enabled." : "TabGoblin agent integration is inactive for this workspace."}
              error={scopedEphemeral.actionError ?? (configQuery.isError ? "Authoritative server configuration is unavailable." : null)}
            >
              {!config ? <ActionButton label="Retry configuration" onPress={() => void configQuery.refetch()} disabled={!input || configQuery.isFetching} colors={theme.colors} /> : null}
            </SettingsRow>
            <SettingsRow label="Gateway socket" hint="Absolute local Unix-socket path used by the plugin server.">
              <TextInput
                accessibilityLabel="Gateway socket path"
                autoCapitalize="none"
                autoCorrect={false}
                editable={!busy && !!config}
                onChangeText={setSocketDraft}
                placeholder="/tmp/tabgoblin.sock"
                placeholderTextColor={theme.colors.foregroundMuted}
                style={styles.input}
                value={socketDraft}
              />
            </SettingsRow>
            <SettingsRow label="External viewer address" hint="Credential-free HTTPS URL, or loopback HTTP for local development. Query strings, fragments and URL credentials are rejected.">
              <TextInput
                accessibilityLabel="External viewer address"
                autoCapitalize="none"
                autoCorrect={false}
                editable={!busy && !!config}
                keyboardType="url"
                onChangeText={setViewerDraft}
                placeholder="https://browser.example/"
                placeholderTextColor={theme.colors.foregroundMuted}
                style={styles.input}
                value={viewerDraft}
              />
            </SettingsRow>
            <SettingsRow label="Save connection settings" hint="The server durably saves these values and performs authority-safe socket handover before confirming success.">
              <ActionButton label={pending?.action === "connection" ? "Saving…" : "Save connection settings"} onPress={() => void saveConnection()} disabled={busy || !input || !config || !connectionChanged} emphasis="primary" colors={theme.colors} />
            </SettingsRow>
          </SettingsCard>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Tabs</Text>
            {status?.sessionState !== "ready" ? <Text style={styles.detail}>Tabs are available after the browser is ready.</Text> : null}
            {status?.sessionState === "ready" && tabsQuery.isLoading ? <Text style={styles.detail}>Loading tabs…</Text> : null}
            {status?.sessionState === "ready" && tabsQuery.isError ? <Text style={styles.warning}>Tabs unavailable. Refresh browser status before trying again.</Text> : null}
            {status?.sessionState === "ready" && tabsQuery.isSuccess && tabs.length === 0 ? <Text style={styles.detail}>No open tabs reported.</Text> : null}
            {status?.sessionState === "ready" && tabsQuery.isSuccess ? tabs.map((tab) => (
              <View key={tab.tabId} style={styles.tabRow}>
                <Text style={styles.tabTitle} numberOfLines={1}>{tab.active ? "Active · " : ""}{tab.title}</Text>
                <Text style={styles.tabUrl} numberOfLines={1}>{tab.url}</Text>
              </View>
            )) : null}
          </View>
        </View>

        <View style={styles.column}>
          <ActivityList
            records={activityQuery.data?.ok ? activityQuery.data.activity : undefined}
            loading={activityQuery.isLoading}
            unavailable={activityQuery.isError}
            theme={theme}
            compact={layout.compact}
          />
        </View>
      </View>

      <Modal title="Stop browser?" open={stopConfirmation} onOpenChange={setStopConfirmation}>
        <Modal.Content>
          <View style={styles.modalBody}>
            <Text style={styles.detail}>Running browsing will end. Your website logins are kept.</Text>
            <View style={styles.buttonRow}>
              <ActionButton label="Keep browser running" onPress={() => setStopConfirmation(false)} colors={theme.colors} />
              <ActionButton label="Stop browser" onPress={() => { setStopConfirmation(false); if (input) void perform("stop", () => stopBrowser(input)); }} disabled={busy} emphasis="danger" colors={theme.colors} />
            </View>
          </View>
        </Modal.Content>
      </Modal>

      <Modal title="Disable TabGoblin on this host?" open={globalDisableConfirmation} onOpenChange={setGlobalDisableConfirmation}>
        <Modal.Content>
          <View style={styles.modalBody}>
            <Text style={styles.detail}>This disables new TabGoblin enrollment for every workspace on this host and revokes current TabGoblin authority. Running browsers and saved website logins are kept.</Text>
            <View style={styles.buttonRow}>
              <ActionButton label="Keep enabled" onPress={() => setGlobalDisableConfirmation(false)} colors={theme.colors} />
              <ActionButton label="Disable on this host" onPress={() => void saveGlobalEnabled(false)} disabled={busy} emphasis="danger" colors={theme.colors} />
            </View>
          </View>
        </Modal.Content>
      </Modal>
    </ScrollView>
  );
}
