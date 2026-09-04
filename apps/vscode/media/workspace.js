(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  const el = (id) => document.getElementById(id);
  const timeline = el("timeline");
  const input = el("requirement");
  const submit = el("submit");
  const model = el("model");
  let state;
  let sending = false;
  let submittedTask;
  let renderedScreen;
  let settingsQuery = "";

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
  const formatDuration = (ms) => ms == null ? "-" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
  const formatNumber = (value) => value == null ? "-" : Number(value).toLocaleString();
  const friendly = (value) => String(value || "pending").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  const isNearBottom = () => timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 72;
  const workflowStatus = () => state.workflow && state.workflow.status;
  const isTerminal = () => !!state.completion;
  const afterApproval = () => !!state.workflow && !["created", "planning", "awaiting_plan_approval"].includes(state.workflow.status);
  const historyState = () => state.history || { screen: "workspace", recentTasks: [], tasks: [], query: "", filter: "all", scope: "all" };
  const terminalHistoryStatus = (status) => ["completed", "failed", "aborted", "interrupted"].includes(status);

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
    const meta = [friendly(task.status)];
    if (task.usageSummary && task.usageSummary.totalTokens != null) meta.push(`${formatNumber(task.usageSummary.totalTokens)} tokens`);
    if (task.usageSummary && task.usageSummary.workflowDurationMs != null) meta.push(formatDuration(task.usageSummary.workflowDurationMs));
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
    ["workflow", "Workflow", "approval pause resume automatic repair"],
    ["planning", "Planning", "profile locale conservative concise detailed"],
    ["engineeringRules", "Engineering Rules", "rules precedence scope severity n+1 secret dependencies"],
    ["permissions", "Permissions", "allowed ask first sensitive destructive sudo git push deployment"],
    ["context", "Context", "repository targeted bounded files"],
    ["validation", "Validation", "typecheck lint tests build fail fast timeout"],
    ["review", "Review", "reviewer evidence rules failures context"],
    ["repair", "Repair", "automatic validation cycles executor replan"],
    ["usage", "Usage", "tokens cost metrics provider reported estimated"],
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
    cardValue.append(providerBadge(provider.status), labeledValue("Display Name", provider.displayName), labeledValue("Provider", provider.providerName), labeledValue("Category", provider.category), labeledValue("Authentication", provider.credentialStored ? "Credential stored securely" : provider.authStrategy === "subscription" ? "Official CLI account session" : provider.authStrategy === "local" || provider.authStrategy === "none" ? "No stored credential" : "Credential not stored"), labeledValue("Endpoint", provider.endpoint), labeledValue("Default Model", provider.defaultModel || "Not selected"), labeledValue("Model Discovery", provider.supportsModelDiscovery ? "Supported" : "Unavailable"));
    if (provider.isDefault) cardValue.append(node("div", "default-pill", "Default AI"));
    if (provider.endpoint !== "Official" && provider.endpoint !== "Managed by official CLI") {
      const edit = node("div", "provider-edit"); const nameInput = node("input", "settings-input"); nameInput.value = provider.displayName; nameInput.maxLength = 100; nameInput.setAttribute("aria-label", "Provider display name"); const endpointInput = node("input", "settings-input"); endpointInput.value = provider.endpoint; endpointInput.maxLength = 2048; endpointInput.setAttribute("aria-label", "Provider endpoint"); const save = node("button", "secondary", "Save Name & Endpoint"); save.type = "button"; save.addEventListener("click", () => { if (nameInput.value.trim() && endpointInput.value.trim()) vscode.postMessage({ type: "updateProviderMetadata", providerConfigId: provider.id, displayName: nameInput.value.trim(), endpoint: endpointInput.value.trim() }); }); edit.append(node("div", "field-label", "Edit Configuration"), nameInput, endpointInput, save); cardValue.append(edit);
    }
    const actions = node("div", "settings-actions");
    const testConnection = button("Test Connection", "secondary", "testProvider", { providerConfigId: provider.id }); testConnection.disabled = provider.status === "Signed out"; actions.append(testConnection);
    if (provider.supportsManualModelId) {
      const modelInput = node("input", "settings-input"); modelInput.placeholder = "Exact model ID"; modelInput.value = provider.defaultModel || ""; modelInput.maxLength = 2048; modelInput.setAttribute("aria-label", "Default model ID");
      const changeModel = node("button", "secondary", "Change Model"); changeModel.type = "button"; changeModel.addEventListener("click", () => { if (modelInput.value.trim()) vscode.postMessage({ type: "setDefaultModel", providerConfigId: provider.id, modelId: modelInput.value.trim() }); });
      actions.append(modelInput, changeModel);
    }
    if (!provider.isDefault) actions.append(button("Use as Default", "secondary", "setDefaultProvider", { providerConfigId: provider.id }));
    if (provider.authStrategy === "api_key") actions.append(button(provider.credentialStored ? "Update Credential" : "Reconnect", "secondary", "updateCredential", { providerConfigId: provider.id }));
    if (provider.authStrategy === "subscription" && provider.status === "Signed out") actions.append(button("Reconnect", "secondary", "updateCredential", { providerConfigId: provider.id }));
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

  function executionCapability(provider, modelId) {
    const normalized = String(modelId || "").trim().toLocaleLowerCase();
    return (provider && provider.executionCapabilityRules || []).find((rule) => rule.match === "exact" ? normalized === String(rule.modelId).toLocaleLowerCase() : normalized.startsWith(String(rule.modelId).toLocaleLowerCase()))?.capability;
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
          else current = capability.kind === "openai_reasoning" ? { kind: capability.kind, effort: select.value } : { kind: capability.kind, level: select.value };
          initiallyStale = false; render();
        });
        host.append(select);
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
        host.append(mode, node("label", "field-label", capability.budgetLabel), numberInput, node("p", "muted", `Allowed: ${formatNumber(capability.minimumBudgetTokens)}–${formatNumber(capability.maximumBudgetTokens)} tokens${capability.allowZero ? "; 0 disables thinking" : ""}.`));
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
    const mode = node("div", "mode-tabs"); mode.append(node("span", projection.modelMode === "simple" ? "chip selected" : "chip", "Simple"), node("span", projection.modelMode === "advanced" ? "chip selected" : "chip", "Advanced")); timeline.append(mode);
    if (!projection.providers.length) { timeline.append(node("p", "muted settings-empty", "No providers configured."), button("Connect Provider", "primary", "connectProvider")); return; }
    const simple = card("Simple"); const defaultProvider = projection.providers.find((provider) => provider.id === projection.defaultProviderConfigId) || projection.providers[0];
    const simpleProvider = providerSelect(projection, defaultProvider && defaultProvider.id, "Default provider"); const simpleModel = node("input", "settings-input"); simpleModel.placeholder = "Default model ID"; simpleModel.maxLength = 2048; simpleModel.value = defaultProvider && defaultProvider.defaultModel || "";
    const plannerAssignment = projection.roles.find((item) => item.role === "planner");
    const simpleExecution = executionEditor(projection, simpleProvider, simpleModel, plannerAssignment && plannerAssignment.executionOptions, plannerAssignment && plannerAssignment.executionProfileStatus === "stale", plannerAssignment && plannerAssignment.executionCapability, plannerAssignment && plannerAssignment.providerConfigId, plannerAssignment && plannerAssignment.modelId);
    simple.append(node("label", "field-label", "Default Provider"), simpleProvider, node("label", "field-label", "Default Model"), simpleModel, simpleExecution.host, node("p", "muted", "Use this exact provider/model/execution profile for Planner, Executor, and Reviewer. Repair uses Executor."));
    const saveSimple = node("button", "primary", "Use Simple Mode"); saveSimple.type = "button"; saveSimple.addEventListener("click", () => { if (simpleProvider.value && simpleModel.value.trim()) vscode.postMessage({ type: "setDefaultModel", providerConfigId: simpleProvider.value, modelId: simpleModel.value.trim(), executionOptions: simpleExecution.read() }); }); simple.append(saveSimple); timeline.append(simple);
    const advanced = card("Advanced Role Assignments"); const controls = []; const providerSearch = node("input", "settings-input"); providerSearch.type = "search"; providerSearch.placeholder = "Search configured providers…"; providerSearch.maxLength = 200; providerSearch.setAttribute("aria-label", "Search role providers"); advanced.append(providerSearch);
    ["planner", "executor", "reviewer"].forEach((roleName) => { const assignment = projection.roles.find((item) => item.role === roleName) || {}; const group = node("div", "role-config"); const select = providerSelect(projection, assignment.providerConfigId || defaultProvider.id, `${friendly(roleName)} provider`); const modelInput = node("input", "settings-input"); modelInput.placeholder = `${friendly(roleName)} model ID`; modelInput.maxLength = 2048; modelInput.value = assignment.modelId || ""; const execution = executionEditor(projection, select, modelInput, assignment.executionOptions, assignment.executionProfileStatus === "stale", assignment.executionCapability, assignment.providerConfigId, assignment.modelId); group.append(node("div", "field-label", friendly(roleName)), select, modelInput, execution.host); advanced.append(group); controls.push({ role: roleName, select, modelInput, execution }); });
    providerSearch.addEventListener("input", () => { const query = providerSearch.value.trim().toLocaleLowerCase(); controls.forEach((control) => control.select._providerOptions.forEach((entry) => { entry.option.hidden = !!query && !entry.text.includes(query); })); });
    advanced.append(node("p", "muted", "Selections are validated and committed together. Cancellation or incomplete input saves nothing. Repair uses Executor."));
    const saveAdvanced = node("button", "primary", "Save Advanced Roles"); saveAdvanced.type = "button"; saveAdvanced.addEventListener("click", () => { const assignments = controls.map((control) => ({ role: control.role, providerConfigId: control.select.value, modelId: control.modelInput.value.trim(), executionOptions: control.execution.read() })); if (assignments.every((item) => item.providerConfigId && item.modelId)) vscode.postMessage({ type: "updateRoleAssignments", assignments }); }); advanced.append(saveAdvanced); timeline.append(advanced);
  }

  function renderPlanning(projection) {
    settingsHeading("Planning"); const value = card("Planning Profile");
    const select = node("select", "settings-select"); projection.planning.profiles.forEach((profile) => { const option = node("option", "", profile.name); option.value = profile.id; option.selected = profile.id === projection.planning.selectedProfileId; select.append(option); });
    select.addEventListener("change", () => vscode.postMessage({ type: "updatePlanningProfile", profileId: select.value })); value.append(select);
    const selected = projection.planning.profiles.find((profile) => profile.id === projection.planning.selectedProfileId); if (selected) value.append(labeledValue("Plan Style", friendly(selected.planStyle)), labeledValue("Risk Mode", friendly(selected.riskMode)), labeledValue("Output Language", selected.outputLanguage), ...(selected.locale ? [labeledValue("Locale", selected.locale)] : [])); timeline.append(value);
  }

  function booleanRow(label, enabled) { return labeledValue(label, enabled ? "Enabled" : "Disabled", enabled ? "passed" : "muted"); }
  function renderGenericSection(projection, section) {
    const titles = Object.fromEntries(SETTINGS_SECTIONS.map((entry) => [entry[0], entry[1]])); settingsHeading(titles[section] || friendly(section));
    if (section === "workflow") { const p = projection.workflow; const value = card("Current Workflow Behavior"); value.append(labeledValue("Plan Approval", p.planApproval), labeledValue("After Approval", p.afterApproval), labeledValue("Pause / Resume", p.pauseResume), labeledValue("Automatic Repair", p.automaticRepair)); timeline.append(value); }
    else if (section === "engineeringRules") { timeline.append(node("p", "muted", "Effective precedence: Task › Workspace › Global. Resolution remains in Core.")); projection.rules.forEach((rule) => { const value = card(rule.name); value.append(node("p", "muted", rule.description), labeledValue("Scope", friendly(rule.scope)), labeledValue("Severity", friendly(rule.severity)), booleanRow("Status", rule.enabled)); timeline.append(value); }); }
    else if (section === "permissions") { [["Automatically Allowed", projection.permissions.automaticallyAllowed, "✓"], ["Ask First", projection.permissions.askFirst, "!"], ["Always Denied", projection.permissions.denied, "×"]].forEach(([title, items, mark]) => { const value = card(title); items.forEach((item) => value.append(node("div", "policy-line", `${mark} ${item}`))); timeline.append(value); }); timeline.append(node("p", "muted", "There is no allow-all or permission bypass. Core PermissionEngine is authoritative.")); }
    else if (section === "context") { const p = projection.context; const value = card("Context Strategy"); value.append(labeledValue("Strategy", p.strategy), labeledValue("Repository Context", p.repositoryContext), labeledValue("Targeted Expansion", p.targetedExpansion), labeledValue("Bounded Context", p.bounded), labeledValue("Task Limit", `${p.maxTaskFiles} files · ${formatNumber(p.maxTaskBytes)} bytes`)); timeline.append(value); }
    else if (section === "validation") { const value = card("Validation Pipeline"); projection.validation.steps.forEach((step) => value.append(labeledValue(step.kind, step.policy))); value.append(labeledValue("Fail Fast", projection.validation.failFast ? "Enabled" : "Disabled")); timeline.append(value); }
    else if (section === "review") { const p = projection.review; const value = card("Reviewer"); value.append(labeledValue("Assignment", p.reviewer.providerName ? `${p.reviewer.providerName} / ${p.reviewer.modelId}` : "Unconfigured"), booleanRow("Engineering Rules Applied", p.rulesApplied), booleanRow("Validation Failure Forces Fail", p.validationFailuresForceFail), booleanRow("Bounded Evidence", p.boundedEvidence), booleanRow("Targeted Context Expansion", p.targetedContextExpansion)); timeline.append(value); }
    else if (section === "repair") { const p = projection.repair; const value = card("Automatic Repair"); value.append(booleanRow("Enabled", p.automatic), booleanRow("Validation First", p.validationFirst), booleanRow("Planner Replan", p.plannerReplan), booleanRow("Context Reuse", p.contextReuse), labeledValue("Model Assignment", `Uses ${p.usesRole}`), labeledValue("Maximum Cycles", p.maximumCycles)); timeline.append(value); }
    else if (section === "usage") { const p = projection.usage; const value = card("Usage Sources"); value.append(labeledValue("Tokens", p.tokenSource), labeledValue("Cost", p.cost), labeledValue("History Metrics", p.historyMetrics)); timeline.append(value); }
    else if (section === "privacy") { const p = projection.privacy; const value = card("Privacy & Storage"); [["Credentials", p.credentials], ["Task History", p.taskHistory], ["Cloud Sync", p.cloudSync], ["Nyxara Account", p.account], ["Telemetry", p.telemetry], ["Provider Requests", p.providerRequests]].forEach(([key, val]) => value.append(labeledValue(key, val))); timeline.append(value); }
    else if (section === "advanced") { const p = projection.advanced; const value = card("Supported Technical Configuration"); [["Manual Model ID", p.manualModelId], ["Custom Endpoints", p.customEndpoints], ["Role Routing", p.roleRouting], ["Execution Profiles", "Capability-driven per role/model"], ["Diagnostics", p.diagnosticState]].forEach(([key, val]) => value.append(labeledValue(key, val))); timeline.append(value, node("p", "muted", "Automatic routing, Budget Engine, Skills, MCP, Hooks, Plugins, and Marketplace are not available in this phase.")); }
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
    [["all", "All"], ["active", "Active"], ["completed", "Completed"], ["failed", "Failed"], ["interrupted", "Interrupted"]].forEach(([value, label]) => filters.append(button(label, history.filter === value ? "chip selected" : "chip", "filterTasks", { filter: value })));
    shell.append(filters);
    const list = node("div", "history-list");
    if (!history.tasks.length) list.append(node("p", "history-empty muted", history.query ? "No matching local tasks." : "No tasks yet. Start your first task below."));
    else history.tasks.forEach((task) => list.append(taskRow(task, history.scope === "all")));
    shell.append(list);
    if (history.activeTaskId) shell.append(button("Return to Active Task", "primary return-active", "returnToActiveTask"));
    timeline.append(shell);
  }

  function historicalPlan(task) {
    if (!task.planSummary) return;
    const value = card("Implementation Plan", "plan-card");
    value.append(node("p", "objective", task.planSummary.objective));
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
    value.append(tasks);
    if (task.planSummary.risks.length) {
      const risks = node("ul", "risk-list");
      task.planSummary.risks.forEach((risk) => risks.append(node("li", "", `${friendly(risk.severity)} — ${risk.description}${risk.mitigation ? ` (${risk.mitigation})` : ""}`)));
      value.append(node("h3", "", "Risks"), risks);
    }
    value.append(node("div", "approved-line", task.planSummary.approvalStatus === "approved" ? "Approved ✓" : task.planSummary.approvalStatus === "rejected" ? "Rejected" : "Not approved"));
    timeline.append(value);
  }

  function renderHistoricalTask() {
    const history = historyState();
    const task = history.selectedTask;
    const heading = node("div", "history-screen-heading");
    heading.append(button("←", "icon-button", "openHistory"), node("h1", "", task ? task.title : "Task unavailable"));
    timeline.append(heading);
    if (!task) { timeline.append(node("p", "muted", "This local task is no longer available.")); return; }
    if (history.activeTaskId) timeline.append(button("Return to Active Task", "secondary return-active", "returnToActiveTask"));
    const requirement = node("section", "requirement-block");
    requirement.append(node("div", "eyebrow", "You"), node("div", "", task.requirement));
    timeline.append(requirement);
    historicalPlan(task);
    if (task.executionSummary) {
      const execution = card("Execution");
      execution.append(node("p", "", `${task.executionSummary.completed} / ${task.executionSummary.total} tasks completed`));
      const tasks = node("ul", "workflow-tasks");
      task.executionSummary.tasks.forEach((item) => {
        const row = node("li");
        row.append(node("span", item.status === "completed" ? "passed" : item.status === "failed" ? "failed" : "", item.status === "completed" ? "✓" : item.status === "failed" ? "✕" : "○"), node("span", "", `${item.title} — ${friendly(item.status)}`));
        tasks.append(row);
      });
      execution.append(tasks); timeline.append(execution);
    }
    if (task.validationSummary) {
      const validation = card("Validation");
      validation.append(node("p", task.validationSummary.status === "passed" ? "passed" : task.validationSummary.status === "failed" ? "failed" : "muted", friendly(task.validationSummary.status)));
      task.validationSummary.steps.forEach((step) => { const row = node("div", "step"); row.append(node("span", "", `${step.status === "passed" ? "✓" : step.status === "skipped" ? "–" : step.status === "failed" ? "✕" : "●"} ${friendly(step.name)}`), node("span", "muted", `${friendly(step.status)}${step.durationMs == null ? "" : ` · ${formatDuration(step.durationMs)}`}`)); validation.append(row); });
      timeline.append(validation);
    }
    if (task.reviewSummary) {
      const review = card("Review");
      review.append(node("p", task.reviewSummary.status === "passed" ? "passed" : task.reviewSummary.status === "failed" ? "failed" : "muted", friendly(task.reviewSummary.status)));
      if (task.reviewSummary.findingCount != null) review.append(node("p", "muted", `${task.reviewSummary.findingCount} structured finding${task.reviewSummary.findingCount === 1 ? "" : "s"}`));
      timeline.append(review);
    }
    if (task.repairSummary && task.repairSummary.cycles) {
      const repair = card("Repair");
      repair.append(node("p", "", `${task.repairSummary.cycles} cycle${task.repairSummary.cycles === 1 ? "" : "s"} · ${friendly(task.repairSummary.outcome || "unavailable")}`));
      timeline.append(repair);
    }
    const final = card(task.status === "completed" ? "Completed ✓" : friendly(task.status), task.status === "completed" ? "completion-success" : "completion-failure");
    if (task.status === "interrupted") final.append(node("p", "", "This workflow cannot be resumed automatically in the current version."));
    if (task.failureSummary) final.append(node("div", "eyebrow", "Stage"), node("p", "", task.failureSummary.stage), node("div", "eyebrow", "Reason"), node("p", "failed", task.failureSummary.message));
    const usage = task.usageSummary;
    const summary = node("dl", "summary");
    [["Provider", task.providerSummary ? `${task.providerSummary.provider}${task.providerSummary.model ? ` · ${task.providerSummary.model}` : ""}` : "-"], ["Tokens", formatNumber(usage && usage.totalTokens)], ["Model Calls", formatNumber(usage && usage.providerCalls)], ["Tool Calls", formatNumber(usage && usage.toolCalls)], ["Duration", formatDuration(usage && usage.workflowDurationMs)], ["Repair Cycles", formatNumber(usage && usage.repairCycles)]].forEach(([key, value]) => summary.append(node("dt", "muted", key), node("dd", "", value)));
    final.append(summary); timeline.append(final);
    if (terminalHistoryStatus(task.status) && task.id !== history.activeTaskId) {
      const actions = node("div", "history-detail-actions");
      actions.append(button("Delete Task", "danger", "deleteTask", { taskId: task.id }));
      if (!history.activeTaskId) actions.append(button("New Task", "primary", "newTask"));
      timeline.append(actions);
    }
  }

  function renderRequirement() {
    if (!state.prompt) return;
    const value = node("section", "requirement-block");
    value.append(node("div", "eyebrow", "You"), node("div", "", state.prompt));
    timeline.append(value);
  }

  function renderPlanning() {
    if (!state.prompt || state.plan || !state.workflow || !["created", "planning"].includes(state.workflow.status)) return;
    const line = node("div", "status-line");
    line.append(node("span", "spinner"), node("span", "", state.workflow.stage === "Analyzing" ? "Analyzing…" : "Planning…"));
    timeline.append(line);
  }

  function renderPlan() {
    if (!state.plan) return;
    const value = card("Implementation Plan", "plan-card");
    value.append(node("p", "objective", state.plan.objective));
    if (state.plan.summary) value.append(node("p", "muted", state.plan.summary));
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
    value.append(tasks);
    if (state.plan.risks.length) {
      value.append(node("h3", "", "Risks"));
      const risks = node("ul", "risk-list");
      state.plan.risks.forEach((risk) => risks.append(node("li", "", `${friendly(risk.severity)} — ${risk.description}${risk.mitigation ? ` (${risk.mitigation})` : ""}`)));
      value.append(risks);
    }
    if (workflowStatus() === "awaiting_plan_approval") addActions(value, [button("Reject", "secondary", "rejectPlan"), button("Approve & Run", "primary", "approvePlan")]);
    timeline.append(value);
  }

  function renderWorkflow() {
    const workflow = state.workflow;
    if (!workflow || workflow.status === "awaiting_plan_approval" || isTerminal()) return;
    const value = card(workflow.stage);
    if (afterApproval()) value.append(node("div", "approved-line", "Approved ✓"));
    const grid = node("div", "stage-grid");
    const currentIndex = workflow.currentTaskId ? workflow.tasks.findIndex((task) => task.id === workflow.currentTaskId) : -1;
    if (workflow.progress) {
      const taskNumber = currentIndex >= 0 ? currentIndex + 1 : Math.min(workflow.progress.completed + 1, workflow.progress.total);
      grid.append(node("span", "muted", "Task progress"), node("span", "", workflow.progress.total ? `Task ${taskNumber} / ${workflow.progress.total}` : "-"));
    }
    if (workflow.currentTaskId) {
      const current = workflow.tasks[currentIndex];
      grid.append(node("span", "muted", "Current task"), node("span", "", current ? current.title : workflow.currentTaskId));
    }
    value.append(grid);
    if (workflow.tasks.length) {
      const list = node("ul", "workflow-tasks");
      workflow.tasks.forEach((task) => {
        const icon = task.status === "completed" ? "✓" : task.status === "running" ? "●" : task.status === "failed" ? "✕" : task.status === "blocked" ? "!" : "○";
        const item = node("li");
        item.append(node("span", task.status === "completed" ? "passed" : task.status === "failed" ? "failed" : "", icon), node("span", "", task.title));
        list.append(item);
      });
      value.append(list);
    }
    if (workflow.active && workflow.status !== "waiting_for_permission") {
      const actions = [];
      if (["running", "executing", "validating", "reviewing", "repairing"].includes(workflow.status)) actions.push(button("Pause", "secondary", "pauseWorkflow"));
      if (workflow.status === "paused") actions.push(button("Resume", "primary", "resumeWorkflow"));
      actions.push(button("Abort", "danger", "abortWorkflow"));
      addActions(value, actions);
    }
    timeline.append(value);
  }

  function renderPermission() {
    const permission = state.workflow && state.workflow.permission;
    if (!permission) return;
    const value = card("Permission required", "permission");
    value.append(node("div", "eyebrow", "Action"), node("p", "", permission.action), node("div", "eyebrow", "Reason"), node("p", "", permission.reason));
    addActions(value, [button("Deny", "secondary", "denyPermission", { requestId: permission.id }), button("Allow Once", "primary", "allowPermission", { requestId: permission.id }), button("Abort", "danger", "abortWorkflow")]);
    timeline.append(value);
  }

  function renderValidation() {
    if (!afterApproval() && !state.validation.length) return;
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
    if (!afterApproval() && !state.reviewStatus) return;
    const value = card("Review");
    const status = state.reviewStatus;
    const label = status ? friendly(status) : workflowStatus() === "reviewing" ? "Running…" : ["executing", "running", "approved", "validating", "paused", "waiting_for_permission"].includes(workflowStatus()) ? "Pending" : "Unavailable";
    value.append(node("p", status === "passed" ? "passed" : status === "failed" ? "failed" : "muted", label));
    timeline.append(value);
  }

  function renderRepair() {
    if (workflowStatus() !== "repairing" && !(state.repairCycles > 0)) return;
    const value = card(workflowStatus() === "repairing" ? "Repairing" : "Repair");
    value.append(node("p", "", state.repairCycles == null ? "Cycle in progress" : `Cycle ${state.repairCycles}`));
    timeline.append(value);
  }

  function renderCompletion() {
    if (!state.completion) return;
    const completed = state.completion.status === "completed";
    const value = card(completed ? "Completed ✓" : friendly(state.completion.status), completed ? "completion-success" : "completion-failure");
    if (!completed && state.workflow && state.workflow.error) value.append(node("div", "eyebrow", "Stage"), node("p", "", state.workflow.error.stage), node("div", "eyebrow", "Reason"), node("p", "failed", state.workflow.error.message));
    const summary = node("dl", "summary");
    const validation = state.validation.some((step) => ["failed", "timed_out", "errored"].includes(step.status)) ? "Failed" : state.validation.length ? "Passed" : "-";
    [["Validation", validation], ["Review", state.reviewStatus ? friendly(state.reviewStatus) : "-"], ["Changed Files", formatNumber(state.completion.changedFiles)], ["Tokens", formatNumber(state.completion.tokens)], ["Model Calls", formatNumber(state.completion.modelCalls)], ["Duration", formatDuration(state.completion.durationMs)], ["Repair Cycles", formatNumber(state.completion.repairCycles)]].forEach(([key, value]) => summary.append(node("dt", "muted", key), node("dd", "", value)));
    value.append(summary);
    addActions(value, [button("New Task", "primary", "newTask")]);
    timeline.append(value);
  }

  function renderModelSelector() {
    model.replaceChildren();
    if (!state.providers.length) {
      const option = node("option", "", "Connect an AI provider");
      option.value = "";
      model.append(option);
      model.disabled = true;
      return;
    }
    if (state.advancedRouting) {
      const option = node("option", "", "Advanced routing");
      option.value = "";
      model.append(option);
    } else {
      state.providers.forEach((provider) => {
        const option = node("option", "", `${provider.displayName}${provider.modelId ? ` · ${provider.modelId}` : " · Choose model"}`);
        option.value = provider.modelId ? JSON.stringify({ providerConfigId: provider.id, modelId: provider.modelId }) : "";
        option.selected = provider.isDefault;
        if (!provider.modelId) option.disabled = true;
        model.append(option);
      });
    }
    const settings = node("option", "", state.advancedRouting ? "Configure routing…" : "Configure provider / model…");
    settings.value = "__settings__";
    model.append(settings);
    model.disabled = false;
  }

  function render() {
    const screen = state.settings ? `settings:${state.settings.section}:${state.settings.providerConfigId || ""}` : historyState().screen;
    const screenChanged = screen !== renderedScreen;
    const stick = !screenChanged && isNearBottom();
    timeline.replaceChildren();
    if (state.settings) renderSettings();
    else if (screen === "history") renderHistoryScreen();
    else if (screen === "historical") renderHistoricalTask();
    else {
      if (!state.prompt && !state.plan && !state.workflow) renderEmpty();
      renderRequirement();
      renderPlanning();
      renderPlan();
      renderWorkflow();
      renderPermission();
      renderValidation();
      renderReview();
      renderRepair();
      renderCompletion();
    }
    el("provider-dot").classList.toggle("connected", state.configured);
    el("provider-dot").setAttribute("aria-label", state.configured ? "Provider configured" : "Provider not configured");
    renderModelSelector();
    const active = !!(state.workflow && state.workflow.active);
    el("new-task").disabled = active || !!state.settings;
    el("new-task").title = active ? "Finish or abort the active workflow first" : "New Task";
    if (el("history")) el("history").classList.toggle("selected", !state.settings && historyState().screen !== "workspace");
    el("settings").classList.toggle("selected", !!state.settings);
    if (el("composer-wrap")) el("composer-wrap").classList.toggle("hidden", !!state.settings);
    input.disabled = !state.configured || !state.workspace.available || active || !!state.settings;
    submit.disabled = input.disabled || !input.value.trim() || sending;
    const warning = el("workspace-warning");
    warning.classList.toggle("hidden", state.workspace.available && !state.workspace.multiple);
    warning.textContent = !state.workspace.available ? "Open a folder or workspace to start a coding task." : state.workspace.multiple ? "Choose the target workspace when you generate a plan." : "";
    if (screenChanged) timeline.scrollTop = screen === "workspace" && state.workflow ? timeline.scrollHeight : 0;
    else if (stick) timeline.scrollTop = timeline.scrollHeight;
    renderedScreen = screen;
  }

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
  model.addEventListener("change", () => {
    if (model.value === "__settings__") {
      vscode.postMessage({ type: "openSettings" });
      renderModelSelector();
      return;
    }
    if (!model.value) return;
    try {
      const selection = JSON.parse(model.value);
      vscode.postMessage({ type: "selectModel", providerConfigId: selection.providerConfigId, modelId: selection.modelId });
    } catch {
      vscode.postMessage({ type: "openSettings" });
    }
  });

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
    const hadTask = !!(state && (state.prompt || state.plan || state.workflow));
    state = message.state;
    sending = false;
    el("notice").classList.add("hidden");
    if ((submittedTask && state.prompt === submittedTask) || (hadTask && !state.prompt && !state.plan && !state.workflow)) {
      input.value = "";
      submittedTask = undefined;
      resize();
    }
    render();
  });

  vscode.postMessage({ type: "ready" });
}());
