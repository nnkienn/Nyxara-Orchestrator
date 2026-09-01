declare module "vscode" {
  export const window: any;
  export const commands: any;
  export const workspace: any;
  export const ThemeIcon: any;
  export const ProgressLocation: any;
  export const TreeItemCollapsibleState: any;
  export class TreeItem { constructor(label: string, collapsibleState?: any); label: string; description?: string; tooltip?: string; iconPath?: any; command?: any; }
  export interface ExtensionContext { subscriptions: { push(...items: any[]): void }; secrets: { get(key: string): Promise<string | undefined>; store(key: string, value: string): Promise<void>; delete(key: string): Promise<void> }; }
  export interface TreeDataProvider<T> { getTreeItem(element: T): any; getChildren(element?: T): any; onDidChangeTreeData?: any; }
  export class EventEmitter<T> { event: any; fire(data?: T): void; dispose(): void; }
  export class CancellationToken { isCancellationRequested: boolean; onCancellationRequested: any; }
  export class Uri { static file(path: string): Uri; }
  export class RelativePattern { constructor(base: any, pattern: string); }
}
