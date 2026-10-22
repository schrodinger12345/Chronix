# Chronix

Chronix is a local-first VS Code extension for turning selected, solved coding-agent conversations into a searchable troubleshooting tree.

## MVP workflow

1. In an agent chat, copy the useful part of a solved conversation (or select text in an editor).
2. Run **Chronix: Save Solved Conversation**.
3. Confirm the category, problem title, primary solution, and tags.
4. For a new issue, run **Chronix: Search Similar Problems** and copy a relevant case into your agent chat.

Chronix does not silently read chat transcripts. It uses the active editor selection or the clipboard when you explicitly invoke capture.

## Agent-assisted save with MCP

Chronix provides a local MCP server for agents such as Codex and Antigravity. Ask the agent to save a solved issue to Chronix. The agent uses the conversation it already has to produce only the useful case details: title, category, root cause, verified solution, tags, error fingerprints, and an optional short evidence excerpt.

The MCP server first returns a read-only preview. Confirm or correct it in the chat, then the agent calls the separate write tool. Configure the agent to require approval for write tools. The tool descriptions instruct agents not to include a complete transcript, credentials, tokens, or personal data. The manual capture workflow remains available when an MCP client is unavailable.

### Shared local storage

By default, the VS Code extension stores its knowledge in extension global storage. To share the same knowledge with the MCP server, set **Chronix: Storage Path** in VS Code settings to a local folder, for example `C:\Users\you\.chronix`, and pass that same folder to the server with `--storage`.

### MCP server command

Build first, then start the server with:

```powershell
npm.cmd run compile
node .\out\mcpServer.js --storage C:\Users\you\.chronix
```

The server exposes `chronix_preview_solved_case` (read-only) and `chronix_save_solved_case` (write). It communicates over standard input/output; do not run it manually while an MCP client is connected.

## Knowledge shape

```text
Category → problem → primary solution → compatible variant
                    ├─ fallback solution
                    └─ rejected attempt
```

Nodes have one canonical tree parent. Cross-category relationships are recorded as links, avoiding duplicated case histories.

## Storage

The extension stores its local database under VS Code's extension global-storage location, or under the configured shared storage path. The MCP server uses the path supplied by `--storage`. It uses Node's built-in SQLite module when present and falls back to a JSON file in older extension hosts. An inspectable `index.json` is generated alongside the store for fast, human-readable lookup.

## Development

```powershell
npm.cmd install
npm.cmd run compile
```

Press `F5` in VS Code to launch an Extension Development Host. Package a VSIX with `npm.cmd run package`.
