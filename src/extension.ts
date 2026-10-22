import * as vscode from "vscode";
import { KnowledgeStore } from "./store";
import { KnowledgeTreeItem, KnowledgeTreeProvider } from "./tree";
import { CaseDraft, KnowledgeNode, SolutionStatus } from "./types";

const OUTCOMES: SolutionStatus[] = ["verified", "fallback", "partial", "rejected", "superseded"];

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const store = new KnowledgeStore(resolveStoragePath(context));
  await store.initialize();
  const tree = new KnowledgeTreeProvider(store);
  context.subscriptions.push(store, vscode.window.registerTreeDataProvider("chronix.knowledgeTree", tree));

  context.subscriptions.push(
    vscode.commands.registerCommand("chronix.saveConversation", async () => {
      const evidence = await readExplicitCapture();
      if (!evidence) { return; }
      const draft = await collectCaseDraft(evidence, store);
      if (!draft) { return; }
      const { problem } = await store.createCase(draft);
      tree.refresh();
      void vscode.window.showInformationMessage(`Chronix saved “${problem.title}”.`);
    }),
    vscode.commands.registerCommand("chronix.searchMemory", async () => {
      const query = await vscode.window.showInputBox({ prompt: "Describe the problem or paste an error", placeHolder: "e.g. Docker ECONNREFUSED from API container" });
      if (!query?.trim()) { return; }
      const categories = (await store.categories()).map(item => item.title);
      const category = await vscode.window.showQuickPick(["Search all categories", ...categories], { placeHolder: "Optional category filter" });
      if (!category) { return; }
      const results = await store.search(query, category === "Search all categories" ? undefined : category);
      if (!results.length) { void vscode.window.showInformationMessage("Chronix found no matching cases. Save the eventual solution as a new case."); return; }
      const selected = await vscode.window.showQuickPick(results.map(result => ({ label: result.node.title, description: `${result.node.categoryPath.join(" / ")} · score ${result.score}`, detail: result.node.summary, node: result.node })), { matchOnDescription: true, matchOnDetail: true, placeHolder: "Select a past problem or solution" });
      if (selected) { await openNode(selected.node, store); }
    }),
    vscode.commands.registerCommand("chronix.openKnowledgeTree", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.chronix");
    }),
    vscode.commands.registerCommand("chronix.openNode", async (item: KnowledgeTreeItem | KnowledgeNode) => {
      const node = "node" in item ? item.node : item;
      await openNode(node, store);
    }),
    vscode.commands.registerCommand("chronix.copyForAgent", async (item: KnowledgeTreeItem | KnowledgeNode) => {
      const node = "node" in item ? item.node : item;
      const text = await formatForAgent(node, store);
      await vscode.env.clipboard.writeText(text);
      void vscode.window.showInformationMessage("Chronix case summary copied for your agent.");
    }),
    vscode.commands.registerCommand("chronix.createVariant", async (item: KnowledgeTreeItem | KnowledgeNode) => {
      const parent = "node" in item ? item.node : item;
      if (parent.type !== "solution") { void vscode.window.showWarningMessage("Select a solution to add a variant."); return; }
      const title = await vscode.window.showInputBox({ prompt: "Variant or fallback title", value: "Environment-specific variant" });
      const summary = title ? await vscode.window.showInputBox({ prompt: "How does this path differ, and when should it be used?" }) : undefined;
      const status = summary ? await vscode.window.showQuickPick(OUTCOMES, { placeHolder: "Outcome" }) as SolutionStatus | undefined : undefined;
      if (!title || !summary || !status) { return; }
      await store.createVariant(parent.id, title, summary, status);
      tree.refresh();
    }),
    vscode.commands.registerCommand("chronix.changeStatus", async (item: KnowledgeTreeItem | KnowledgeNode) => {
      const node = "node" in item ? item.node : item;
      const status = node.type === "solution" ? await vscode.window.showQuickPick(OUTCOMES, { placeHolder: "Solution outcome" }) as SolutionStatus | undefined : undefined;
      if (!status) { return; }
      await store.updateStatus(node.id, status);
      tree.refresh();
    })
  );
}

export function deactivate(): void {}

function resolveStoragePath(context: vscode.ExtensionContext): string {
  return vscode.workspace.getConfiguration("chronix").get<string>("storagePath", "").trim() || context.globalStorageUri.fsPath;
}

