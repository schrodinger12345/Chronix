import * as vscode from "vscode";
import { KnowledgeStore } from "./store";
import { KnowledgeNode } from "./types";

export class KnowledgeTreeProvider implements vscode.TreeDataProvider<KnowledgeTreeItem> {
  private readonly changed = new vscode.EventEmitter<KnowledgeTreeItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly store: KnowledgeStore) {}

  refresh(): void { this.changed.fire(undefined); }

  getTreeItem(element: KnowledgeTreeItem): vscode.TreeItem { return element; }

  async getChildren(element?: KnowledgeTreeItem): Promise<KnowledgeTreeItem[]> {
    const children = await this.store.children(element?.node.id);
    return children.map(node => new KnowledgeTreeItem(node, node.type === "solution" ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Collapsed));
  }
}

export class KnowledgeTreeItem extends vscode.TreeItem {
  constructor(readonly node: KnowledgeNode, state: vscode.TreeItemCollapsibleState) {
    super(node.title, state);
    this.id = node.id;
    this.contextValue = `chronix.${node.type}`;
    this.description = node.type === "solution" ? node.status : node.type === "problem" ? node.summary.slice(0, 60) : undefined;
    this.tooltip = `${node.title}\n${node.summary || "Category"}`;
    this.iconPath = iconFor(node);
    if (node.type !== "category") { this.command = { command: "chronix.openNode", title: "Open Chronix item", arguments: [this] }; }
  }
}

function iconFor(node: KnowledgeNode): vscode.ThemeIcon {
  if (node.type === "category") { return new vscode.ThemeIcon("folder-library"); }
  if (node.type === "problem") { return new vscode.ThemeIcon("issue-opened"); }
  return new vscode.ThemeIcon(node.status === "verified" ? "pass-filled" : node.status === "rejected" ? "error" : "git-branch");
}
