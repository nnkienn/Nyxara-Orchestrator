export function webviewHtml(cspSource: string, scriptUri: string, styleUri: string, nonce: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; img-src ${cspSource} data:; style-src ${cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${styleUri}"><title>Nyxara</title></head>
<body><div id="app" class="app-shell">
<header class="app-header"><div class="brand"><span class="logo" aria-hidden="true">N</span><span>NYXARA</span><span id="provider-dot" class="status-dot" title="Provider status" aria-label="Provider status"></span></div><nav aria-label="Nyxara actions"><button id="new-task" class="header-button" type="button" title="New Task" aria-label="New Task"><span aria-hidden="true">＋</span><span>New</span></button><button id="history" class="header-button" type="button" title="Task History" aria-label="Task History"><span>History</span></button><button id="settings" class="icon-button" type="button" title="Settings" aria-label="Settings">⚙</button></nav></header>
<div id="notice" class="notice hidden" role="status" aria-atomic="true"></div>
<main id="timeline" class="timeline" aria-live="polite" aria-relevant="additions text" aria-label="Current Nyxara workflow"><div class="loading">Loading Nyxara…</div></main>
<footer id="composer-wrap" class="composer-wrap"><div id="workspace-warning" class="workspace-warning hidden"></div><div class="composer"><label class="sr-only" for="requirement">What do you want to build?</label><textarea id="requirement" rows="2" maxlength="20000" placeholder="What do you want to build?" aria-label="Task requirement"></textarea><div class="composer-toolbar"><button id="context" class="compact-button" type="button" disabled title="Context actions are not available yet" aria-label="Add context (unavailable)">＋</button><select id="model" aria-label="Current provider and model" title="Current provider and model"></select><button id="submit" class="send-button" type="button" disabled title="Generate Plan (Ctrl/Cmd+Enter)" aria-label="Generate Plan">↑</button></div></div></footer>
</div>
<script nonce="${nonce}" src="${scriptUri}"></script></body></html>`;
}

export function createNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  for (const byte of bytes) value += alphabet[byte % alphabet.length];
  return value;
}
