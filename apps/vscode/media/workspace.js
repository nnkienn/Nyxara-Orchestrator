(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  const el = (id) => document.getElementById(id);
  const timeline = el("timeline");
  const input = el("requirement");
  const submit = el("submit");
  const PROMPT_PREVIEW_CHARACTERS = 480;
  const PROMPT_PREVIEW_LINES = 6;
  let state;
  let sending = false;
  let submittedTask;
  let renderedScreen;
  let settingsQuery = "";
  let modelModeProjection;
  let modelModeDraft;
  let appliedDraft;
  // One lightweight UI-only clock. It formats elapsed time from the authoritative
  // stageStartedAt and never asks the extension, Core, or a provider for anything.
  let stageTimer;
  let stageTimerKey;
  const disclosures = new Map();

  const node = (tag, className, text) => {
    const value = document.createElement(tag);
    if (className) value.className = className;
    if (text !== undefined) value.textContent = String(text);
    return value;
  };
  const button = (label, className, type, extra) => {
    const value = node("button", className, label);
    value.type = "button";
    value.addEventListener("click", () => vscode.postMessage(Object.assign({ type }, extra || {})));
    return value;
  };
  /** Expands a collapsed section locally; disclosure state is pure presentation. */
  const expandButton = (label, className, key) => {
    const value = node("button", className, label);
    value.type = "button";
    value.addEventListener("click", () => {
      disclosures.set(key, true);
      vscode.postMessage({ type: "toggleDisclosure", key, expanded: true });
      if (state) render();
    });
    return value;
  };
  const formatDuration = (ms) => ms == null ? "-" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
  const formatSummaryDuration = (ms) => ms == null ? null : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1).replace(/\.0$/, "")}s`;
  const formatHistoryDuration = (ms) => ms == null ? null : `${Math.max(1, Math.round(ms / 1000))}s`;
  const formatNumber = (value) => value == null ? "-" : Number(value).toLocaleString();
  const formatBytes = (value) => value == null || !Number.isFinite(value) || value < 0 ? "-" : value < 1024 ? `${Math.round(value)} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / (1024 * 1024)).toFixed(1)} MB`;
  const formatCost = (amount, currency) => {
    if (amount == null) return "-";
    if (typeof currency === "string" && /^[A-Za-z]{3}$/.test(currency)) {
      try { return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase(), maximumFractionDigits: 6 }).format(amount); } catch { /* render the safe numeric fallback */ }
    }
    return formatNumber(amount);
  };
  const friendly = (value) => String(value || "pending").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  const compactTokens = (value) => value == null ? null : value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1).replace(/\.0$/, "")}K` : `${value}`;
  const elapsedLabel = (startedAt) => {
    const started = Date.parse(startedAt || "");
    if (!Number.isFinite(started)) return null;
    const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  };
  const outcomeOf = (task) => task.status === "rejected" ? "rejected" : task.status;
  const outcomeLabel = (outcome) => outcome === "rejected" ? "Plan Rejected" : outcome === "completed" ? "Completed" : friendly(outcome);
  const historyOutcomeLabel = (outcome) => outcome === "rejected" ? "Rejected" : outcomeLabel(outcome);
  /** Rejection and abort are neutral: red error styling is reserved for real failures. */
  const outcomeClass = (outcome) => outcome === "completed" ? "outcome-success" : outcome === "failed" ? "outcome-failure" : "outcome-neutral";
  const stageOccurred = (stages, stage) => Array.isArray(stages) && stages.includes(stage);
  const isNearBottom = () => timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 72;
  const workflowStatus = () => state.workflow && state.workflow.status;
  const isTerminal = () => !!state.completion;
  const afterApproval = () => !!state.workflow && !["created", "planning", "awaiting_plan_approval"].includes(state.workflow.status);
  const liveDisclosureKey = (name) => `${name}:${state.workflow && state.workflow.id || state.plan && state.plan.id || "task"}`;
  const disclosureKeyFor = (name, viewState) => `${name}:${viewState.workflow && viewState.workflow.id || viewState.plan && viewState.plan.id || "task"}`;
  const historyState = () => state.history || { screen: "workspace", recentTasks: [], tasks: [], query: "", filter: "all", scope: "all" };
  const terminalHistoryStatus = (status) => ["completed", "failed", "aborted", "rejected", "interrupted"].includes(status);
  const hasPerformance = (projection) => {
    if (!projection) return false;
    const overview = projection.overview || {};
    return [overview.inputTokens, overview.outputTokens, overview.totalTokens, overview.workflowDurationMs, overview.providerCalls, overview.toolCalls, overview.repairCycles, overview.validationStatus, overview.reviewStatus, overview.cost].some((value) => value !== null && value !== undefined)
      || (projection.roles || []).some((role) => [role.providerConfigId, role.providerId, role.requestedModelId, role.resolvedModelId, role.calls, role.totalTokens, role.providerDurationMs].some((value) => value !== null && value !== undefined))
      || (projection.executorTasks || []).length > 0 || (projection.validation && projection.validation.steps || []).length > 0 || (projection.tools && projection.tools.byName || []).length > 0;
  };
  const hasTaskPerformance = (task) => hasPerformance(task.performanceSummary) || !!task.usageSummary && Object.values(task.usageSummary).some((value) => value !== null && value !== undefined);
  const hasProviderUsage = (value) => {
    if (!value) return false;
    const overview = value.overview || value;
    if (Number(overview.providerCalls) > 0) return true;
    if ([overview.inputTokens, overview.cacheReadTokens, overview.cacheWriteTokens, overview.outputTokens, overview.processedTokens, overview.totalTokens].some((metric) => typeof metric === "number" && metric > 0)) return true;
    return (value.roles || []).some((role) => Number(role.calls) > 0);
  };
  const canViewPerformance = (projection, outcome) => outcome === "rejected" ? hasProviderUsage(projection) : hasPerformance(projection);
  const canViewTaskPerformance = (task) => outcomeOf(task) === "rejected"
    ? hasProviderUsage(task.performanceSummary || task.usageSummary)
    : hasTaskPerformance(task);

  function relativeTime(timestamp) {
    const elapsed = Math.max(0, Date.now() - Date.parse(timestamp));
    if (elapsed < 60_000) return "now";
    if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
    if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
    if (elapsed < 172_800_000) return "yesterday";
    return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function taskRow(task, includeWorkspace) {
    const value = node("button", "history-row");
    value.type = "button";
    value.setAttribute("aria-label", `Open ${task.title}`);
    const head = node("span", "history-row-head");
    head.append(node("span", "history-title", task.title), node("span", "history-time", relativeTime(task.updatedAt)));
    // Compact row: outcome plus at most two metrics. Plan content never appears here.
    const outcome = outcomeOf(task);
    const meta = [historyOutcomeLabel(outcome)];
    const usage = task.performanceSummary ? task.performanceSummary.overview : task.usageSummary;
    if (outcome !== "rejected" && usage && (usage.totalTokens != null)) meta.push(`${compactTokens(usage.totalTokens)} tokens`);
    if (outcome !== "rejected" && usage && (usage.workflowDurationMs != null)) meta.push(formatHistoryDuration(usage.workflowDurationMs));
    if (includeWorkspace) meta.push(task.workspaceIdentity.label);
    value.append(head, node("span", `history-meta status-${task.status}`, meta.join(" · ")));
    value.addEventListener("click", () => vscode.postMessage({ type: "openTask", taskId: task.id }));
    return value;
  }

  function renderRecentTasks() {
    const recent = historyState().recentTasks || [];
    const section = node("section", "recent-section");
    const head = node("div", "section-heading");
    head.append(node("h2", "", "Recent Tasks"));
    if (recent.length) head.append(button("View all", "link-button", "openHistory"));
    section.append(head);
    if (!recent.length) {
      section.append(node("p", "muted history-empty", "No tasks yet."), node("p", "muted history-empty", "Start your first task below."));
    } else recent.forEach((task) => section.append(taskRow(task, false)));
    timeline.append(section);
  }

  /**
   * Collapsible section. Terminal and historical detail collapse by default so
   * the sidebar shows a summary instead of replaying the whole timeline.
   */
  function disclosure(key, title, meta, defaultExpanded) {
    const expanded = disclosures.has(key) ? disclosures.get(key) : !!defaultExpanded;
    const value = node("details", "section-disclosure");
    if (expanded) value.setAttribute("open", "true");
    const summary = node("summary", "section-disclosure-title");
    summary.setAttribute("aria-expanded", String(expanded));
    summary.append(node("span", "", title));
    if (meta) summary.append(node("span", "muted section-disclosure-meta", meta));
    summary.addEventListener("click", () => {
      const next = !(disclosures.has(key) ? disclosures.get(key) : !!defaultExpanded);
      disclosures.set(key, next);
      summary.setAttribute("aria-expanded", String(next));
      vscode.postMessage({ type: "toggleDisclosure", key, expanded: next });
    });
    value.append(summary);
    return value;
  }

  function promptIsLong(text) {
    return text.length > PROMPT_PREVIEW_CHARACTERS || text.split(/\r?\n/).length > PROMPT_PREVIEW_LINES;
  }

  function promptPreview(text) {
    const lineBounded = text.split(/\r?\n/).slice(0, PROMPT_PREVIEW_LINES).join("\n");
    if (lineBounded.length <= PROMPT_PREVIEW_CHARACTERS && lineBounded.length === text.length) return text;
    const characterBounded = lineBounded.slice(0, PROMPT_PREVIEW_CHARACTERS).trimEnd();
    const wordBoundary = characterBounded.lastIndexOf(" ");
    const preview = wordBoundary > PROMPT_PREVIEW_CHARACTERS * 0.7 ? characterBounded.slice(0, wordBoundary) : characterBounded;
    return `${preview}\n…`;
  }

  /** Prompt collapse is local presentation state; full requirement data stays unchanged. */
  function appendCompactPrompt(host, text, key) {
    const long = promptIsLong(text);
    const expanded = long && disclosures.get(key) === true;
    host.append(node("div", `requirement-text${long && !expanded ? " requirement-preview" : ""}`, expanded || !long ? text : promptPreview(text)));
    if (!long) return;
    const toggle = node("button", "link-button prompt-toggle", expanded ? "Hide prompt" : "Show full prompt");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.addEventListener("click", () => {
      disclosures.set(key, !expanded);
      if (state) render();
    });
    host.append(toggle);
  }

  function renderTaskHeader(host, title, outcome) {
    const head = node("div", `outcome-head ${outcomeClass(outcome)}`);
    head.append(node("h2", "", title));
    host.append(head);
  }

  function renderUsageSummary(host, parts) {
    const line = parts.filter(Boolean).join(" · ");
    if (line) host.append(node("p", "muted usage-line", line));
  }

  function addActions(value, items) {
    const actions = node("div", "actions");
    items.forEach((item) => actions.append(item));
    value.append(actions);
  }

  function card(title, className) {
    const value = node("section", `card${className ? ` ${className}` : ""}`);
    value.append(node("h2", "", title));
    return value;
  }

  function renderEmpty() {
    const empty = node("section", "empty");
    empty.append(node("div", "empty-mark", "NYXARA"));
    if (!state.configured) {
      empty.append(node("p", "", "Connect an AI provider to start."), button("Connect Provider", "primary", "openProviderSetup"));
    } else if (!state.workspace.available) {
      empty.append(node("p", "", "Open a folder or workspace to start a coding task."));
    } else {
      empty.append(node("p", "", "Describe a coding task below. Nyxara will create a structured plan for your approval."));
    }
    timeline.append(empty);
    renderRecentTasks();
  }

  const SETTINGS_SECTIONS = [
    ["aiProviders", "AI Providers", "provider connect account credential sign out disconnect remove"],
    ["modelsRoles", "Models & Roles", "default simple advanced planner executor reviewer repair model routing execution reasoning thinking provider default"],
    ["workflow", "Workflow", "approval pause resume automatic repair cycles attempts validation typecheck lint tests build timeout fail fast review reviewer turns permission abort"],
    ["planning", "Planning", "profile locale conservative concise detailed"],
    ["engineeringRules", "Engineering Rules", "rules precedence scope severity n+1 secret dependencies"],
    ["permissions", "Permissions", "allowed ask first sensitive destructive sudo git push deployment"],
    ["context", "Context", "repository targeted bounded files"],
    ["validation", "Validation", "typecheck lint tests build fail fast timeout"],
    ["review", "Review", "reviewer evidence rules failures context"],
    ["repair", "Repair", "automatic validation cycles executor replan"],
    ["usage", "Usage & Performance", "usage performance tokens latency context tools cost repair reasoning thinking execution provider reported estimated local"],
    ["taskHistory", "Task History", "history retention local clear tasks"],
    ["workspace", "Workspace", "root folder profile rules"],
    ["privacy", "Privacy & Storage", "secretstorage local telemetry cloud sync account requests"],
    ["advanced", "Advanced", "manual model endpoint routing limits diagnostics"],
    ["about", "About", "version diagnostics dogfood engine"],
  ];

  function settingRow(label, detail, section, extra) {
    const value = node("button", "settings-row"); value.type = "button";
    const copy = node("span", "settings-row-copy"); copy.append(node("span", "settings-row-title", label), node("span", "settings-row-detail", detail || ""));
    value.append(copy, node("span", "settings-chevron", "›"));
    value.addEventListener("click", () => vscode.postMessage(Object.assign({ type: "openSettingsSection", section }, extra || {})));
    return value;
  }

  function settingsHeading(title, detailBack) {
    const heading = node("div", "settings-heading");
    const backType = state.settings.section === "home" ? "closeSettings" : "openSettingsSection";
    const backExtra = backType === "openSettingsSection" ? { section: detailBack || "home" } : undefined;
    heading.append(button("←", "icon-button", backType, backExtra), node("h1", "", title));
    if (state.settings.section !== "home") heading.append(button("Home", "link-button", "openSettingsSection", { section: "home" }));
    timeline.append(heading);
  }

  function labeledValue(label, value, className) {
    const row = node("div", `settings-value${className ? ` ${className}` : ""}`);
    row.append(node("span", "muted", label), node("span", "settings-value-main", value)); return row;
  }

  function renderSettingsHome(projection) {
    settingsHeading("Settings");
    const search = node("input", "settings-search"); search.type = "search"; search.placeholder = "Search settings…"; search.maxLength = 200; search.value = settingsQuery; search.setAttribute("aria-label", "Search settings locally");
    const results = node("div", "settings-list");
    const populate = () => {
      settingsQuery = search.value.slice(0, 200); results.replaceChildren(); const query = settingsQuery.trim().toLocaleLowerCase();
      const entries = SETTINGS_SECTIONS.filter((entry) => !query || `${entry[1]} ${entry[2]}`.toLocaleLowerCase().includes(query));
      entries.forEach(([section, label]) => {
        let detail = "";
        if (section === "aiProviders") detail = `${projection.providers.filter((provider) => ["Connected", "Local available"].includes(provider.status)).length} connected / available · ${projection.providers.length} configured`;
        else if (section === "modelsRoles") detail = projection.modelMode === "simple" ? "Default / Simple" : "Advanced";
        else if (section === "taskHistory") detail = `${projection.history.count} / ${projection.history.retention} local tasks`;
        else if (section === "planning") detail = projection.planning.profiles.find((profile) => profile.id === projection.planning.selectedProfileId)?.name || projection.planning.selectedProfileId;
        results.append(settingRow(label, detail, section));
      });
      if (!entries.length) results.append(node("p", "muted settings-empty", "No matching settings."));
    };
    search.addEventListener("input", populate); timeline.append(search, results); populate();
  }

  function providerBadge(status) {
    const badge = node("span", `provider-status status-${String(status).toLocaleLowerCase().replaceAll(" ", "-")}`, status); return badge;
  }

  function renderProviderDetails(projection, provider) {
    settingsHeading("Provider Details", "aiProviders");
    const cardValue = card(provider.displayName, "provider-detail");
    const authPending = projection.pendingAuth && projection.pendingAuth.providerConfigId === provider.id;
    const providerManagedModel = provider.authStrategy === "subscription_cli" && !provider.supportsModelDiscovery;
    const modelSummary = provider.modelsStatus === "loading" ? "Loading…" : providerManagedModel ? "Provider-managed default" : `${provider.models.length} available · ${friendly(provider.modelsStatus)}`;
    const refreshedSummary = providerManagedModel ? "Managed by official CLI" : provider.modelsLastRefreshedAt || "Never";
    cardValue.append(providerBadge(authPending ? "Pending" : provider.status), labeledValue("Display Name", provider.displayName), labeledValue("Provider", provider.providerName), labeledValue("Category", provider.category), labeledValue("Authentication", authPending ? "Waiting for browser sign-in…" : provider.authentication), labeledValue("Connection", provider.connectionMessage), labeledValue("Endpoint", provider.endpoint), labeledValue("Default Model", provider.defaultModel || "Not selected"), labeledValue("Models", modelSummary), labeledValue("Last Refreshed", refreshedSummary));
    if (provider.isDefault) cardValue.append(node("div", "default-pill", "Default AI"));
    if (provider.endpoint !== "Official" && provider.endpoint !== "Managed by official CLI") {
      const edit = node("div", "provider-edit"); const nameInput = node("input", "settings-input"); nameInput.value = provider.displayName; nameInput.maxLength = 100; nameInput.setAttribute("aria-label", "Provider display name"); const endpointInput = node("input", "settings-input"); endpointInput.value = provider.endpoint; endpointInput.maxLength = 2048; endpointInput.setAttribute("aria-label", "Provider endpoint"); const save = node("button", "secondary", "Save Name & Endpoint"); save.type = "button"; save.addEventListener("click", () => { if (nameInput.value.trim() && endpointInput.value.trim()) vscode.postMessage({ type: "updateProviderMetadata", providerConfigId: provider.id, displayName: nameInput.value.trim(), endpoint: endpointInput.value.trim() }); }); edit.append(node("div", "field-label", "Edit Configuration"), nameInput, endpointInput, save); cardValue.append(edit);
    }
    const actions = node("div", "settings-actions");
    if (authPending) actions.append(node("p", "muted", "Waiting for browser sign-in…"), button("Cancel", "secondary", "cancelBrowserAuth", { providerConfigId: provider.id, sessionId: projection.pendingAuth.sessionId }));
    else if (provider.supportsBrowserAuth) actions.append(button("Sign In with Browser", "secondary", "startBrowserAuth", { providerConfigId: provider.id }));
    if (provider.authMethods.includes("api_key")) actions.append(button(provider.credentialStored ? "Update API Key" : "Add API Key", "secondary", "updateCredential", { providerConfigId: provider.id }));
    const testConnection = button("Test Connection", "secondary", "testProvider", { providerConfigId: provider.id }); testConnection.disabled = provider.status === "Signed out"; actions.append(testConnection);
    const refreshModels = button("Refresh Models", "secondary", "refreshModels", { providerConfigId: provider.id }); refreshModels.disabled = !provider.supportsModelDiscovery || provider.status === "Signed out" || provider.modelsStatus === "loading"; actions.append(refreshModels);
    if (provider.modelsMessage) actions.append(node("p", "muted", provider.modelsMessage));
    actions.append(button("Configure Models & Roles", "secondary", "openSettingsSection", { section: "modelsRoles" }));
    if (provider.lifecycleBlocked) actions.append(node("p", "muted", "This provider is in use by the active workflow. Finish or abort the workflow before signing out or removing it."));
    if (provider.lifecycleAction !== "Remove Provider" && provider.status !== "Signed out") { const lifecycle = button(provider.lifecycleAction, "danger", "signOutProvider", { providerConfigId: provider.id }); lifecycle.disabled = provider.lifecycleBlocked; actions.append(lifecycle); }
    const remove = button("Remove Provider", "danger-link settings-remove", "removeProvider", { providerConfigId: provider.id }); remove.disabled = provider.lifecycleBlocked; actions.append(remove);
    cardValue.append(actions); timeline.append(cardValue);
    const roles = projection.roles.filter((role) => role.providerConfigId === provider.id);
    if (roles.length) { const used = card("Role References"); roles.forEach((role) => used.append(labeledValue(friendly(role.role), role.available ? `${role.modelId} · Available` : `${role.modelId || "No model"} · ${role.status}`, role.available ? "" : "failed"))); if (!roles.every((role) => role.available)) used.append(node("p", "muted", "Reconnect this provider or choose another provider in Models & Roles. Assignments are never silently rerouted."), button("Choose Another Provider", "secondary", "openSettingsSection", { section: "modelsRoles" })); timeline.append(used); }
  }

  function renderProviders(projection) {
    const selectedId = state.settings.providerConfigId;
    if (selectedId) { const provider = projection.providers.find((item) => item.id === selectedId); if (provider) { renderProviderDetails(projection, provider); return; } }
    settingsHeading("AI Providers");
    if (projection.pendingAuth && !projection.providers.some((provider) => provider.id === projection.pendingAuth.providerConfigId)) {
      const pending = card("Connecting Provider", "provider-detail"); pending.append(providerBadge("Pending"), node("p", "muted", "Waiting for browser sign-in…"), button("Cancel", "secondary", "cancelBrowserAuth", { providerConfigId: projection.pendingAuth.providerConfigId, sessionId: projection.pendingAuth.sessionId })); timeline.append(pending);
    }
    if (!projection.providers.length) timeline.append(node("p", "muted settings-empty", "No providers configured."));
    else {
      const list = node("div", "settings-list");
      projection.providers.forEach((provider) => {
        const row = settingRow(provider.displayName, `${provider.providerName} · ${provider.status}${provider.isDefault ? " · Default" : ""}`, "aiProviders", { providerConfigId: provider.id });
        row.append(providerBadge(provider.status)); list.append(row);
      }); timeline.append(node("div", "eyebrow", "Configured Providers"), list);
    }
    timeline.append(button("+ Connect Provider", "primary settings-wide", "connectProvider"));
  }

  function providerSelect(projection, selectedId, label) {
    const select = node("select", "settings-select"); select.setAttribute("aria-label", label);
    select._providerOptions = [];
    projection.providers.forEach((provider) => { const option = node("option", "", `${provider.displayName} · ${provider.status}`); option.value = provider.id; option.selected = provider.id === selectedId; option.disabled = ["Signed out", "Credential missing", "Unavailable"].includes(provider.status); select._providerOptions.push({ option, text: `${provider.displayName} ${provider.providerName} ${provider.defaultModel || ""}`.toLocaleLowerCase() }); select.append(option); });
    return select;
  }

  function discoveredModelPicker(projection, providerControl, modelInput) {
    const host = node("div", "discovered-model-picker");
    const select = node("select", "settings-select model-select");
    const label = modelInput.getAttribute("aria-label") || "Model";
    select.setAttribute("aria-label", label);
    modelInput.setAttribute("aria-label", `${label} ID (manual)`);
    const status = node("p", "muted model-picker-status");
    const notifyChange = () => modelInput.dispatchEvent(new Event("input"));
    const render = () => {
      select.replaceChildren();
      const provider = projection.providers.find((item) => item.id === providerControl.value);
      const models = provider && provider.models || [];
      const selectedId = modelInput.value.trim();
      const placeholder = node("option", "", provider && provider.modelsStatus === "loading" ? "Loading models…" : "Choose a model…");
      placeholder.value = ""; placeholder.disabled = true; select.append(placeholder);
      models.forEach((model) => {
        const option = node("option", "", model.name && model.name !== model.id ? `${model.name} · ${model.id}` : model.id);
        option.value = `model:${model.id}`; select.append(option);
      });
      if (selectedId && !models.some((model) => model.id === selectedId)) {
        const saved = node("option", "", selectedId); saved.value = `model:${selectedId}`; select.append(saved);
      }
      if (provider && provider.supportsManualModelId !== false) {
        const manual = node("option", "", "Enter model ID manually…"); manual.value = "manual"; select.append(manual);
      }
      select.value = selectedId ? `model:${selectedId}` : "";
      select.disabled = !provider;
      select.title = selectedId;
      modelInput.classList.add("hidden");
      status.classList.toggle("hidden", models.length > 0);
      status.textContent = provider && provider.modelsMessage || (provider && provider.modelsStatus === "loading" ? "Loading available models…" : "No discovered models. Refresh Models in AI Providers or enter a model ID manually.");
    };
    select.addEventListener("change", () => {
      const manual = select.value === "manual";
      modelInput.classList.toggle("hidden", !manual);
      if (manual) { modelInput.focus(); modelInput.select(); return; }
      modelInput.value = select.value.startsWith("model:") ? select.value.slice(6) : "";
      select.title = modelInput.value;
      notifyChange();
    });
    providerControl.addEventListener("change", () => {
      const provider = projection.providers.find((item) => item.id === providerControl.value);
      modelInput.value = provider && provider.defaultModel || "";
      render(); notifyChange();
    });
    host.append(select, modelInput, status); render();
    return host;
  }

  function executionCapability(provider, modelId) {
    const exact = String(modelId || "").trim();
    return (provider && provider.models || []).find((model) => model.id === exact)?.capabilities?.execution;
  }

  function executionSupported(options, capability) {
    if (!options || options.kind === "provider_default") return true;
    if (!capability || options.kind !== capability.kind) return false;
    if (capability.control === "select") {
      const selected = options.effort === undefined ? options.level : options.effort;
      return capability.values.some((item) => item.value === selected);
    }
    const budget = Number(options.budgetTokens);
    return Number.isFinite(budget) && Number.isInteger(budget) && ((capability.allowZero && budget === 0) || (budget >= capability.minimumBudgetTokens && budget <= capability.maximumBudgetTokens));
  }

  function executionEditor(projection, providerControl, modelControl, initialOptions, initiallyStale, initialCapability, initialProviderId, initialModelId) {
    const host = node("div", "execution-config");
    let current = initialOptions || { kind: "provider_default" };
    const render = () => {
      host.replaceChildren();
      const provider = projection.providers.find((item) => item.id === providerControl.value);
      const capability = executionCapability(provider, modelControl.value) || (providerControl.value === initialProviderId && modelControl.value.trim() === String(initialModelId || "").trim() ? initialCapability : undefined);
      const stale = initiallyStale || (current.kind !== "provider_default" && !executionSupported(current, capability));
      host.append(node("label", "field-label", capability ? capability.label : "Execution"));
      if (capability && capability.control === "select") {
        const select = node("select", "settings-select");
        const defaultOption = node("option", "", "Provider Default"); defaultOption.value = "__provider_default__"; select.append(defaultOption);
        capability.values.forEach((item) => { const option = node("option", "", item.label); option.value = item.value; select.append(option); });
        const selected = current.kind === capability.kind ? (current.effort === undefined ? current.level : current.effort) : "__provider_default__";
        select.value = stale ? "__provider_default__" : selected;
        select.addEventListener("change", () => {
          if (select.value === "__provider_default__") current = { kind: "provider_default" };
          else current = capability.kind === "openai_reasoning" || capability.kind === "anthropic_effort" ? { kind: capability.kind, effort: select.value } : { kind: capability.kind, level: select.value };
          initiallyStale = false; render();
        });
        host.append(select, node("p", "muted", `Capability source: ${friendly(capability.provenance)}`));
      } else if (capability && capability.control === "toggle_number") {
        const mode = node("select", "settings-select");
        const defaultOption = node("option", "", "Provider Default"); defaultOption.value = "default"; mode.append(defaultOption);
        const enabledOption = node("option", "", capability.enabledLabel); enabledOption.value = "enabled"; mode.append(enabledOption);
        const enabled = current.kind === capability.kind && !stale; mode.value = enabled ? "enabled" : "default";
        const numberInput = node("input", "settings-input"); numberInput.type = "number"; numberInput.step = "1"; numberInput.min = String(capability.allowZero ? 0 : capability.minimumBudgetTokens); numberInput.max = String(capability.maximumBudgetTokens); numberInput.value = enabled ? String(current.budgetTokens) : String(capability.minimumBudgetTokens); numberInput.disabled = !enabled; numberInput.setAttribute("aria-label", capability.budgetLabel);
        const update = () => {
          if (mode.value === "default") current = { kind: "provider_default" };
          else {
            const budgetTokens = Number(numberInput.value);
            current = capability.kind === "anthropic_thinking" ? { kind: capability.kind, enabled: true, budgetTokens } : { kind: capability.kind, budgetTokens };
          }
          initiallyStale = false;
        };
        mode.addEventListener("change", () => { if (mode.value === "enabled" && current.kind !== capability.kind) numberInput.value = String(capability.minimumBudgetTokens); update(); render(); });
        numberInput.addEventListener("input", update);
        host.append(mode, node("label", "field-label", capability.budgetLabel), numberInput, node("p", "muted", `Allowed: ${formatNumber(capability.minimumBudgetTokens)}–${formatNumber(capability.maximumBudgetTokens)} tokens${capability.allowZero ? "; 0 disables thinking" : ""}. Capability source: ${friendly(capability.provenance)}.`));
      } else {
        current = current.kind === "provider_default" ? current : current;
        const select = node("select", "settings-select"); const option = node("option", "", "Provider Default"); option.value = "provider_default"; select.append(option); host.append(select, node("p", "muted", "Advanced tuning unavailable for this provider/model."));
      }
      if (stale) {
        const warning = node("div", "stale-execution"); warning.append(node("p", "failed", "Execution setting no longer supported by the selected model."));
        const reset = node("button", "secondary", "Use Provider Default"); reset.type = "button"; reset.addEventListener("click", () => { current = { kind: "provider_default" }; initiallyStale = false; render(); }); warning.append(reset); host.append(warning);
      }
    };
    providerControl.addEventListener("change", render); modelControl.addEventListener("input", render); render();
    return { host, read: () => current };
  }

  function renderModelsRoles(projection) {
    settingsHeading("Models & Roles");
    if (modelModeProjection !== projection) { modelModeProjection = projection; modelModeDraft = projection.modelMode; }
    const visibleMode = modelModeDraft;
    const mode = node("div", "mode-tabs"); const simpleTab = node("button", visibleMode === "simple" ? "chip selected" : "chip", "Simple"); simpleTab.type = "button"; simpleTab.addEventListener("click", () => { modelModeDraft = "simple"; render(); }); const advancedTab = node("button", visibleMode === "advanced" ? "chip selected" : "chip", "Advanced"); advancedTab.type = "button"; advancedTab.addEventListener("click", () => { modelModeDraft = "advanced"; render(); }); mode.append(simpleTab, advancedTab); timeline.append(mode);
    if (!projection.providers.length) { timeline.append(node("p", "muted settings-empty", "No providers configured."), button("Connect Provider", "primary", "connectProvider")); return; }
    const simple = card("Simple"); const defaultProvider = projection.providers.find((provider) => provider.id === projection.defaultProviderConfigId) || projection.providers[0];
    if (!defaultProvider.defaultModel) timeline.append(node("p", "partial-note", "Connected. Choose a model and its execution setting here to finish setup."));
    const simpleProvider = providerSelect(projection, defaultProvider && defaultProvider.id, "Default provider"); const simpleModel = node("input", "settings-input"); simpleModel.setAttribute("aria-label", "Default model"); simpleModel.placeholder = "Enter exact model ID"; simpleModel.maxLength = 2048; simpleModel.value = defaultProvider && defaultProvider.defaultModel || "";
    const simpleAssignment = projection.roles.find((assignment) => assignment.role === "planner" && assignment.providerConfigId === defaultProvider.id && assignment.modelId === simpleModel.value);
    const simpleExecution = executionEditor(projection, simpleProvider, simpleModel, simpleAssignment && simpleAssignment.executionOptions, simpleAssignment && simpleAssignment.executionProfileStatus === "stale", simpleAssignment && simpleAssignment.executionCapability, defaultProvider.id, simpleModel.value);
    simple.append(node("label", "field-label", "Default Provider"), simpleProvider, node("label", "field-label", "Default Model"), discoveredModelPicker(projection, simpleProvider, simpleModel), simpleExecution.host, node("p", "muted", "Choose from all discovered models or select Enter model ID manually. Repair uses Executor."));
    const saveSimple = node("button", "primary", "Use Simple Mode"); saveSimple.type = "button"; saveSimple.addEventListener("click", () => { if (simpleProvider.value && simpleModel.value.trim()) vscode.postMessage({ type: "setDefaultModel", providerConfigId: simpleProvider.value, modelId: simpleModel.value.trim(), executionOptions: simpleExecution.read() }); }); simple.append(saveSimple);
    const advanced = card("Advanced Role Assignments"); const controls = []; const providerSearch = node("input", "settings-input"); providerSearch.type = "search"; providerSearch.placeholder = "Search configured providers…"; providerSearch.maxLength = 200; providerSearch.setAttribute("aria-label", "Search role providers"); advanced.append(providerSearch);
    ["planner", "executor", "reviewer"].forEach((roleName) => { const assignment = projection.roles.find((item) => item.role === roleName) || {}; const group = node("div", "role-config"); const select = providerSelect(projection, assignment.providerConfigId || defaultProvider.id, `${friendly(roleName)} provider`); const modelInput = node("input", "settings-input"); modelInput.setAttribute("aria-label", `${friendly(roleName)} model`); modelInput.placeholder = `${friendly(roleName)} model ID`; modelInput.maxLength = 2048; modelInput.value = assignment.modelId || ""; const execution = executionEditor(projection, select, modelInput, assignment.executionOptions, assignment.executionProfileStatus === "stale", assignment.executionCapability, assignment.providerConfigId, assignment.modelId); const picker = discoveredModelPicker(projection, select, modelInput); group.append(node("div", "field-label", friendly(roleName)), select, picker, execution.host); advanced.append(group); controls.push({ role: roleName, select, modelInput, execution }); });
    providerSearch.addEventListener("input", () => { const query = providerSearch.value.trim().toLocaleLowerCase(); controls.forEach((control) => control.select._providerOptions.forEach((entry) => { entry.option.hidden = !!query && !entry.text.includes(query); })); });
    advanced.append(node("p", "muted", "Selections are validated and committed together. Cancellation or incomplete input saves nothing. Repair uses Executor."));
    const saveAdvanced = node("button", "primary", "Save Advanced Roles"); saveAdvanced.type = "button"; saveAdvanced.addEventListener("click", () => { const assignments = controls.map((control) => ({ role: control.role, providerConfigId: control.select.value, modelId: control.modelInput.value.trim(), executionOptions: control.execution.read() })); if (assignments.every((item) => item.providerConfigId && item.modelId)) vscode.postMessage({ type: "updateRoleAssignments", assignments }); }); advanced.append(saveAdvanced);
    timeline.append(visibleMode === "simple" ? simple : advanced);
  }

  function renderPlanning(projection) {
    settingsHeading("Planning"); const value = card("Planning Profile");
    const select = node("select", "settings-select"); projection.planning.profiles.forEach((profile) => { const option = node("option", "", profile.name); option.value = profile.id; option.selected = profile.id === projection.planning.selectedProfileId; select.append(option); });
    select.addEventListener("change", () => vscode.postMessage({ type: "updatePlanningProfile", profileId: select.value })); value.append(select);
    const selected = projection.planning.profiles.find((profile) => profile.id === projection.planning.selectedProfileId); if (selected) value.append(labeledValue("Plan Style", friendly(selected.planStyle)), labeledValue("Risk Mode", friendly(selected.riskMode)), labeledValue("Output Language", selected.outputLanguage), ...(selected.locale ? [labeledValue("Locale", selected.locale)] : [])); timeline.append(value);
  }

  function booleanRow(label, enabled) { return labeledValue(label, enabled ? "Enabled" : "Disabled", enabled ? "passed" : "muted"); }
  function renderWorkflow(projection) {
    const settings = card("Workflow Settings");
    settings.append(node("p", "muted", "Saves automatically. Applies to new tasks only, not the current plan or running task."));
    ["Repair", "Validation", "Review"].forEach((group) => {
      const details = node("details", "workflow-controls");
      details.open = disclosures.get(`workflow-settings:${group}`) ?? group === "Repair";
      details.append(node("summary", "", group));
      details.addEventListener("toggle", () => disclosures.set(`workflow-settings:${group}`, details.open));
      projection.workflow.controls.filter((control) => control.group === group).forEach((control) => {
        const label = node("label", "workflow-setting");
        const field = node("input", control.type === "boolean" ? "" : "settings-input");
        field.type = control.type === "boolean" ? "checkbox" : "number";
        field.setAttribute("aria-label", control.label);
        if (control.type === "boolean") field.checked = control.value;
        else {
          field.value = String(control.value); field.step = "1";
          if (control.minimum !== undefined) field.min = String(control.minimum);
          if (control.maximum !== undefined) field.max = String(control.maximum);
        }
        field.addEventListener("change", () => {
          const value = control.type === "boolean" ? field.checked : Number(field.value);
          if (control.type !== "boolean" && (!field.value.trim() || !Number.isFinite(value) || !Number.isInteger(value) || value < control.minimum || (control.maximum !== undefined && value > control.maximum))) {
            field.value = String(control.value); el("notice").textContent = `${control.label}: enter an integer${control.minimum !== undefined ? ` from ${control.minimum}` : ""}${control.maximum !== undefined ? ` to ${control.maximum}` : ""}.`; el("notice").classList.remove("hidden"); return;
          }
          const patch = control.path.reduceRight((child, key) => ({ [key]: child }), value);
          field.disabled = true;
          vscode.postMessage({ type: "updateWorkflowSettings", settings: patch });
        });
        label.append(node("span", "", control.label), field); details.append(label);
      });
      if (group === "Repair") details.append(node("p", "muted", "Limits count attempts within each repair loop. The first reached limit stops repair."));
      settings.append(details);
    });
    const capabilities = card("Current Capabilities");
    capabilities.append(labeledValue("Plan Approval", projection.workflow.planApproval), labeledValue("After Approval", "Automatic continuation"), labeledValue("Validation Before Review", "Required"), labeledValue("Review", "Runs after passing validation"), labeledValue("Pause / Resume", projection.workflow.pauseResume), labeledValue("Waiting for Permission", "Supported · rules in Permissions"), labeledValue("Abort", "Supported · existing changes remain"), labeledValue("Repair No-change Detection", "Stops repair"));
    timeline.append(settings, capabilities);
  }
  function renderGenericSection(projection, section) {
    const titles = Object.fromEntries(SETTINGS_SECTIONS.map((entry) => [entry[0], entry[1]])); settingsHeading(titles[section] || friendly(section));
    if (section === "workflow") renderWorkflow(projection);
    else if (section === "engineeringRules") { timeline.append(node("p", "muted", "Effective precedence: Task › Workspace › Global. Resolution remains in Core.")); projection.rules.forEach((rule) => { const value = card(rule.name); value.append(node("p", "muted", rule.description), labeledValue("Scope", friendly(rule.scope)), labeledValue("Severity", friendly(rule.severity)), booleanRow("Status", rule.enabled)); timeline.append(value); }); }
    else if (section === "permissions") { [["Automatically Allowed", projection.permissions.automaticallyAllowed, "✓"], ["Ask First", projection.permissions.askFirst, "!"], ["Always Denied", projection.permissions.denied, "×"]].forEach(([title, items, mark]) => { const value = card(title); items.forEach((item) => value.append(node("div", "policy-line", `${mark} ${item}`))); timeline.append(value); }); timeline.append(node("p", "muted", "There is no allow-all or permission bypass. Core PermissionEngine is authoritative.")); }
    else if (section === "context") { const p = projection.context; const value = card("Context Strategy"); value.append(labeledValue("Strategy", p.strategy), labeledValue("Repository Context", p.repositoryContext), labeledValue("Targeted Expansion", p.targetedExpansion), labeledValue("Bounded Context", p.bounded), labeledValue("Task Limit", `${p.maxTaskFiles} files · ${formatNumber(p.maxTaskBytes)} bytes`)); timeline.append(value); }
    else if (section === "validation") { const value = card("Validation Pipeline"); projection.validation.steps.forEach((step) => value.append(labeledValue(step.kind, step.policy))); value.append(labeledValue("Fail Fast", projection.validation.failFast ? "Enabled" : "Disabled")); timeline.append(value); }
    else if (section === "review") { const p = projection.review; const value = card("Reviewer"); value.append(labeledValue("Assignment", p.reviewer.providerName ? `${p.reviewer.providerName} / ${p.reviewer.modelId}` : "Unconfigured"), booleanRow("Engineering Rules Applied", p.rulesApplied), booleanRow("Validation Failure Forces Fail", p.validationFailuresForceFail), booleanRow("Bounded Evidence", p.boundedEvidence), labeledValue("Targeted Context Expansion", "Supported · bounded by reviewer turns"), labeledValue("Maximum Reviewer Turns", projection.workflow.settings.reviewerLimits.maxReviewerTurns)); timeline.append(value); }
    else if (section === "repair") { const p = projection.repair; const value = card("Automatic Repair"); value.append(booleanRow("Enabled", p.automatic), booleanRow("Validation First", p.validationFirst), booleanRow("Planner Replan", p.plannerReplan), booleanRow("Context Reuse", p.contextReuse), labeledValue("Model Assignment", `Uses ${p.usesRole}`), labeledValue("Maximum Cycles", p.maximumCycles)); timeline.append(value); }
    else if (section === "usage") { const p = projection.usage; const value = card("Usage & Performance"); value.append(labeledValue("Token Reporting", p.tokenReporting), labeledValue("Cache Token Reporting", p.cacheTokenReporting), labeledValue("Provider-Reported Cost", p.providerReportedCost), labeledValue("Local Task Performance History", p.localTaskPerformanceHistory), labeledValue("Execution Profile Attribution", p.executionProfileAttribution), labeledValue("Automatic Optimization", p.automaticOptimization)); timeline.append(value); }
    else if (section === "privacy") { const p = projection.privacy; const value = card("Privacy & Storage"); [["Credentials", p.credentials], ["Task History", p.taskHistory], ["Cloud Sync", p.cloudSync], ["Nyxara Account", p.account], ["Telemetry", p.telemetry], ["Provider Requests", p.providerRequests]].forEach(([key, val]) => value.append(labeledValue(key, val))); timeline.append(value); }
    else if (section === "advanced") { const p = projection.advanced; const value = card("Supported Technical Configuration"); [["Manual Model ID", p.manualModelId], ["Custom Endpoints", p.customEndpoints], ["Role Routing", p.roleRouting], ["Execution Profiles", "Capability-driven per role/model"], ["Diagnostics", p.diagnosticState]].forEach(([key, val]) => value.append(labeledValue(key, val))); timeline.append(value, node("p", "muted", "Automatic routing, Budget Engine, Skills, MCP, Hooks, Plugins, and Marketplace are not available in this phase.")); }
    if (["validation", "review", "repair"].includes(section)) timeline.append(node("p", "muted", "Workflow preferences apply to new tasks."), button("Edit Workflow Settings", "secondary", "openSettingsSection", { section: "workflow" }));
  }

  function renderHistorySettings(projection) {
    settingsHeading("Task History"); const value = card("Local History"); value.append(labeledValue("Stored", projection.history.storage), labeledValue("Tasks", `${projection.history.count} / ${projection.history.retention}`)); const select = node("select", "settings-select"); projection.history.choices.forEach((choice) => { const option = node("option", "", String(choice)); option.value = String(choice); option.selected = choice === projection.history.retention; select.append(option); }); select.addEventListener("change", () => vscode.postMessage({ type: "updateHistoryRetention", retention: Number(select.value) })); value.append(node("label", "field-label", "Retention"), select, button("Clear History", "danger", "clearHistory")); timeline.append(value);
  }

  function renderWorkspaceSettings(projection) {
    settingsHeading("Workspace"); const p = projection.workspace; if (!p.available) { timeline.append(node("p", "muted settings-empty", "No workspace. Open a folder to configure workspace-specific settings.")); return; } const value = card("Current Workspace"); value.append(labeledValue("Workspace", p.currentWorkspace || "Choose a root"), labeledValue("Planning Profile", p.planningProfile), labeledValue("Enabled Rules", p.rulesCount)); if (p.multiple) { const select = node("select", "settings-select"); p.roots.forEach((root) => { const option = node("option", "", root.label); option.value = root.id; option.selected = root.id === p.selectedRoot; select.append(option); }); select.addEventListener("change", () => vscode.postMessage({ type: "selectWorkspaceRoot", rootId: select.value })); value.append(node("label", "field-label", "Selected Root"), select); } timeline.append(value);
  }

  function renderAbout(projection) {
    settingsHeading("About"); const p = projection.about; const value = card(p.product); value.append(labeledValue("Version", projection.version), labeledValue("Channel", p.channel), labeledValue("Provider Configurations", p.providerConfigurations), labeledValue("Task History", p.taskHistory), labeledValue("Workflow Engine", p.workflowEngine)); value.append(button("Diagnostics", "secondary", "requestDiagnostics")); timeline.append(value);
    if (state.settings.diagnostics) { const diagnostic = card("Privacy-safe Diagnostics"); const pre = node("pre", "diagnostics", JSON.stringify(state.settings.diagnostics, null, 2)); diagnostic.append(pre, button("Copy Diagnostics", "secondary", "copyDiagnostics")); timeline.append(diagnostic); }
  }

  function renderSettings() {
    const projection = state.settings.projection; const section = state.settings.section;
    if (section === "home") renderSettingsHome(projection); else if (section === "aiProviders") renderProviders(projection); else if (section === "modelsRoles") renderModelsRoles(projection); else if (section === "planning") renderPlanning(projection); else if (section === "taskHistory") renderHistorySettings(projection); else if (section === "workspace") renderWorkspaceSettings(projection); else if (section === "about") renderAbout(projection); else renderGenericSection(projection, section);
  }

  function renderHistoryScreen() {
    const history = historyState();
    const shell = node("section", "history-screen");
    const heading = node("div", "history-screen-heading");
    heading.append(button("←", "icon-button", history.activeTaskId ? "returnToActiveTask" : "newTask"), node("h1", "", "History"));
    if (history.tasks.length || history.recentTasks.length) heading.append(button("Clear History", "danger-link", "clearHistory"));
    shell.append(heading);
    const search = node("input", "history-search");
    search.type = "search";
    search.value = history.query || "";
    search.maxLength = 200;
    search.placeholder = "Search tasks…";
    search.setAttribute("aria-label", "Search local task history");
    search.addEventListener("input", () => vscode.postMessage({ type: "searchTasks", query: search.value }));
    shell.append(search);
    const scopes = node("div", "history-scopes");
    [["current", "Current Workspace"], ["all", "All Workspaces"]].forEach(([value, label]) => {
      const item = button(label, history.scope === value ? "chip selected" : "chip", "listTasks", { scope: value });
      if (value === "current" && !history.currentWorkspaceId) item.disabled = true;
      scopes.append(item);
    });
    shell.append(scopes);
    const filters = node("div", "history-filters");
    [["all", "All"], ["active", "Active"], ["completed", "Completed"], ["failed", "Failed"], ["rejected", "Rejected"], ["interrupted", "Interrupted"]].forEach(([value, label]) => filters.append(button(label, history.filter === value ? "chip selected" : "chip", "filterTasks", { filter: value })));
    shell.append(filters);
    const list = node("div", "history-list");
    if (!history.tasks.length) list.append(node("p", "history-empty muted", history.query ? "No matching local tasks." : "No tasks yet. Start your first task below."));
    else history.tasks.forEach((task) => list.append(taskRow(task, history.scope === "all")));
    shell.append(list);
    if (history.activeTaskId) shell.append(button("Return to Active Task", "primary return-active", "returnToActiveTask"));
    timeline.append(shell);
  }

  function historicalPlanBody(task, host) {
    host.append(node("p", "objective", task.planSummary.objective));
    const tasks = node("ol", "task-list");
    task.planSummary.tasks.forEach((planTask) => {
      const item = node("li");
      item.append(node("div", "task-title", planTask.title));
      if (planTask.acceptanceCriteria.length) {
        item.append(node("div", "task-meta", "Acceptance criteria"));
        const criteria = node("ul", "criteria");
        planTask.acceptanceCriteria.forEach((entry) => criteria.append(node("li", "", entry)));
        item.append(criteria);
      }
      if (planTask.dependencies.length) item.append(node("div", "task-meta", `Depends on: ${planTask.dependencies.join(", ")}`));
      if (planTask.risk) item.append(node("div", "task-meta", `Risk: ${friendly(planTask.risk)}`));
      tasks.append(item);
    });
    host.append(tasks);
    if (task.planSummary.risks.length) {
      const risks = node("ul", "risk-list");
      task.planSummary.risks.forEach((risk) => risks.append(node("li", "", `${friendly(risk.severity)} — ${risk.description}${risk.mitigation ? ` (${risk.mitigation})` : ""}`)));
      host.append(node("h3", "", "Risks"), risks);
    }
    host.append(node("div", "approved-line", task.planSummary.approvalStatus === "approved" ? "Approved ✓" : task.planSummary.approvalStatus === "rejected" ? "Rejected" : "Not approved"));
  }

  /** Historical plan is collapsed by default; History never replays plan content. */
  function renderHistoricalPlanSummary(task) {
    if (!task.planSummary) return;
    const count = task.planSummary.tasks.length;
    const section = disclosure(`history-plan:${task.id}`, "Plan", `${count} ${count === 1 ? "task" : "tasks"}`, false);
    const body = node("div", "plan-card-body");
    historicalPlanBody(task, body);
    section.append(body);
    timeline.append(section);
  }

  /**
   * Compact historical detail. Every stage section is collapsed by default and a
   * stage is rendered only when the record shows it actually occurred, so a
   * rejected task never shows Execution, Validation, Review, or Repair.
   */
  function renderHistoricalTask() {
    const history = historyState();
    const task = history.selectedTask;
    const heading = node("div", "history-screen-heading");
    heading.append(button("←", "icon-button", "openHistory"), node("h1", "", task ? task.title : "Task unavailable"));
    timeline.append(heading);
    if (!task) { timeline.append(node("p", "muted", "This local task is no longer available.")); return; }
    if (history.activeTaskId) timeline.append(button("Return to Active Task", "secondary return-active", "returnToActiveTask"));
    const outcome = outcomeOf(task);
    const summaryCard = card(outcomeLabel(outcome) + (outcome === "completed" ? " ✓" : ""), `completion-card ${outcomeClass(outcome)}`);
    if (outcome === "rejected") summaryCard.append(node("p", "", "No repository changes were made."));
    if (outcome === "interrupted") summaryCard.append(node("p", "", "This workflow cannot be resumed automatically in the current version."));
    if (task.failureSummary && outcome !== "rejected") summaryCard.append(node("p", "failed", task.failureSummary.message));
    const usage = task.usageSummary;
    const overview = task.performanceSummary ? task.performanceSummary.overview : undefined;
    const tokenParts = outcome !== "rejected" && overview ? [
      overview.inputTokens == null ? null : `${compactTokens(overview.inputTokens)} input`,
      overview.cacheWriteTokens ? `${compactTokens(overview.cacheWriteTokens)} cache write` : null,
      overview.cacheReadTokens ? `${compactTokens(overview.cacheReadTokens)} cache read` : null,
      overview.outputTokens == null ? null : `${compactTokens(overview.outputTokens)} output`,
    ].filter(Boolean) : [];
    renderUsageSummary(summaryCard, outcome === "rejected" ? [] : [
      tokenParts.length ? tokenParts.join(" · ") : (usage && usage.totalTokens != null ? `${compactTokens(usage.totalTokens)} tokens` : null),
      usage && usage.workflowDurationMs != null ? formatSummaryDuration(usage.workflowDurationMs) : null,
      task.providerSummary ? `${task.providerSummary.provider}${task.providerSummary.model ? ` · ${task.providerSummary.model}` : ""}` : null,
    ]);
    timeline.append(summaryCard);
    const requirement = node("section", "requirement-block history-requirement");
    requirement.append(node("div", "eyebrow", "Requirement"));
    appendCompactPrompt(requirement, task.requirement, `history-requirement:${task.id}`);
    timeline.append(requirement);
    renderHistoricalPlanSummary(task);
    const stages = task.occurredStages || [];
    const executionOccurred = task.executionSummary && (stageOccurred(stages, "execution") || task.executionSummary.total > 0);
    if (executionOccurred) {
      const section = disclosure(`history-execution:${task.id}`, "Execution", `${task.executionSummary.completed} / ${task.executionSummary.total}`, false);
      const tasks = node("ul", "workflow-tasks");
      task.executionSummary.tasks.forEach((item) => {
        const row = node("li");
        row.append(node("span", item.status === "completed" ? "passed" : item.status === "failed" ? "failed" : "", item.status === "completed" ? "✓" : item.status === "failed" ? "✕" : "○"), node("span", "", `${item.title} — ${friendly(item.status)}`));
        tasks.append(row);
      });
      section.append(tasks);
      timeline.append(section);
    }
    if (task.validationSummary && (stageOccurred(stages, "validation") || task.validationSummary.steps.length)) {
      const failed = task.validationSummary.status === "failed";
      const section = disclosure(`history-validation:${task.id}`, "Validation", friendly(task.validationSummary.status), false);
      task.validationSummary.steps.forEach((step) => {
        const row = node("div", "step");
        row.append(node("span", "", friendly(step.name)), node("span", step.status === "passed" ? "passed" : ["failed", "timed_out", "errored"].includes(step.status) ? "failed" : "muted", `${friendly(step.status)}${step.durationMs == null ? "" : ` · ${formatDuration(step.durationMs)}`}`));
        section.append(row);
      });
      timeline.append(section);
    }
    if (task.reviewSummary && (stageOccurred(stages, "review") || !["pending", "unavailable"].includes(task.reviewSummary.status))) {
      const section = disclosure(`history-review:${task.id}`, "Review", friendly(task.reviewSummary.status), false);
      section.append(node("p", task.reviewSummary.status === "passed" ? "passed" : task.reviewSummary.status === "failed" ? "failed" : "muted", friendly(task.reviewSummary.status)));
      if (task.reviewSummary.findingCount != null) section.append(node("p", "muted", `${task.reviewSummary.findingCount} structured finding${task.reviewSummary.findingCount === 1 ? "" : "s"}`));
      timeline.append(section);
    }
    if (task.repairSummary && (stageOccurred(stages, "repair") || task.repairSummary.cycles > 0 || task.repairSummary.durationMs != null || task.repairSummary.tokens != null)) {
      const section = disclosure(`history-repair:${task.id}`, "Repair", `${task.repairSummary.cycles} ${task.repairSummary.cycles === 1 ? "cycle" : "cycles"}`, false);
      section.append(node("p", "", `${task.repairSummary.cycles} cycle${task.repairSummary.cycles === 1 ? "" : "s"} · ${friendly(task.repairSummary.outcome || "unavailable")}`));
      timeline.append(section);
    }
    if (terminalHistoryStatus(task.status) && task.id !== history.activeTaskId) {
      const actions = node("div", "history-detail-actions");
      if (canViewTaskPerformance(task)) actions.append(button("View Performance", "secondary", "openPerformance", { taskId: task.id }));
      actions.append(button("Edit Requirement", "secondary", "editRequirement", { taskId: task.id }));
      actions.append(button("Delete Task", "danger", "deleteTask", { taskId: task.id }));
      if (!history.activeTaskId) actions.append(button("New Task", "primary", "newTask"));
      timeline.append(actions);
    }
  }

  function renderRequirement() {
    if (!state.prompt) return;
    const value = node("section", "requirement-block");
    value.append(node("div", "eyebrow", "You"));
    appendCompactPrompt(value, state.prompt, liveDisclosureKey("requirement"));
    timeline.append(value);
  }

  /**
   * Persistent live stage indicator. Stage plus elapsed time is always shown, so
   * a non-streaming provider never looks frozen; streaming progress, when the
   * transport genuinely supports it, is added as a safe status line.
   */
  function renderLiveStage() {
    const workflow = state.workflow;
    if (!workflow || !workflow.active || isTerminal()) return;
    const value = node("section", "live-stage");
    const head = node("div", "live-stage-head");
    const elapsed = elapsedLabel(workflow.stageStartedAt);
    const timed = workflow.status !== "awaiting_plan_approval" && elapsed;
    if (workflow.status !== "awaiting_plan_approval" && workflow.status !== "waiting_for_permission") head.append(node("span", "spinner"));
    head.append(node("span", "live-stage-name", timed ? `${workflow.stage} · ${elapsed}` : workflow.stage));
    value.append(head);
    const providerWait = ["planning", "executing", "running", "reviewing", "repairing"].includes(workflow.status);
    if (providerWait && workflow.providerLabel) value.append(node("div", "muted live-stage-provider", workflow.providerLabel));
    if (providerWait) value.append(node("div", "muted live-stage-detail", workflow.progressLabel || "Waiting for provider response..."));
    const currentIndex = workflow.currentTaskId ? workflow.tasks.findIndex((task) => task.id === workflow.currentTaskId) : -1;
    const currentTask = currentIndex >= 0 ? workflow.tasks[currentIndex] : undefined;
    if (workflow.progress && workflow.progress.total && (currentTask || stageOccurred(workflow.occurredStages, "execution"))) {
      const taskNumber = currentIndex >= 0 ? currentIndex + 1 : Math.min(workflow.progress.completed + 1, workflow.progress.total);
      const taskBlock = node("div", "live-task");
      taskBlock.append(node("div", "muted live-task-count", `Task ${taskNumber} / ${workflow.progress.total}`));
      if (currentTask) taskBlock.append(node("div", "live-task-title", currentTask.title));
      value.append(taskBlock);
    }
    if (workflow.active && workflow.status !== "waiting_for_permission") {
      const actions = [];
      if (["running", "executing", "validating", "reviewing", "repairing"].includes(workflow.status)) actions.push(button("Pause", "secondary", "pauseWorkflow"));
      if (workflow.status === "paused") actions.push(button("Resume", "primary", "resumeWorkflow"));
      if (workflow.status !== "planning" && workflow.status !== "awaiting_plan_approval") actions.push(button("Abort", "danger", "abortWorkflow"));
      if (actions.length) addActions(value, actions);
    }
    timeline.append(value);
  }

  function renderClarification() {
    const clarification = state.clarification;
    if (!clarification) return;
    const value = card(clarification.title, "clarification-card");
    value.append(node("p", "", clarification.message));
    if (clarification.examples && clarification.examples.length) {
      const list = node("ul", "clarification-examples");
      clarification.examples.forEach((example) => list.append(node("li", "", example)));
      value.append(node("div", "eyebrow", "Examples"), list);
    }
    const actions = [];
    if (clarification.requirement) actions.push(button("Edit Requirement", "secondary", "editRequirement"));
    actions.push(button("Dismiss", "secondary", "dismissClarification"));
    addActions(value, actions);
    timeline.append(value);
  }

  function planBody(host) {
    host.append(node("p", "objective", state.plan.objective));
    if (state.plan.summary) host.append(node("p", "muted", state.plan.summary));
    const tasks = node("ol", "task-list");
    state.plan.tasks.forEach((task) => {
      const item = node("li");
      item.append(node("div", "task-title", task.title));
      if (task.description) item.append(node("div", "task-description", task.description));
      if (task.acceptanceCriteria.length) {
        item.append(node("div", "task-meta", "Acceptance criteria"));
        const criteria = node("ul", "criteria");
        task.acceptanceCriteria.forEach((criterion) => criteria.append(node("li", "", criterion)));
        item.append(criteria);
      }
      if (task.dependencies.length) item.append(node("div", "task-meta", `Depends on: ${task.dependencies.join(", ")}`));
      if (task.risk) item.append(node("div", "task-meta", `Risk: ${friendly(task.risk)}`));
      tasks.append(item);
    });
    host.append(tasks);
    if (state.plan.risks.length) {
      host.append(node("h3", "", "Risks"));
      const risks = node("ul", "risk-list");
      state.plan.risks.forEach((risk) => risks.append(node("li", "", `${friendly(risk.severity)} — ${risk.description}${risk.mitigation ? ` (${risk.mitigation})` : ""}`)));
      host.append(risks);
    }
  }

  /** Plan disclosure is presentation-only. Approval controls stay outside it. */
  function renderPlan() {
    if (!state.plan) return;
    const awaitingApproval = workflowStatus() === "awaiting_plan_approval";
    const taskCount = state.plan.tasks.length;
    const meta = `${taskCount} ${taskCount === 1 ? "task" : "tasks"}`;
    const value = node("section", "plan-section");
    const collapsed = disclosure(liveDisclosureKey("plan"), "Implementation Plan", meta, awaitingApproval);
    const body = node("div", "plan-card-body");
    planBody(body);
    collapsed.append(body);
    value.append(collapsed);
    if (awaitingApproval) addActions(value, [button("Reject", "secondary", "rejectPlan"), button("Approve & Run", "primary", "approvePlan")]);
    timeline.append(value);
  }

  /** Finished tasks stay compact; the active task is rendered only by live-stage. */
  function renderExecutionSummary() {
    const workflow = state.workflow;
    if (!workflow || workflow.status === "awaiting_plan_approval" || isTerminal()) return;
    if (!stageOccurred(workflow.occurredStages, "execution") && !workflow.tasks.some((task) => task.status !== "pending")) return;
    const done = workflow.tasks.filter((task) => task.status === "completed" && task.id !== workflow.currentTaskId);
    if (done.length) {
      const completedSection = disclosure(liveDisclosureKey("execution-completed"), `${done.length} ${done.length === 1 ? "task" : "tasks"} completed`, "", false);
      const list = node("ul", "workflow-tasks");
      done.forEach((task) => { const item = node("li"); item.append(node("span", "passed", "✓"), node("span", "", task.title)); list.append(item); });
      completedSection.append(list);
      timeline.append(completedSection);
    }
  }

  function renderPermission() {
    const permission = state.workflow && state.workflow.permission;
    if (!permission) return;
    const value = card("Permission required", "permission");
    value.append(node("div", "eyebrow", "Action"), node("p", "", permission.action), node("div", "eyebrow", "Reason"), node("p", "", permission.reason));
    if (permission.command) value.append(node("div", "eyebrow", "Executable and arguments (JSON)"), node("pre", "diagnostics", permission.command), node("div", "eyebrow", "Working directory"), node("p", "", permission.cwd));
    addActions(value, [button("Deny", "secondary", "denyPermission", { requestId: permission.id }), button("Allow Once", "primary", "allowPermission", { requestId: permission.id }), button("Abort", "danger", "abortWorkflow")]);
    timeline.append(value);
  }

  function renderValidation() {
    if (isTerminal()) return;
    if (!afterApproval() && !state.validation.length) return;
    // Validation is rendered only once it has evidence or the workflow has
    // actually reached a stage that runs it.
    if (!state.validation.length && !["validating", "reviewing", "repairing"].includes(workflowStatus())) return;
    const value = card("Validation");
    if (!state.validation.length) {
      const label = workflowStatus() === "validating" ? "Running…" : ["executing", "running", "approved", "paused", "waiting_for_permission"].includes(workflowStatus()) ? "Pending" : "Unavailable";
      value.append(node("p", "muted", label));
    }
    state.validation.forEach((step) => {
      const row = node("div", "step");
      const symbol = step.status === "passed" ? "✓" : step.status === "skipped" ? "–" : ["failed", "timed_out", "errored"].includes(step.status) ? "✕" : "●";
      row.append(node("span", "", `${symbol} ${friendly(step.kind)}`), node("span", step.status === "passed" ? "passed" : ["failed", "timed_out", "errored"].includes(step.status) ? "failed" : "muted", friendly(step.status)));
      value.append(row);
    });
    timeline.append(value);
  }

  function renderReview() {
    if (isTerminal()) return;
    if (!state.reviewStatus && workflowStatus() !== "reviewing") return;
    const value = card("Review");
    const status = state.reviewStatus;
    const label = status ? friendly(status) : workflowStatus() === "reviewing" ? "Running…" : ["executing", "running", "approved", "validating", "paused", "waiting_for_permission"].includes(workflowStatus()) ? "Pending" : "Unavailable";
    value.append(node("p", status === "passed" ? "passed" : status === "failed" ? "failed" : "muted", label));
    timeline.append(value);
  }

  function renderRepair() {
    if (isTerminal()) return;
    if (workflowStatus() !== "repairing" && !(state.repairCycles > 0)) return;
    const value = card(workflowStatus() === "repairing" ? "Repairing" : "Repair");
    value.append(node("p", "", state.repairCycles == null ? "Cycle in progress" : `Cycle ${state.repairCycles}`));
    timeline.append(value);
  }

  /**
   * Compact terminal outcome. It leads with the outcome, a short summary, and the
   * primary next action; details stay collapsible, and stages that never ran are
   * not rendered at all.
   */
  function renderCompletion() {
    if (!state.completion) return;
    const outcome = state.completion.outcome || state.completion.status;
    const stages = (state.workflow && state.workflow.occurredStages) || [];
    const rejected = outcome === "rejected";
    const completed = outcome === "completed";
    const value = card(outcomeLabel(outcome) + (completed ? " ✓" : ""), `completion-card ${outcomeClass(outcome)}`);
    if (rejected) {
      value.append(node("p", "", "No repository changes were made."));
      const actions = [];
      if (state.plan) actions.push(expandButton("View Plan", "secondary", liveDisclosureKey("plan")));
      if (canViewPerformance(state.performance, outcome)) actions.push(button("View Performance", "secondary", "openPerformance"));
      actions.push(button("Edit Requirement", "secondary", "editRequirement"), button("New Task", "primary", "newTask"));
      addActions(value, actions);
      timeline.append(value);
      return;
    }
    const lines = [];
    if (outcome === "aborted") value.append(node("p", "", "Workflow stopped by user."));
    if (outcome === "interrupted") value.append(node("p", "", "Workflow interrupted."));
    if (!completed && outcome !== "aborted" && state.workflow && state.workflow.error) {
      const message = state.workflow.error.message;
      const standardValidationFailure = stageOccurred(stages, "validation") && state.validation.some((step) => ["failed", "timed_out", "errored"].includes(step.status)) && message.toLocaleLowerCase() === "validation failed.";
      if (!standardValidationFailure) value.append(node("p", outcome === "failed" ? "failed" : "muted", message));
    }
    const failedBeforeChanges = outcome === "failed"
      && state.completion.changedFiles === 0
      && stageOccurred(stages, "execution")
      && !stageOccurred(stages, "validation");
    if (failedBeforeChanges) {
      lines.push("Execution failed before changes");
      lines.push("Validation not applicable — no changes to validate");
    } else if (outcome !== "aborted" && state.completion.changedFiles != null && stageOccurred(stages, "execution")) {
      lines.push(`${formatNumber(state.completion.changedFiles)} files changed`);
    }
    if (outcome !== "aborted" && stageOccurred(stages, "validation") && state.validation.length) {
      lines.push(state.validation.some((step) => ["failed", "timed_out", "errored"].includes(step.status)) ? "Validation failed" : "Validation passed");
      const failedTests = state.validation.filter((step) => /tests?/i.test(step.kind) && ["failed", "timed_out", "errored"].includes(step.status));
      if (failedTests.length) lines.push(`Tests: ${failedTests.length} failed`);
    }
    if (outcome !== "aborted" && stageOccurred(stages, "review") && state.reviewStatus) lines.push(`Review ${friendly(state.reviewStatus).toLowerCase()}`);
    if (lines.length) value.append(node("p", "muted completion-lines", lines.join(" · ")));
    const overview = state.performance ? state.performance.overview : { totalTokens: state.completion.tokens, workflowDurationMs: state.completion.durationMs, providerCalls: state.completion.modelCalls, toolCalls: null };
    renderUsageSummary(value, [
      (state.completion.tokenParts && state.completion.tokenParts.length ? state.completion.tokenParts.join(" · ") : (compactTokens(overview.totalTokens) ? `${compactTokens(overview.totalTokens)} tokens` : null)),
      overview.workflowDurationMs == null ? null : formatSummaryDuration(overview.workflowDurationMs),
    ]);
    const actions = [];
    if (hasTerminalDetails(stages)) actions.push(expandButton("View Details", "secondary", liveDisclosureKey("terminal-details")));
    if (canViewPerformance(state.performance, outcome)) actions.push(button("View Performance", "secondary", "openPerformance"));
    if (outcome === "failed" && state.prompt) {
      const retry = state.workflow && state.workflow.executionRetry;
      if (retry) {
        value.append(node("p", "muted", `Retry ${retry.taskId} with the approved plan and current role models. Completed tasks stay done. Partial changes remain; commands may run again.`));
        actions.push(button("Retry Execute", "primary", "retryExecution", { workflowId: state.workflow.id, planId: retry.planId, taskId: retry.taskId }));
      } else if (!state.workflow || state.workflow.approvalStatus !== "approved") {
        actions.push(button("Try Again", "primary", "retryPlanning"));
      } else {
        value.append(node("p", "muted", "No resumable Executor attempt remains. Automatic recovery after reload or validation/review/repair failure is not supported."));
      }
      actions.push(button("Choose Model", "secondary", "openSettingsSection", { section: "modelsRoles" }));
    }
    actions.push(button("New Task", completed ? "primary" : "secondary", "newTask"));
    addActions(value, actions);
    timeline.append(value);
    renderTerminalDetails(stages);
  }

  function hasTerminalDetails(stages) {
    const workflow = state.workflow;
    return (stageOccurred(stages, "execution") && !!workflow)
      || (stageOccurred(stages, "validation") && state.validation.length > 0)
      || (stageOccurred(stages, "review") && !!state.reviewStatus)
      || (stageOccurred(stages, "repair") && state.repairCycles > 0);
  }

  function renderTerminalDetails(stages) {
    if (!hasTerminalDetails(stages)) return;
    const failedValidation = state.validation.filter((step) => ["failed", "timed_out", "errored"].includes(step.status));
    const details = disclosure(liveDisclosureKey("terminal-details"), "Details", "", false);
    if (stageOccurred(stages, "execution") && state.workflow) {
      const progress = state.workflow.progress;
      const meta = progress && progress.total > 0 ? `${progress.completed} / ${progress.total}` : "Started";
      const section = disclosure(liveDisclosureKey("terminal-execution"), "Execution", meta, false);
      if (state.workflow.tasks.length) {
        const tasks = node("ul", "workflow-tasks");
        state.workflow.tasks.forEach((task) => { const item = node("li"); item.append(node("span", task.status === "completed" ? "passed" : task.status === "failed" ? "failed" : "muted", task.status === "completed" ? "✓" : task.status === "failed" ? "✕" : "○"), node("span", "", `${task.title} — ${friendly(task.status)}`)); tasks.append(item); });
        section.append(tasks);
      }
      details.append(section);
    }
    if (stageOccurred(stages, "validation") && state.validation.length) {
      const section = disclosure(liveDisclosureKey("terminal-validation"), "Validation", failedValidation.length ? "Failed" : "Passed", failedValidation.length > 0);
      state.validation.forEach((step) => {
        const row = node("div", "step");
        const failed = ["failed", "timed_out", "errored"].includes(step.status);
        row.append(node("span", "", friendly(step.kind)), node("span", failed ? "failed" : step.status === "passed" ? "passed" : "muted", friendly(step.status)));
        section.append(row);
      });
      details.append(section);
    }
    if (stageOccurred(stages, "review") && state.reviewStatus) {
      const section = disclosure(liveDisclosureKey("terminal-review"), "Review", friendly(state.reviewStatus), state.reviewStatus === "failed");
      section.append(node("p", state.reviewStatus === "passed" ? "passed" : state.reviewStatus === "failed" ? "failed" : "muted", friendly(state.reviewStatus)));
      details.append(section);
    }
    if (stageOccurred(stages, "repair") && state.repairCycles > 0) {
      const section = disclosure(liveDisclosureKey("terminal-repair"), "Repair", `${state.repairCycles} ${state.repairCycles === 1 ? "cycle" : "cycles"}`, false);
      section.append(node("p", "muted", `${state.repairCycles} ${state.repairCycles === 1 ? "cycle" : "cycles"}`));
      details.append(section);
    }
    if (details.children.length > 1) timeline.append(details);
  }

  function metricRows(host, entries) {
    entries.forEach(([label, value]) => host.append(labeledValue(label, value == null ? "-" : value)));
  }

  function modelRows(host, role) {
    if (role.requestedModelId && role.resolvedModelId && role.requestedModelId === role.resolvedModelId) {
      host.append(labeledValue("Model", role.requestedModelId));
      return;
    }
    host.append(labeledValue("Requested Model", role.requestedModelId || "-"), labeledValue("Resolved Model", role.resolvedModelId || "-"));
  }

  function rolePerformance(role, title) {
    const value = card(title || friendly(role.role), "performance-section");
    metricRows(value, [["Provider", role.providerName || role.providerId || "-"]]);
    modelRows(value, role);
    metricRows(value, [
      ["Execution Profile", role.executionProfileLabel || "-"],
      ["Calls", formatNumber(role.calls)],
      ["Input", role.inputTokens == null ? "-" : `${formatNumber(role.inputTokens)} tokens`],
      ["Cache Read", role.cacheReadTokens == null ? "-" : `${formatNumber(role.cacheReadTokens)} tokens`],
      ["Cache Write", role.cacheWriteTokens == null ? "-" : `${formatNumber(role.cacheWriteTokens)} tokens`],
      ["Output", role.outputTokens == null ? "-" : `${formatNumber(role.outputTokens)} tokens`],
      ["Provider Time", formatDuration(role.providerDurationMs)],
    ]);
    if (role.role === "repair") value.append(node("p", "muted performance-note", "Uses Executor profile."));
    return value;
  }

  function hasValue(value) {
    return value !== null && value !== undefined;
  }

  function activePerformanceRole(role) {
    return [role.providerConfigId, role.providerId, role.requestedModelId, role.resolvedModelId, role.executionProfileLabel, role.inputTokens, role.cacheReadTokens, role.cacheWriteTokens, role.outputTokens, role.providerDurationMs].some(hasValue) || Number(role.calls) > 0;
  }

  function performanceDisclosure(title, className) {
    const value = node("details", `performance-disclosure${className ? ` ${className}` : ""}`);
    const summary = node("summary", "performance-disclosure-title", title);
    summary.setAttribute("aria-expanded", "false");
    summary.addEventListener("click", () => summary.setAttribute("aria-expanded", String(!value.open)));
    value.addEventListener("toggle", () => summary.setAttribute("aria-expanded", String(!!value.open)));
    value.append(summary);
    return value;
  }

  function hasAnyMetric(source, keys) {
    return !!source && keys.some((key) => hasValue(source[key]));
  }

  function hasRepairEvidence(repair) {
    return !!repair && (Number(repair.cycles) > 0 || Number(repair.providerCalls) > 0 || hasAnyMetric(repair, ["durationMs", "inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "providerDurationMs"]));
  }

  function reviewPerformance(review) {
    const role = review.role || {};
    const value = performanceDisclosure("Review");
    metricRows(value, [["Status", review.status ? friendly(review.status) : "-"], ["Duration", formatDuration(review.durationMs)], ["Provider", role.providerName || role.providerId || "-"]]);
    modelRows(value, role);
    metricRows(value, [
      ["Execution Profile", role.executionProfileLabel || "-"],
      ["Calls", formatNumber(role.calls)],
      ["Input", role.inputTokens == null ? "-" : `${formatNumber(role.inputTokens)} tokens`],
      ["Cache Read", role.cacheReadTokens == null ? "-" : `${formatNumber(role.cacheReadTokens)} tokens`],
      ["Cache Write", role.cacheWriteTokens == null ? "-" : `${formatNumber(role.cacheWriteTokens)} tokens`],
      ["Output", role.outputTokens == null ? "-" : `${formatNumber(role.outputTokens)} tokens`],
      ...(hasValue(role.processedTokens) ? [["Processed", `${formatNumber(role.processedTokens)} tokens`]] : []),
    ]);
    return value;
  }

  function renderPerformance() {
    const view = state.performanceView;
    const heading = node("div", "history-screen-heading performance-heading");
    const back = button("←", "icon-button", "closePerformance");
    back.setAttribute("aria-label", "Back to task");
    heading.append(back, node("h1", "", "Performance"));
    timeline.append(heading);
    if (!view || !view.projection) {
      timeline.append(node("p", "muted performance-empty", "Detailed performance was not recorded for this task."));
      return;
    }
    const projection = view.projection;
    const overview = projection.overview;
    const providerCostAmount = projection.cost.source === "provider_reported" ? projection.cost.amount : null;
    const providerCostCurrency = providerCostAmount == null ? null : projection.cost.currency;
    if (["aborted", "interrupted"].includes(view.taskStatus)) timeline.append(node("p", "partial-note", `Partial metrics · ${friendly(view.taskStatus)}`));
    else if (view.taskStatus === "failed") timeline.append(node("p", "partial-note", "Task failed · recorded metrics"));
    if (projection.detailLevel === "legacy") {
      const legacy = card("Overview", "performance-section");
      legacy.append(node("p", "muted", "Detailed performance was not recorded for this task."));
      metricRows(legacy, [["Input Tokens", formatNumber(overview.inputTokens)], ["Cache Read", formatNumber(overview.cacheReadTokens)], ["Cache Write", formatNumber(overview.cacheWriteTokens)], ["Output Tokens", formatNumber(overview.outputTokens)], ["Processed Tokens", formatNumber(overview.processedTokens ?? overview.totalTokens)], ["Workflow Duration", formatDuration(overview.workflowDurationMs)], ["Provider Calls", formatNumber(overview.providerCalls)], ["Tool Calls", formatNumber(overview.toolCalls)], ["Repair Cycles", formatNumber(overview.repairCycles)]]);
      timeline.append(legacy);
      return;
    }

    const overviewCard = card("Overview", "performance-section performance-overview");
    metricRows(overviewCard, [
      ["Input Tokens", formatNumber(overview.inputTokens)],
      ["Cache Read", formatNumber(overview.cacheReadTokens)],
      ["Cache Write", formatNumber(overview.cacheWriteTokens)],
      ["Output Tokens", formatNumber(overview.outputTokens)],
      ...(hasValue(overview.processedTokens) ? [["Processed Tokens", formatNumber(overview.processedTokens)]] : []),
      ["Workflow Duration", formatDuration(overview.workflowDurationMs)],
      ["Provider Calls", formatNumber(overview.providerCalls)],
      ["Tool Calls", formatNumber(overview.toolCalls)],
      ["Repair Cycles", formatNumber(overview.repairCycles)],
      ["Usage Source", overview.usageSource ? friendly(overview.usageSource) : "-"],
      ["Validation Status", overview.validationStatus ? friendly(overview.validationStatus) : "-"],
      ["Review Status", overview.reviewStatus ? friendly(overview.reviewStatus) : "-"],
      ["Cost", formatCost(providerCostAmount, providerCostCurrency)],
    ]);
    timeline.append(overviewCard);

    const activeRoles = projection.roles.filter(activePerformanceRole);
    if (activeRoles.length) {
      const roles = performanceDisclosure("Models & Roles");
      activeRoles.forEach((role) => roles.append(rolePerformance(role)));
      timeline.append(roles);
    }

    if (hasAnyMetric(projection.latency, ["workflowDurationMs", "toolDurationMs", "validationDurationMs", "reviewDurationMs", "repairDurationMs", "localOrchestrationDurationMs"]) || Object.values(projection.latency.providerByRole || {}).some(hasValue)) {
      const latency = performanceDisclosure("Latency");
      latency.append(node("p", "muted performance-note", "Measured durations may overlap; these rows are not a summed workflow total."));
      metricRows(latency, [["Workflow", formatDuration(projection.latency.workflowDurationMs)], ["Planner Provider Time", formatDuration(projection.latency.providerByRole.planner)], ["Executor Provider Time", formatDuration(projection.latency.providerByRole.executor)], ["Reviewer Provider Time", formatDuration(projection.latency.providerByRole.reviewer)], ["Repair Provider Time", formatDuration(projection.latency.providerByRole.repair)], ["Tools", formatDuration(projection.latency.toolDurationMs)], ["Validation", formatDuration(projection.latency.validationDurationMs)], ["Review", formatDuration(projection.latency.reviewDurationMs)], ["Repair", formatDuration(projection.latency.repairDurationMs)], ["Local Orchestration", formatDuration(projection.latency.localOrchestrationDurationMs)]]);
      timeline.append(latency);
    }

    if (hasAnyMetric(projection.context, ["planningContextMode", "files", "bytes", "truncated", "targetedExpansions"])) {
      const context = performanceDisclosure("Context");
      metricRows(context, [["Planning Context Mode", projection.context.planningContextMode ? friendly(projection.context.planningContextMode) : "-"], ["Files", formatNumber(projection.context.files)], ["Size", formatBytes(projection.context.bytes)], ["Truncated", projection.context.truncated == null ? "-" : projection.context.truncated ? "Yes" : "No"], ["Targeted Expansions", formatNumber(projection.context.targetedExpansions)]]);
      timeline.append(context);
    }

    if (hasAnyMetric(projection.tools, ["requestedByModel", "executed", "successful", "failed", "invalid", "durationMs"]) || projection.tools.byName.length) {
      const tools = performanceDisclosure("Tools");
      metricRows(tools, [["Requested", formatNumber(projection.tools.requestedByModel)], ["Executed", formatNumber(projection.tools.executed)], ["Successful", formatNumber(projection.tools.successful)], ["Failed", formatNumber(projection.tools.failed)], ["Invalid", formatNumber(projection.tools.invalid)], ["Duration", formatDuration(projection.tools.durationMs)]]);
      if (projection.tools.byName.length) { tools.append(node("h3", "performance-subheading", "By Name")); projection.tools.byName.forEach((entry) => tools.append(labeledValue(entry.name, formatNumber(entry.count)))); }
      timeline.append(tools);
    }

    if (projection.validation.status || hasValue(projection.validation.durationMs) || projection.validation.steps.length) {
      const validation = performanceDisclosure("Validation");
      metricRows(validation, [["Overall Status", projection.validation.status ? friendly(projection.validation.status) : "-"], ["Duration", formatDuration(projection.validation.durationMs)]]);
      projection.validation.steps.forEach((step) => { const row = node("div", "step"); row.append(node("span", "", friendly(step.name)), node("span", ["failed", "timed_out", "errored"].includes(step.status) ? "failed" : step.status === "passed" ? "passed" : "muted", `${friendly(step.status)}${step.durationMs == null ? "" : ` · ${formatDuration(step.durationMs)}`}`)); validation.append(row); });
      timeline.append(validation);
    }

    if (projection.review.status || hasValue(projection.review.durationMs) || activePerformanceRole(projection.review.role || {})) timeline.append(reviewPerformance(projection.review));

    if (hasRepairEvidence(projection.repair)) {
      const repair = performanceDisclosure("Repair");
      metricRows(repair, [["Cycles", formatNumber(projection.repair.cycles)], ["Duration", formatDuration(projection.repair.durationMs)], ["Provider Calls", formatNumber(projection.repair.providerCalls)], ["Input", projection.repair.inputTokens == null ? "-" : `${formatNumber(projection.repair.inputTokens)} tokens`], ["Cache Read", projection.repair.cacheReadTokens == null ? "-" : `${formatNumber(projection.repair.cacheReadTokens)} tokens`], ["Cache Write", projection.repair.cacheWriteTokens == null ? "-" : `${formatNumber(projection.repair.cacheWriteTokens)} tokens`], ["Output", projection.repair.outputTokens == null ? "-" : `${formatNumber(projection.repair.outputTokens)} tokens`], ["Provider Time", formatDuration(projection.repair.providerDurationMs)], ["Execution Profile", projection.repair.executionProfileLabel ? `Uses Executor · ${projection.repair.executionProfileLabel}` : "Uses Executor"]]);
      timeline.append(repair);
    }

    const cost = performanceDisclosure("Cost");
    metricRows(cost, [["Cost", formatCost(providerCostAmount, providerCostCurrency)], ["Source", providerCostAmount == null ? "-" : "Provider Reported"]]);
    timeline.append(cost);
  }

  function render() {
    const screen = state.performanceView ? `performance:${state.performanceView.source}:${state.performanceView.taskId || "live"}` : state.settings ? `settings:${state.settings.section}:${state.settings.providerConfigId || ""}` : historyState().screen;
    const screenChanged = screen !== renderedScreen;
    const stick = !screenChanged && isNearBottom();
    timeline.classList.toggle("settings-screen", !!state.settings && !state.performanceView);
    timeline.replaceChildren();
    if (state.performanceView) renderPerformance();
    else if (state.settings) renderSettings();
    else if (screen === "history") renderHistoryScreen();
    else if (screen === "historical") renderHistoricalTask();
    else {
      if (!state.prompt && !state.plan && !state.workflow && !state.clarification) renderEmpty();
      renderRequirement();
      renderClarification();
      renderLiveStage();
      renderPlan();
      renderExecutionSummary();
      renderPermission();
      renderValidation();
      renderReview();
      renderRepair();
      renderCompletion();
    }
    el("provider-dot").classList.toggle("connected", state.configured);
    el("provider-dot").setAttribute("aria-label", state.configured ? "Provider configured" : "Provider not configured");
    const active = !!(state.workflow && state.workflow.active);
    el("new-task").disabled = active || !!state.settings;
    el("new-task").title = active ? "Finish or abort the active workflow first" : "New Task";
    if (el("history")) el("history").classList.toggle("selected", !state.settings && historyState().screen !== "workspace");
    el("settings").classList.toggle("selected", !!state.settings);
    if (el("composer-wrap")) el("composer-wrap").classList.toggle("hidden", !!state.settings || !!state.performanceView);
    input.disabled = !state.configured || !state.workspace.available || active || !!state.settings || !!state.performanceView;
    submit.disabled = input.disabled || !input.value.trim() || sending;
    const warning = el("workspace-warning");
    warning.classList.toggle("hidden", state.workspace.available && !state.workspace.multiple);
    warning.textContent = !state.workspace.available ? "Open a folder or workspace to start a coding task." : state.workspace.multiple ? "Choose the target workspace when you generate a plan." : "";
    // A historical task opens at the top of its compact summary; an active
    // workspace task keeps following new output.
    if (screenChanged) timeline.scrollTop = screen === "workspace" && state.workflow && !isTerminal() ? timeline.scrollHeight : 0;
    else if (stick) timeline.scrollTop = timeline.scrollHeight;
    renderedScreen = screen;
    syncStageTimer();
  }

  /**
   * Keeps at most one bounded UI clock alive, and only while a non-terminal stage
   * is on screen. It re-renders locally from stageStartedAt and never contacts
   * the extension, Core, or a provider, so it is not a polling loop.
   */
  function syncStageTimer() {
    const workflow = state && state.workflow;
    const shouldRun = !!workflow && workflow.active && !isTerminal() && !state.settings && !state.performanceView
      && historyState().screen === "workspace" && workflow.status !== "awaiting_plan_approval" && !!workflow.stageStartedAt;
    const key = shouldRun ? `${workflow.id}:${workflow.status}:${workflow.stageStartedAt}` : undefined;
    if (stageTimerKey === key) return;
    stopStageTimer();
    if (!shouldRun) return;
    stageTimerKey = key;
    stageTimer = setInterval(() => {
      if (!state || isTerminal() || !state.workflow || !state.workflow.active) { stopStageTimer(); return; }
      render();
    }, 1000);
  }

  function stopStageTimer() {
    if (stageTimer !== undefined) clearInterval(stageTimer);
    stageTimer = undefined;
    stageTimerKey = undefined;
  }

  // The timer must not outlive the Webview.
  window.addEventListener("unload", stopStageTimer);
  window.addEventListener("pagehide", stopStageTimer);

  function resize() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 150)}px`;
    submit.disabled = !state || input.disabled || !input.value.trim() || sending;
  }

  function sendRequirement() {
    if (!state || sending || submit.disabled) return;
    const task = input.value.trim();
    if (!task || task.length > 20000) return;
    sending = true;
    submittedTask = task;
    submit.disabled = true;
    vscode.postMessage({ type: "submitRequirement", task });
  }

  input.addEventListener("input", resize);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      sendRequirement();
    }
  });
  submit.addEventListener("click", sendRequirement);
  el("new-task").addEventListener("click", () => vscode.postMessage({ type: "newTask" }));
  if (el("history")) el("history").addEventListener("click", () => vscode.postMessage({ type: "openHistory" }));
  el("settings").addEventListener("click", () => vscode.postMessage({ type: "openSettings" }));

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || typeof message.type !== "string") return;
    if (message.type === "safeError") {
      sending = false;
      if (state) render();
      const notice = el("notice");
      notice.textContent = String(message.message || "Nyxara operation failed").slice(0, 240);
      notice.classList.remove("hidden");
      return;
    }
    if (!message.state) return;
    const previousState = state;
    const hadTask = !!(previousState && (previousState.prompt || previousState.plan || previousState.workflow));
    state = message.state;
    const previousWorkflow = previousState && previousState.workflow;
    const currentWorkflow = state.workflow;
    if (
      previousWorkflow && currentWorkflow &&
      previousWorkflow.id === currentWorkflow.id &&
      previousWorkflow.status === "awaiting_plan_approval" &&
      currentWorkflow.status !== "awaiting_plan_approval"
    ) {
      disclosures.set(disclosureKeyFor("plan", state), false);
    }
    sending = false;
    el("notice").classList.add("hidden");
    if ((submittedTask && state.prompt === submittedTask) || (hadTask && !state.prompt && !state.plan && !state.workflow)) {
      input.value = "";
      submittedTask = undefined;
      resize();
    }

    // Edit Requirement prefills a fresh draft. It never resumes the old workflow.
    if (state.requirementDraft && state.requirementDraft !== appliedDraft) {
      appliedDraft = state.requirementDraft;
      input.value = state.requirementDraft;
      submittedTask = undefined;
      resize();
      if (!input.disabled) input.focus();
    } else if (!state.requirementDraft) {
      appliedDraft = undefined;
    }
    render();
  });

  vscode.postMessage({ type: "ready" });
}());
