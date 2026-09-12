import type { OwnershipState } from "@tab-goblin/protocol";

export type ViewerUi =
  | { kind: "pairing"; error: string | null }
  | { kind: "connecting" }
  | { kind: "view-only"; ownership: Exclude<OwnershipState, "needs-attention"> }
  | { kind: "controlling" }
  | { kind: "needs-attention" }
  | { kind: "reconnecting" }
  | { kind: "connection-lost" };

export type ViewerUiEvent =
  | { type: "paired" }
  | { type: "socket-open" }
  | { type: "socket-closed" }
  | { type: "ownership"; state: OwnershipState; canControl: boolean }
  | { type: "pair-failed"; message: string };

export function scaleToFit(
  remote: { width: number; height: number },
  viewport: { width: number; height: number },
): { scale: number; offsetX: number; offsetY: number } {
  if (
    !Number.isFinite(remote.width) ||
    !Number.isFinite(remote.height) ||
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    remote.width <= 0 ||
    remote.height <= 0 ||
    viewport.width < 0 ||
    viewport.height < 0
  ) {
    throw new RangeError("dimensions must be finite, with a positive remote size");
  }

  const scale = Math.min(1, viewport.width / remote.width, viewport.height / remote.height);
  return {
    scale,
    offsetX: (viewport.width - remote.width * scale) / 2,
    offsetY: (viewport.height - remote.height * scale) / 2,
  };
}

export function nextUi(current: ViewerUi, event: ViewerUiEvent): ViewerUi {
  switch (event.type) {
    case "pair-failed":
      return { kind: "pairing", error: event.message };
    case "paired":
      return current.kind === "pairing" ? { kind: "connecting" } : current;
    case "socket-open":
      return { kind: "view-only", ownership: "agent-ready" };
    case "socket-closed":
      return current.kind === "pairing" ? current : { kind: "reconnecting" };
    case "ownership":
      if (event.state === "needs-attention") return { kind: "needs-attention" };
      if (event.canControl) return { kind: "controlling" };
      return { kind: "view-only", ownership: event.state };
  }
}
