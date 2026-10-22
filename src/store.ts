import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CaseDraft, EdgeType, KnowledgeEdge, KnowledgeNode, SearchResult, SolutionStatus } from "./types";

type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): { run(...values: unknown[]): unknown; all(...values: unknown[]): unknown[]; get(...values: unknown[]): unknown };
  close(): void;
};

type PersistedData = { nodes: KnowledgeNode[]; edges: KnowledgeEdge[] };

export class KnowledgeStore {
  private db?: SqliteDatabase;
  private fallback: PersistedData = { nodes: [], edges: [] };
  private readonly dataDirectory: string;
  private readonly fallbackPath: string;

  constructor(storagePath: string) {
    this.dataDirectory = storagePath;
    this.fallbackPath = path.join(this.dataDirectory, "chronix.json");
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.dataDirectory, { recursive: true });
    try {
      // node:sqlite is available in current VS Code/Electron releases. Dynamic loading
      // keeps the extension installable in older hosts, where JSON remains local-only.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sqlite = require("node:sqlite") as { DatabaseSync: new (file: string) => SqliteDatabase };
      this.db = new sqlite.DatabaseSync(path.join(this.dataDirectory, "chronix.sqlite"));
      this.createSchema();
    } catch {
      await this.loadFallback();
    }
    await this.writeIndex();
  }

  dispose(): void { this.db?.close(); }

  async createCase(draft: CaseDraft): Promise<{ problem: KnowledgeNode; solution: KnowledgeNode }> {
    const category = await this.ensureCategory(draft.category);
    const now = new Date().toISOString();
    const problem: KnowledgeNode = {
      id: crypto.randomUUID(), parentId: category.id, type: "problem", title: draft.title,
      summary: draft.problemSummary, categoryPath: [category.title], tags: draft.tags,
      errorFingerprints: draft.errorFingerprints, metadata: {}, evidence: draft.evidence,
      createdAt: now, updatedAt: now
    };
    const solution: KnowledgeNode = {
      id: crypto.randomUUID(), parentId: problem.id, type: "solution", title: "Primary verified solution",
      summary: draft.primarySolution, categoryPath: problem.categoryPath, status: "verified",
      tags: draft.tags, errorFingerprints: [], metadata: {}, evidence: draft.evidence,
      createdAt: now, updatedAt: now
    };
    await this.upsert(problem);
    await this.upsert(solution);
    await this.writeIndex();
    return { problem, solution };
  }

  async createVariant(parentSolutionId: string, title: string, summary: string, status: SolutionStatus): Promise<KnowledgeNode> {
    const parent = await this.get(parentSolutionId);
    if (!parent || parent.type !== "solution") { throw new Error("Choose a solution node to create a variant."); }
    const now = new Date().toISOString();
    const node: KnowledgeNode = {
      id: crypto.randomUUID(), parentId: parent.id, type: "solution", title, summary,
      categoryPath: parent.categoryPath, status, tags: parent.tags, errorFingerprints: [],
      metadata: {}, createdAt: now, updatedAt: now
    };
    await this.upsert(node);
    await this.writeIndex();
    return node;
  }

  async updateStatus(id: string, status: SolutionStatus): Promise<void> {
    const node = await this.get(id);
    if (!node || node.type !== "solution") { throw new Error("Only solution nodes have an outcome status."); }
    node.status = status;
    node.updatedAt = new Date().toISOString();
    await this.upsert(node);
    await this.writeIndex();
  }

  async addEdge(fromId: string, toId: string, type: EdgeType, note?: string): Promise<void> {
    const edge = { fromId, toId, type, note };
    if (this.db) {
      this.db.prepare("INSERT OR REPLACE INTO edges (from_id, to_id, type, note) VALUES (?, ?, ?, ?)")
        .run(fromId, toId, type, note ?? null);
    } else {
      this.fallback.edges = this.fallback.edges.filter(e => !(e.fromId === fromId && e.toId === toId && e.type === type));
      this.fallback.edges.push(edge);
      await this.saveFallback();
    }
  }

  async children(parentId?: string): Promise<KnowledgeNode[]> {
    const nodes = this.db
      ? this.db.prepare(parentId ? "SELECT * FROM nodes WHERE parent_id = ? ORDER BY type, title" : "SELECT * FROM nodes WHERE parent_id IS NULL ORDER BY title").all(...(parentId ? [parentId] : [] as string[])).map(rowToNode)
      : this.fallback.nodes.filter(n => n.parentId === parentId).sort((a, b) => a.type.localeCompare(b.type) || a.title.localeCompare(b.title));
    return nodes as KnowledgeNode[];
  }

  async get(id: string): Promise<KnowledgeNode | undefined> {
    if (!this.db) { return this.fallback.nodes.find(n => n.id === id); }
    const row = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id);
    return row ? rowToNode(row) : undefined;
  }

  async categories(): Promise<KnowledgeNode[]> { return this.children(); }

  async search(query: string, category?: string, limit = 8): Promise<SearchResult[]> {
    const words = query.toLowerCase().split(/[^a-z0-9_.-]+/).filter(word => word.length > 1);
    const candidates = this.db ? this.allNodes() : this.fallback.nodes;
    return candidates
      .filter(n => n.type !== "category")
      .filter(n => !category || n.categoryPath.includes(category))
      .map(node => ({ node, score: scoreNode(node, words) }))
      .filter(result => result.score > 0)
      .sort((a, b) => b.score - a.score || b.node.updatedAt.localeCompare(a.node.updatedAt))
      .slice(0, limit);
  }

  async related(id: string): Promise<KnowledgeEdge[]> {
    if (!this.db) { return this.fallback.edges.filter(edge => edge.fromId === id || edge.toId === id); }
    return this.db.prepare("SELECT from_id, to_id, type, note FROM edges WHERE from_id = ? OR to_id = ?").all(id, id)
      .map((row: unknown) => { const r = row as Record<string, unknown>; return { fromId: String(r.from_id), toId: String(r.to_id), type: r.type as EdgeType, note: r.note ? String(r.note) : undefined }; });
  }

  private createSchema(): void {
    this.db?.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY, parent_id TEXT, type TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL,
        category_path TEXT NOT NULL, status TEXT, tags TEXT NOT NULL, error_fingerprints TEXT NOT NULL,
        metadata TEXT NOT NULL, evidence TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS edges (
        from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL, note TEXT,
        PRIMARY KEY (from_id, to_id, type)
      );
      CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);
      CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
    `);
  }

  private async ensureCategory(title: string): Promise<KnowledgeNode> {
    const found = (await this.categories()).find(category => category.title.toLowerCase() === title.toLowerCase());
    if (found) { return found; }
    const now = new Date().toISOString();
    const category: KnowledgeNode = { id: crypto.randomUUID(), type: "category", title, summary: "", categoryPath: [title], tags: [], errorFingerprints: [], metadata: {}, createdAt: now, updatedAt: now };
    await this.upsert(category);
    return category;
  }

  private async upsert(node: KnowledgeNode): Promise<void> {
    if (this.db) {
      this.db.prepare(`INSERT OR REPLACE INTO nodes
        (id,parent_id,type,title,summary,category_path,status,tags,error_fingerprints,metadata,evidence,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          node.id, node.parentId ?? null, node.type, node.title, node.summary, JSON.stringify(node.categoryPath), node.status ?? null,
          JSON.stringify(node.tags), JSON.stringify(node.errorFingerprints), JSON.stringify(node.metadata), node.evidence ?? null, node.createdAt, node.updatedAt);
      return;
    }
    const index = this.fallback.nodes.findIndex(item => item.id === node.id);
    if (index >= 0) { this.fallback.nodes[index] = node; } else { this.fallback.nodes.push(node); }
    await this.saveFallback();
  }

  private allNodes(): KnowledgeNode[] {
    return this.db!.prepare("SELECT * FROM nodes").all().map(rowToNode);
  }

  private async loadFallback(): Promise<void> {
    try { this.fallback = JSON.parse(await fs.readFile(this.fallbackPath, "utf8")) as PersistedData; }
    catch { this.fallback = { nodes: [], edges: [] }; }
  }

  private async saveFallback(): Promise<void> {
    await fs.writeFile(this.fallbackPath, JSON.stringify(this.fallback, null, 2), "utf8");
  }

  private async writeIndex(): Promise<void> {
    const nodes = this.db ? this.allNodes() : this.fallback.nodes;
    const index = nodes.filter(node => node.type === "problem").map(node => ({
      id: node.id, title: node.title, summary: node.summary, categoryPath: node.categoryPath,
      tags: node.tags, updatedAt: node.updatedAt, href: `chronix://case/${node.id}`
    }));
    await fs.writeFile(path.join(this.dataDirectory, "index.json"), JSON.stringify(index, null, 2), "utf8");
  }
}

