window.addEventListener("load", () => {
  const results = [];
  const visible = (element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
  const describe = (element) => `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : `.${element.className}`} ${element.getAttribute("aria-label") || ""}`;
  for (const scenario of window.layoutScenarios) {
    try {
      window.dispatchEvent(new MessageEvent("message", { data: { type: "settingsProjection", state: scenario.state } }));
      if (scenario.manual) {
        const select = document.querySelector(".model-select");
        select.value = "manual"; select.dispatchEvent(new Event("change"));
      }
      const timeline = document.getElementById("timeline");
      if (scenario.state.settings?.section === "workflow") timeline.querySelectorAll(".workflow-controls").forEach((details) => { details.open = true; });
      const outsideViewport = [];
      const outsideContainer = [];
      const invisibleControls = [];
      const undersizedFields = [];
      const scrollingContainers = [];
      for (const element of timeline.querySelectorAll("*")) {
        if (element.matches("input, select, textarea, button") && !visible(element) && !(element.matches("input.settings-input.hidden") && element.getAttribute("aria-label")?.endsWith("(manual)"))) invisibleControls.push(describe(element));
        if (!visible(element) || element.tagName === "OPTION") continue;
        const bounds = element.getBoundingClientRect();
        if (bounds.left < -1 || bounds.right > innerWidth + 1) outsideViewport.push(describe(element));
        if (element.matches("input, select, textarea, button")) {
          const parent = element.parentElement;
          const parentBounds = parent.getBoundingClientRect();
          const parentStyle = getComputedStyle(parent);
          const right = parentBounds.left + parent.clientLeft + parent.clientWidth - parseFloat(parentStyle.paddingRight);
          const left = parentBounds.left + parent.clientLeft + parseFloat(parentStyle.paddingLeft);
          if (bounds.left < left - 1 || bounds.right > right + 1) outsideContainer.push(describe(element));
          const compactWorkflowField = parent.classList.contains("workflow-setting");
          const minimumWidth = compactWorkflowField ? element.type === "checkbox" ? 12 : 60 : right - left - 1;
          if (element.matches("input, select, textarea") && bounds.width < minimumWidth) undersizedFields.push(describe(element));
        }
      }
      for (const element of [timeline, ...timeline.querySelectorAll(".card, .role-config, .execution-config, .settings-row, .settings-list, .settings-actions, .settings-value, .discovered-model-picker, p")]) {
        if (visible(element) && element.scrollWidth > element.clientWidth + 1) scrollingContainers.push({ element: describe(element), content: element.scrollWidth, available: element.clientWidth });
      }
      const ellipsis = [...timeline.querySelectorAll(".settings-select, .settings-row-title, .provider-detail > h2")].filter(visible).map((element) => {
        const style = getComputedStyle(element);
        return { element: describe(element), ellipsis: style.textOverflow === "ellipsis", nowrap: style.whiteSpace === "nowrap" };
      });
      const helpers = [...timeline.querySelectorAll("p")].filter(visible);
      const grid = timeline.querySelector(".execution-config");
      const liveStage = timeline.querySelector(".live-stage");
      const liveRows = liveStage ? [...liveStage.children].filter(visible) : [];
      let overlappingLiveRows = 0;
      for (let left = 0; left < liveRows.length; left += 1) for (let right = left + 1; right < liveRows.length; right += 1) {
        const a = liveRows[left].getBoundingClientRect(); const b = liveRows[right].getBoundingClientRect();
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) overlappingLiveRows += 1;
      }
      const liveTaskTitle = timeline.querySelector(".live-task-title");
      const promptPreview = timeline.querySelector(".requirement-preview");
      results.push({
        name: scenario.name, width: innerWidth, fontSize: parseFloat(getComputedStyle(document.body).fontSize), outsideViewport, outsideContainer, invisibleControls, undersizedFields, scrollingContainers, ellipsis,
        helperWraps: helpers.every((element) => getComputedStyle(element).overflowWrap === "anywhere" && element.scrollWidth <= element.clientWidth + 1),
        gridWidth: grid ? grid.getBoundingClientRect().width : null,
        gridTrack: grid ? parseFloat(getComputedStyle(grid).gridTemplateColumns) : null,
        selectedIds: [...timeline.querySelectorAll(".model-select")].map((select) => select.value),
        settingsColumns: timeline.querySelector(".settings-value") ? getComputedStyle(timeline.querySelector(".settings-value")).gridTemplateColumns.split(" ").length : null,
        clippedCards: [...timeline.querySelectorAll(".card")].filter((element) => ["hidden", "clip"].includes(getComputedStyle(element).overflowX)).length,
        apiKeyActions: [...timeline.querySelectorAll("button")].filter((element) => visible(element) && /^(Add|Update) API Key$/.test(element.textContent)).map((element) => element.textContent),
        liveTaskWraps: liveTaskTitle ? getComputedStyle(liveTaskTitle).whiteSpace === "normal" && liveTaskTitle.getBoundingClientRect().height > parseFloat(getComputedStyle(liveTaskTitle).lineHeight) * 1.5 : null,
        overlappingLiveRows,
        currentTaskTitles: [...timeline.querySelectorAll(".live-task-title")].filter(visible).length,
        progressLabels: [...timeline.querySelectorAll("*")].filter((element) => visible(element) && ["Task progress", "Current task"].includes(element.textContent)).length,
        composerModelCount: document.querySelectorAll("#composer-wrap #model, #composer-wrap .model-summary-button").length,
        liveProvider: timeline.querySelector(".live-stage-provider")?.textContent || null,
        planExpanded: timeline.querySelector(".plan-section details")?.open ?? null,
        promptPreviewBounded: promptPreview ? promptPreview.clientHeight <= parseFloat(getComputedStyle(promptPreview).maxHeight) + 1 && getComputedStyle(promptPreview).overflowY === "hidden" : null,
      });
    } catch (error) {
      results.push({ name: scenario.name, width: innerWidth, error: String(error.stack || error) });
    }
  }
  window.parent.postMessage({ type: "sidebarLayoutResults", results, errors: window.layoutErrors, messages: window.layoutMessages }, "*");
});
