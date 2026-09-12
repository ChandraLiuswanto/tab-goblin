// Viewer package typecheck is intentionally standalone (see its package script), while the
// protocol package's generated declarations are build output and may not exist yet.
declare module "@tab-goblin/protocol" {
  export const CSRF_HEADER: "x-tabgoblin-csrf";
  export type OwnershipState =
    | "agent-ready"
    | "taking-control"
    | "manual"
    | "returning-control"
    | "needs-attention";
  export const PairResponseSchema: {
    parse(input: unknown): { workspaceId: string; csrfToken: string; viewOnly: boolean };
  };
}
