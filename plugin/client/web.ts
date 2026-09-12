import { Linking, Platform } from "react-native";
import { viewerAddress } from "./panel-model.js";

// Paseo's client bundle has no DOM dependency. This is the only client module that names a DOM global.
declare const window: { open(url: string, target: string, features: string): unknown };

export async function openExternal(rawUrl: string): Promise<void> {
  const url = viewerAddress(rawUrl);
  if (!url) throw new Error("Viewer address is not safe to open");
  if (Platform.OS === "web") {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  await Linking.openURL(url);
}
