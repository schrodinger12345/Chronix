import * as readline from "node:readline";
import * as path from "node:path";
import { KnowledgeStore } from "./store";
import { CaseDraft } from "./types";

const SERVER_NAME = "chronix";
const SERVER_VERSION = "0.1.0";
const DEFAULT_CAPTURE_LIMIT = 12000;

type JsonRpcId = number | string | null;
type JsonRpcRequest = { jsonrpc?: string; id?: JsonRpcId; method?: string; params?: unknown };
type JsonRecord = Record<string, unknown>;

interface DraftRecord {
  draft: CaseDraft;
  createdAt: number;
}

const draftCache = new Map<string, DraftRecord>();

const previewInputSchema = {
  type: "object",
  properties: {
    title: { type: "string", description: "Short, specific title for the solved problem." },
    category: { type: "string", description: "Primary troubleshooting category, such as Docker, API, Testing, or Tooling." },
    problemSummary: { type: "string", description: "Concise symptom and root-cause summary." },
    primarySolution: { type: "string", description: "The verified fix that resolved the issue." },
    tags: { type: "array", items: { type: "string" }, description: "Optional searchable technical tags." },
    errorFingerprints: { type: "array", items: { type: "string" }, description: "Optional exact error codes or short error fingerprints." },
    evidence: { type: "string", description: "Optional short, non-sensitive excerpt. Never include a full conversation, credentials, tokens, or personal data." }
  },
  required: ["title", "category", "problemSummary", "primarySolution"],
  additionalProperties: false
};

const saveInputSchema = {
  type: "object",
  properties: {
    draftId: { type: "string", description: "The draft ID returned by chronix_preview_solved_case after the user reviewed the preview." }
  },
  required: ["draftId"],
  additionalProperties: false
};

async function main(): Promise<void> {
  const store = new KnowledgeStore(storagePathFromArgs(process.argv.slice(2)));
  await store.initialize();
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", line => { void handleLine(line, store); });
}

async function handleLine(line: string, store: KnowledgeStore): Promise<void> {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch {
    respond(null, undefined, { code: -32700, message: "Invalid JSON-RPC message." });
    return;
  }

  if (!request.method) {
    if (request.id !== undefined) { respond(request.id, undefined, { code: -32600, message: "A method is required." }); }
    return;
  }

  try {
    const result = await handleRequest(request.method, request.params, store);
    if (request.id !== undefined) { respond(request.id, result); }
  } catch (error) {
    if (request.id !== undefined) { respond(request.id, undefined, { code: -32603, message: errorMessage(error) }); }
  }
}

async function handleRequest(method: string, params: unknown, store: KnowledgeStore): Promise<unknown> {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: protocolVersion(params),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: "Chronix stores reusable solved troubleshooting cases locally. Use chronix_preview_solved_case only when the user explicitly asks to save or remember a resolved issue. Extract concise, non-sensitive details from the active conversation. Show the preview to the user and call chronix_save_solved_case only after the user confirms it is accurate."
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: tools() };
    case "tools/call":
      return callTool(params, store);
    default:
      throw new Error(`Unsupported MCP method: ${method}`);
  }
}

