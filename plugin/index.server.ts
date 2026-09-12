import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ping } from "./server/handlers.js";
import { pingRpc } from "./shared/rpc.js";

export default function contribute(server: PluginServerContext) {
  server.handle(pingRpc, ping);
  return () => {};
}