function rowToNode(row: unknown): KnowledgeNode {
  const r = row as Record<string, unknown>;
  return {
    id: String(r.id), parentId: r.parent_id ? String(r.parent_id) : undefined, type: r.type as KnowledgeNode["type"],
    title: String(r.title), summary: String(r.summary), categoryPath: JSON.parse(String(r.category_path)) as string[],
    status: r.status ? r.status as SolutionStatus : undefined, tags: JSON.parse(String(r.tags)) as string[],
    errorFingerprints: JSON.parse(String(r.error_fingerprints)) as string[], metadata: JSON.parse(String(r.metadata)) as Record<string, string>,
    evidence: r.evidence ? String(r.evidence) : undefined, createdAt: String(r.created_at), updatedAt: String(r.updated_at)
  };
}

function scoreNode(node: KnowledgeNode, words: string[]): number {
  const title = node.title.toLowerCase();
  const summary = node.summary.toLowerCase();
  const tags = node.tags.join(" ").toLowerCase();
  const errors = node.errorFingerprints.join(" ").toLowerCase();
  return words.reduce((score, word) => score + (title.includes(word) ? 8 : 0) + (errors.includes(word) ? 6 : 0) + (tags.includes(word) ? 4 : 0) + (summary.includes(word) ? 2 : 0), 0);
}
