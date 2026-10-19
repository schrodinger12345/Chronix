export type NodeType = "category" | "problem" | "solution";
export type SolutionStatus = "verified" | "fallback" | "partial" | "rejected" | "superseded";
export type EdgeType = "related-to" | "supersedes" | "reused-by";

export interface KnowledgeNode {
  id: string;
  parentId?: string;
  type: NodeType;
  title: string;
  summary: string;
  categoryPath: string[];
  status?: SolutionStatus;
  tags: string[];
  errorFingerprints: string[];
  metadata: Record<string, string>;
  evidence?: string;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeEdge {
  fromId: string;
  toId: string;
  type: EdgeType;
  note?: string;
}

export interface CaseDraft {
  category: string;
  title: string;
  problemSummary: string;
  primarySolution: string;
  tags: string[];
  evidence: string;
  errorFingerprints: string[];
}

export interface SearchResult {
  node: KnowledgeNode;
  score: number;
}
