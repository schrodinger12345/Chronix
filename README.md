# Chronix

Chronix is a local-first VS Code extension for turning selected, solved coding-agent conversations into a searchable troubleshooting tree.

## MVP workflow

1. In an agent chat, copy the useful part of a solved conversation (or select text in an editor).
2. Run **Chronix: Save Solved Conversation**.
3. Confirm the category, problem title, primary solution, and tags.
4. For a new issue, run **Chronix: Search Similar Problems** and copy a relevant case into your agent chat.

Chronix does not silently read chat transcripts. It uses the active editor selection or the clipboard when you explicitly invoke capture.

## Knowledge shape

```text
Category → problem → primary solution → compatible variant
                    ├─ fallback solution
                    └─ rejected attempt
```

Nodes have one canonical tree parent. Cross-category relationships are recorded as links, avoiding duplicated case histories.

## Storage

The extension stores its local database under VS Code's extension global-storage location. It uses Node's built-in SQLite module when present and falls back to a JSON file in older extension hosts. An inspectable `index.json` is generated alongside the store for fast, human-readable lookup.

## Development

```powershell
npm.cmd install
npm.cmd run compile
```

Press `F5` in VS Code to launch an Extension Development Host. Package a VSIX with `npm.cmd run package`.
