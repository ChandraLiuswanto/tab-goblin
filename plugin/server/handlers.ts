import { PROTOCOL_VERSION } from "@tab-goblin/protocol";

export function ping() {
  return { protocolVersion: PROTOCOL_VERSION };
}
