# Nyxara VS Code client (Alpha)

Build from the repository root with `./node_modules/.bin/tsc -p apps/vscode/tsconfig.json` (or `pnpm --filter @nyxara/vscode build` when pnpm is available). Press **F5** in VS Code to launch an Extension Development Host, open a workspace, and run **Nyxara: Generate Plan** from the command palette. Review the structured plan in the Nyxara activity-bar view, then approve and observe Core-owned execution. Provider credentials are read from VS Code SecretStorage.
