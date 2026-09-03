# Nyxara VS Code client (Alpha)

Package from the repository root with `npm run vscode:package`. Install the generated VSIX from Extensions > `...` > **Install from VSIX...**, then reload the window. Alternatively run `code --install-extension dist/vscode/nyxara-vscode-0.1.0-alpha.1.vsix --force`. Use F5 for development/debugging only; use the VSIX for daily dogfood.

Run **Nyxara: Configure Provider** to save the OpenAI-compatible base URL and independent Planner, Executor, and Reviewer model IDs in user settings. The API key is stored only in VS Code SecretStorage. **Nyxara: Test Provider Connection** performs model discovery and does not generate text. Open a workspace, click the Nyxara activity icon, generate a plan, review it, then explicitly approve and run or reject it. Multi-root workspaces always prompt for a root.
