export type ApprovalNode = { id: string; kind: "person" | "department"; entityId: number; x: number; y: number };
export type ApprovalEdge = { from: string; to: string };
export type ApprovalGraph = { nodes: ApprovalNode[]; edges: ApprovalEdge[] };
export type ApprovalMapDocument = { revision: number; graph: ApprovalGraph; updatedAt: string | null };
