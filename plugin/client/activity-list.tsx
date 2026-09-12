import type { ActivityRecord } from "@tab-goblin/protocol";
import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { filterActivity, formatActivityTime, sanitizeActivity, type ActivityFilter } from "./activity-model.js";

export type ActivityListProps = {
  records: readonly ActivityRecord[] | undefined;
  loading: boolean;
  unavailable: boolean;
  theme: PluginTheme;
  compact: boolean;
};

const FILTERS: readonly { value: ActivityFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "errors", label: "Errors" },
  { value: "manual", label: "Manual control" },
];

export function ActivityList({ records, loading, unavailable, theme, compact }: ActivityListProps) {
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const safeRecords = useMemo(() => sanitizeActivity(records), [records]);
  const filtered = useMemo(() => filterActivity(safeRecords, filter), [filter, safeRecords]);
  const styles = useMemo(() => ({
    section: { gap: 10 },
    heading: { color: theme.colors.foreground, fontSize: compact ? 17 : 19, fontWeight: "700" as const },
    filterRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
    filter: { borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
    filterActive: { borderColor: theme.colors.accent, backgroundColor: theme.colors.surface2 },
    filterText: { color: theme.colors.foregroundMuted, fontWeight: "600" as const },
    filterTextActive: { color: theme.colors.foreground },
    list: { gap: 8 },
    row: { gap: 5, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1, borderRadius: 12, padding: compact ? 10 : 12 },
    rowTop: { flexDirection: "row" as const, justifyContent: "space-between" as const, alignItems: "center" as const, gap: 10 },
    action: { color: theme.colors.foreground, fontWeight: "700" as const, flexShrink: 1 },
    time: { color: theme.colors.foregroundMuted, fontSize: 12 },
    meta: { color: theme.colors.foregroundMuted, fontSize: 13 },
    url: { color: theme.colors.foregroundMuted, fontSize: 12 },
    empty: { color: unavailable ? theme.colors.statusWarning : theme.colors.foregroundMuted, lineHeight: 20 },
  }), [compact, theme, unavailable]);

  return (
    <View style={styles.section} accessibilityLabel="Browser activity">
      <Text style={styles.heading}>Activity</Text>
      <View style={styles.filterRow} accessibilityRole="tablist">
        {FILTERS.map((item) => {
          const selected = filter === item.value;
          return (
            <Pressable
              key={item.value}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              accessibilityLabel={`Show ${item.label.toLowerCase()} activity`}
              onPress={() => setFilter(item.value)}
              style={[styles.filter, selected && styles.filterActive]}
            >
              <Text style={[styles.filterText, selected && styles.filterTextActive]}>{item.label}</Text>
            </Pressable>
          );
        })}
      </View>
      {loading && !records ? <Text style={styles.empty}>Loading activity…</Text> : null}
      {unavailable ? <Text style={styles.empty}>Activity unavailable. Previously shown history may be stale.</Text> : null}
      {!loading && !unavailable && safeRecords.length === 0 ? (
        <Text style={styles.empty}>History unavailable after restart</Text>
      ) : null}
      {!loading && !unavailable && safeRecords.length > 0 && filtered.length === 0 ? (
        <Text style={styles.empty}>No activity matches this filter.</Text>
      ) : null}
      <View style={styles.list}>
        {filtered.map((record) => {
          const tone = record.status === "error" ? theme.colors.statusDanger : record.status === "running" ? theme.colors.statusWarning : theme.colors.statusSuccess;
          return (
            <View key={record.operationId} style={styles.row} accessibilityLabel={`${record.action}, ${record.status}`}>
              <View style={styles.rowTop}>
                <Text style={[styles.action, { color: tone }]} numberOfLines={1}>{record.action}</Text>
                <Text style={styles.time}>{formatActivityTime(record.startedAt)}</Text>
              </View>
              <Text style={styles.meta} numberOfLines={1}>
                {record.tabId ? `Tab ${record.tabId}` : "Workspace"}{record.code ? ` · ${record.code}` : ""}
              </Text>
              {record.title ? <Text style={styles.meta} numberOfLines={1}>{record.title}</Text> : null}
              {record.url ? <Text style={styles.url} numberOfLines={1}>{record.url}</Text> : null}
            </View>
          );
        })}
      </View>
    </View>
  );
}
