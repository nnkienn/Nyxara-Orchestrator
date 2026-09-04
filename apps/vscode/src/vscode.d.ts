declare module "vscode" {
  export const window: any;
  export const commands: any;
  export const workspace: any;
  export const env: any;
  export const ThemeIcon: any;
  export const ProgressLocation: any;
  export const TreeItemCollapsibleState: any;
  export class TreeItem { constructor(label: string, collapsibleState?: any); label: string; description?: string; tooltip?: string; iconPath?: any; command?: any; }
  export interface ExtensionContext { subscriptions: { push(...items: any[]): void }; secrets: { get(key: string): Promise<string | undefined>; store(key: string, value: string): Promise<void>; delete(key: string): Promise<void> }; extension?: { packageJSON?: { version?: string } }; extensionUri: Uri; globalStorageUri?: Uri; }
  export interface TreeDataProvider<T> { getTreeItem(element: T): any; getChildren(element?: T): any; onDidChangeTreeData?: any; }
  export class EventEmitter<T> { event: any; fire(data?: T): void; dispose(): void; }
  export class CancellationToken { isCancellationRequested: boolean; onCancellationRequested: any; }
  export interface Terminal { show(): void; sendText(text: string): void; dispose(): void; }
  export class Uri { readonly fsPath: string; static file(path: string): Uri; static parse(value: string): Uri; }
  export namespace Uri { function joinPath(base: Uri, ...pathSegments: string[]): Uri; }
  export interface Webview { options: any; html: string; cspSource: string; asWebviewUri(uri: Uri): Uri; onDidReceiveMessage(listener: (message: any) => any): any; postMessage(message: any): Promise<boolean>; }
  export interface WebviewView { webview: Webview; }
  export interface WebviewViewProvider { resolveWebviewView(view: WebviewView): void; }
  export class RelativePattern { constructor(base: any, pattern: string); }
  export interface WebviewViewRegistration { dispose(): void; }
}