function tools(): JsonRecord[] {
  return [
    {
      name: "chronix_preview_solved_case",
      title: "Preview solved case for Chronix",
      description: "Create a concise preview of a solved troubleshooting case from the active conversation. Use only after the user explicitly asks to save or remember a resolved issue. Include only the useful problem, root cause, verified fix, tags, fingerprints, and optional minimal non-sensitive evidence. Do not save data. After showing the result to the user, use chronix_save_solved_case only if the user confirms the preview.",
      inputSchema: previewInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    {
      name: "chronix_save_solved_case",
      title: "Save approved Chronix case",
      description: "Persist a previously previewed Chronix solved-case draft. Use only after chronix_preview_solved_case has returned a draft ID, the preview has been shown to the user, and the user has explicitly confirmed it. This writes local knowledge data.",
      inputSchema: saveInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    }
  ];
}

async function callTool(params: unknown, store: KnowledgeStore): Promise<JsonRecord> {
  const request = asRecord(params, "Invalid tools/call request.");
  const name = requiredString(request.name, "tool name");
  const args = asRecord(request.arguments, "Tool arguments must be an object.");
  if (name === "chronix_preview_solved_case") {
    const draft = toCaseDraft(args);
    const draftId = crypto.randomUUID();
    draftCache.set(draftId, { draft, createdAt: Date.now() });
    purgeExpiredDrafts();
    return textResult(renderPreview(draft, draftId));
  }
  if (name === "chronix_save_solved_case") {
    const draftId = requiredString(args.draftId, "draftId");
    const saved = draftCache.get(draftId);
    if (!saved) { return errorResult("This Chronix draft is unavailable or expired. Create a fresh preview and ask the user to confirm it."); }
    const { problem } = await store.createCase(saved.draft);
    draftCache.delete(draftId);
    return textResult(`Saved Chronix case \"${problem.title}\" in category \"${saved.draft.category}\". The saved record contains only the structured fields and optional short evidence excerpt supplied in the approved preview.`);
  }
  return errorResult(`Unknown Chronix tool: ${name}`);
}

function toCaseDraft(input: JsonRecord): CaseDraft {
  return {
    title: requiredString(input.title, "title"),
    category: requiredString(input.category, "category"),
    problemSummary: requiredString(input.problemSummary, "problemSummary"),
    primarySolution: requiredString(input.primarySolution, "primarySolution"),
    tags: stringArray(input.tags, 20),
    errorFingerprints: stringArray(input.errorFingerprints, 10),
    evidence: optionalString(input.evidence).slice(0, DEFAULT_CAPTURE_LIMIT)
  };
}

function renderPreview(draft: CaseDraft, draftId: string): string {
  return [
    "Chronix draft preview (not saved):",
    `Title: ${draft.title}`,
    `Category: ${draft.category}`,
    `Problem and root cause: ${draft.problemSummary}`,
    `Verified solution: ${draft.primarySolution}`,
    draft.tags.length ? `Tags: ${draft.tags.join(", ")}` : "",
    draft.errorFingerprints.length ? `Error fingerprints: ${draft.errorFingerprints.join(", ")}` : "",
    draft.evidence ? `Evidence excerpt: ${draft.evidence}` : "",
    "",
    `Draft ID: ${draftId}`,
    "Ask the user to confirm or correct this preview. Call chronix_save_solved_case only after explicit confirmation."
  ].filter(Boolean).join("\n");
}

function textResult(text: string): JsonRecord { return { content: [{ type: "text", text }] }; }
function errorResult(text: string): JsonRecord { return { content: [{ type: "text", text }], isError: true }; }

function asRecord(value: unknown, message: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) { throw new Error(message); }
  return value as JsonRecord;
}

function requiredString(value: unknown, label: string): string {
  const text = optionalString(value);
  if (!text) { throw new Error(`Chronix requires ${label}.`); }
  return text;
}

function optionalString(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }

function stringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) { return []; }
  return [...new Set(value.filter((item): item is string => typeof item === "string").map(item => item.trim()).filter(Boolean))].slice(0, limit);
}

function purgeExpiredDrafts(): void {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, draft] of draftCache) { if (draft.createdAt < cutoff) { draftCache.delete(id); } }
}

function protocolVersion(params: unknown): string {
  const requested = params && typeof params === "object" ? (params as JsonRecord).protocolVersion : undefined;
  return typeof requested === "string" ? requested : "2025-06-18";
}

function storagePathFromArgs(args: string[]): string {
  const index = args.indexOf("--storage");
  const storagePath = index >= 0 ? args[index + 1] : process.env.CHRONIX_STORAGE_PATH;
  if (!storagePath) { throw new Error("Chronix MCP requires --storage <absolute-folder> or CHRONIX_STORAGE_PATH."); }
  return path.resolve(storagePath);
}

function respond(id: JsonRpcId, result?: unknown, error?: JsonRecord): void {
  process.stdout.write(`${JSON.stringify(error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result })}\n`);
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "Unexpected Chronix MCP server error."; }

void main().catch(error => {
  process.stderr.write(`Chronix MCP server failed to start: ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
