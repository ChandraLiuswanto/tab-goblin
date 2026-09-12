import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Text, View } from "react-native";

export function TabGoblinPanel({ theme, layout }: PluginWorkspacePanelProps) {
  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        padding: layout.compact ? 16 : 24,
        backgroundColor: theme.colors.surface0,
      },
      title: { color: theme.colors.foreground, fontSize: layout.compact ? 18 : 22 },
    }),
    [theme, layout.compact],
  );
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>TabGoblin</Text>
    </View>
  );
}