async function readExplicitCapture(): Promise<string | undefined> {
  const editor = vscode.window.activeTextEditor;
  const selected = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection).trim() : "";
  const text = selected || (await vscode.env.clipboard.readText()).trim();
  if (!text) {
    void vscode.window.showWarningMessage("Select editor text or copy a chat conversation before saving it to Chronix.");
    return undefined;
  }
  const limit = vscode.workspace.getConfiguration("chronix").get<number>("captureLimit", 12000);
  return text.slice(0, limit);
}

async function collectCaseDraft(evidence: string, store: KnowledgeStore): Promise<CaseDraft | undefined> {
  const defaultTitle = evidence.split(/\r?\n/).find(line => line.trim().length > 8)?.trim().slice(0, 100) ?? "Untitled solved problem";
  const title = await vscode.window.showInputBox({ prompt: "Problem title", value: defaultTitle, ignoreFocusOut: true });
  if (!title?.trim()) { return undefined; }
  const existing = (await store.categories()).map(item => item.title);
  const configured = vscode.workspace.getConfiguration("chronix").get<string[]>("defaultCategories", []);
  const categoryPick = await vscode.window.showQuickPick([...new Set([...existing, ...configured]), "$(add) Create a category…"], { placeHolder: "Primary category", ignoreFocusOut: true });
  if (!categoryPick) { return undefined; }
  const category = categoryPick.includes("Create a category") ? await vscode.window.showInputBox({ prompt: "New category name" }) : categoryPick.replace("$(add) ", "");
  if (!category?.trim()) { return undefined; }
  const summary = await vscode.window.showInputBox({ prompt: "Concise symptom and root-cause summary", placeHolder: "What failed, and why?", ignoreFocusOut: true });
  const solution = summary ? await vscode.window.showInputBox({ prompt: "Primary verified solution", placeHolder: "What actually fixed it?", ignoreFocusOut: true }) : undefined;
  if (!summary?.trim() || !solution?.trim()) { return undefined; }
  const tagsText = await vscode.window.showInputBox({ prompt: "Tags (comma-separated, optional)", placeHolder: "nodejs, docker, ECONNREFUSED" });
  const tags = (tagsText ?? "").split(",").map(tag => tag.trim()).filter(Boolean);
  return { category: category.trim(), title: title.trim(), problemSummary: summary.trim(), primarySolution: solution.trim(), tags, evidence, errorFingerprints: extractErrorFingerprints(evidence) };
}

function extractErrorFingerprints(evidence: string): string[] {
  return [...new Set(evidence.match(/\b(?:E[A-Z_]{3,}|[A-Za-z]+Error|HTTP\s?\d{3})\b/g) ?? [])].slice(0, 10);
}

async function openNode(node: KnowledgeNode, store: KnowledgeStore): Promise<void> {
  const related = await store.related(node.id);
  const detail = [
    `# ${node.title}`,
    "",
    `**Type:** ${node.type}${node.status ? `  \n**Outcome:** ${node.status}` : ""}`,
    `**Category:** ${node.categoryPath.join(" / ") || "Uncategorized"}`,
    node.tags.length ? `**Tags:** ${node.tags.join(", ")}` : "",
    "",
    "## Summary",
    node.summary,
    node.errorFingerprints.length ? `\n## Error fingerprints\n${node.errorFingerprints.map(item => `- \`${item}\``).join("\n")}` : "",
    related.length ? `\n## Links\n${related.map(edge => `- ${edge.type}: ${edge.fromId === node.id ? edge.toId : edge.fromId}${edge.note ? ` — ${edge.note}` : ""}`).join("\n")}` : "",
    node.evidence ? `\n## Captured context\n\n\`\`\`text\n${node.evidence}\n\`\`\`` : ""
  ].filter(Boolean).join("\n");
  const document = await vscode.workspace.openTextDocument({ content: detail, language: "markdown" });
  await vscode.window.showTextDocument(document, { preview: true });
}

async function formatForAgent(node: KnowledgeNode, store: KnowledgeStore): Promise<string> {
  const parent = node.parentId ? await store.get(node.parentId) : undefined;
  return [
    "Use this Chronix memory only if its environment and symptoms match:",
    `Case: ${parent?.type === "problem" ? parent.title : node.title}`,
    `Category: ${node.categoryPath.join(" / ")}`,
    parent?.summary ? `Problem: ${parent.summary}` : `Problem: ${node.summary}`,
    `Recommended path (${node.status ?? "saved"}): ${node.summary}`,
    node.tags.length ? `Signals: ${node.tags.join(", ")}` : "",
    `Chronix ID: ${node.id}`
  ].filter(Boolean).join("\n");
}
