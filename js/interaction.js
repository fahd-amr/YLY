(function () {
  "use strict";

  const categoryLabels = { fb: "Facebook", general: "General", sm: "SM" };
  const interactionChoices = {
    Facebook: ["Reacted", "Commented", "Shared", "None"],
    General: ["Reacted", "Replied", "Participated", "None"],
    SM: ["Reacted", "Replied", "Participated", "None"],
  };

  function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function ownValue(map, key) {
    return map && Object.hasOwn(map, String(key)) ? map[String(key)] : undefined;
  }

  function today() {
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function validMonth(value) {
    return /^\d{4}-(0[1-9]|1[0-2])$/.test(value) && Number(value.slice(0, 4)) > 0;
  }

  function monthLabel(value) {
    const [year, month] = value.split("-").map(Number);
    const date = new Date(0);
    date.setFullYear(year, month - 1, 1);
    date.setHours(12, 0, 0, 0);
    return date.toLocaleDateString("en", { month: "long", year: "numeric" });
  }

  function points(value) {
    return Number(value).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
  }

  function initializeInteraction() {
    const get = (id) => document.getElementById(id);
    const monthInput = get("interaction-month");
    const tableBody = get("interaction-members-body");
    const checkpointList = get("checkpoint-list");
    const pageError = get("interaction-error");
    const notice = get("interaction-notice");
    if (!monthInput || !tableBody || !checkpointList || !pageError || !notice) return;

    const api = window.YLYInteraction;
    const settingsDialog = get("interaction-settings-dialog");
    const checkpointDialog = get("checkpoint-dialog");
    const logDialog = get("interaction-log-dialog");
    const evaluationDialog = get("evaluation-dialog");
    const dialogs = [settingsDialog, checkpointDialog, logDialog, evaluationDialog];
    const returnFocus = new Map();
    const weightFields = Object.fromEntries(["fb", "general", "sm", "hr"].map((key) => [key, get(`weight-${key}`)]));
    const hrFields = { responds: get("hr-responds"), proofs: get("hr-proofs"), properComm: get("hr-proper-comm") };
    let logSession = null;
    let evaluationSession = null;
    let settingsSnapshot = "";
    let initialized = false;

    const parameters = new URLSearchParams(window.location ? window.location.search : "");
    const requestedMonth = parameters.get("month");
    monthInput.value = validMonth(requestedMonth || "") ? requestedMonth : api.currentMonth();

    function showError(target, error) {
      target.textContent = error && error.message ? error.message : String(error);
      target.hidden = false;
    }

    function activeMembers() {
      return window.YLYData.getMembers().filter((member) => member && member.id !== undefined && member.id !== null
        && !window.YLYData.isMemberArchived(member));
    }

    function requireMember(id) {
      const member = activeMembers().find((item) => String(item.id) === String(id));
      if (!member) throw new Error("This member is no longer active. Close this dialog and refresh the page.");
      return member;
    }

    function requireMonth() {
      if (!validMonth(monthInput.value)) throw new Error("Choose a valid month.");
      return monthInput.value;
    }

    function findButton(container, attribute, id) {
      return Array.from(container.querySelectorAll(`button[data-${attribute}]`)).find((button) => {
        const key = attribute.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        return button.dataset[key] === String(id);
      });
    }

    function openDialog(dialog, focus, restore) {
      if (dialogs.some((item) => item.open)) return;
      returnFocus.set(dialog.id, restore);
      dialog.showModal();
      focus.focus();
    }

    dialogs.forEach((dialog) => {
      dialog.addEventListener("close", () => {
        const restore = returnFocus.get(dialog.id);
        const target = restore && restore();
        (target || monthInput).focus();
        returnFocus.delete(dialog.id);
        if (dialog === logDialog) logSession = null;
        if (dialog === evaluationDialog) evaluationSession = null;
      });
    });
    document.querySelectorAll("[data-close-dialog]").forEach((button) => {
      button.addEventListener("click", () => get(button.dataset.closeDialog).close());
    });

    function scoreCell(score, weight, detail) {
      const cell = document.createElement("td");
      cell.append(element("span", "interaction-score", `${points(score)} / ${weight}`));
      if (detail) cell.append(element("small", "interaction-muted", detail));
      return cell;
    }

    function renderMembers(members, state, month) {
      const fragment = document.createDocumentFragment();
      let evaluated = 0;
      let review = 0;
      members.forEach((member) => {
        const report = api.calculateMember(month, member.id, state);
        const row = document.createElement("tr");
        const nameCell = document.createElement("th");
        nameCell.scope = "row";
        const link = element("a", "member-profile-link", member.name || "Unnamed member");
        link.href = `member-details.html?id=${encodeURIComponent(String(member.id))}`;
        nameCell.append(link);
        row.append(nameCell);
        ["fb", "general", "sm"].forEach((key) => {
          const stat = report.categories[key];
          row.append(scoreCell(stat.score, stat.weight, `${stat.interacted} / ${stat.checked} checked`));
        });
        row.append(scoreCell(report.hr.score, report.hr.weight, `${report.hr.checked} / 3 HR checks`));
        row.append(element("td", "interaction-score", points(report.suggestedScore)));
        const finalCell = document.createElement("td");
        if (report.finalEvaluation) {
          evaluated += 1;
          finalCell.append(element("span", "status-badge badge-success", report.finalEvaluation.finalScore));
        } else {
          finalCell.append(element("span", "status-badge badge-warning", "Pending"));
        }
        if (report.needsReview) {
          review += 1;
          if (report.finalEvaluation) finalCell.append(element("small", "interaction-muted", "Needs review"));
        }
        const actions = document.createElement("td");
        const evaluate = element("button", "table-action", "Evaluate");
        evaluate.type = "button";
        evaluate.dataset.evaluateMember = String(member.id);
        evaluate.setAttribute("aria-label", `Evaluate ${member.name || "member"}`);
        actions.append(evaluate);
        row.append(finalCell, actions);
        fragment.append(row);
      });
      if (!members.length) {
        const row = document.createElement("tr");
        const cell = element("td", "members-empty", "No active members. Add or restore a member to begin.");
        cell.colSpan = 8;
        row.append(cell);
        fragment.append(row);
      }
      tableBody.replaceChildren(fragment);
      get("interaction-members-total").textContent = members.length;
      get("interaction-evaluated-total").textContent = evaluated;
      get("interaction-review-total").textContent = review;
    }

    function renderCheckpoints(state, month, members) {
      const fragment = document.createDocumentFragment();
      const checkpoints = state.checkpoints.filter((checkpoint) => checkpoint.month === month)
        .sort((first, second) => first.date.localeCompare(second.date));
      checkpoints.forEach((checkpoint) => {
        const card = element("article", "interaction-checkpoint");
        const info = document.createElement("div");
        info.append(element("h3", "", checkpoint.title));
        info.append(element("p", "interaction-checkpoint-meta", `${checkpoint.type} · ${checkpoint.date} · ${checkpoint.interactionExpected === "Yes" ? "Interaction expected" : "Optional — not scored"}`));
        const records = ownValue(state.checkpointInteractions, checkpoint.id) || {};
        const checked = members.filter((member) => Object.hasOwn(records, String(member.id))).length;
        info.append(element("p", "interaction-muted", `${checked} / ${members.length} active members checked`));
        const actions = element("div", "interaction-checkpoint-actions");
        const log = element("button", "btn btn-secondary", "Log Interactions");
        log.type = "button";
        log.dataset.logCheckpoint = String(checkpoint.id);
        log.setAttribute("aria-label", `Log interactions for ${checkpoint.title}`);
        actions.append(log);
        card.append(info, actions);
        fragment.append(card);
      });
      if (!checkpoints.length) fragment.append(element("p", "interaction-empty", "No checkpoints for this month. Add a checkpoint to begin tracking interactions."));
      checkpointList.replaceChildren(fragment);
    }

    function refresh() {
      try {
        if (!api) throw new Error("The Interaction module could not load. Reload the page and try again.");
        if (!initialized) { api.initialize(); initialized = true; }
        const month = requireMonth();
        const state = api.read();
        const members = activeMembers();
        renderMembers(members, state, month);
        renderCheckpoints(state, month, members);
        get("interaction-period-label").textContent = monthLabel(month);
        pageError.hidden = true;
      } catch (error) {
        tableBody.replaceChildren();
        checkpointList.replaceChildren();
        ["interaction-members-total", "interaction-evaluated-total", "interaction-review-total"].forEach((id) => { get(id).textContent = "—"; });
        get("interaction-period-label").textContent = "Interaction data unavailable";
        showError(pageError, error);
      }
    }

    function updateWeightTotal() {
      const values = Object.values(weightFields).map((input) => input.value.trim());
      const whole = values.every((value) => /^(?:[0-9]|10)$/.test(value));
      const total = values.reduce((sum, value) => sum + Number(value || 0), 0);
      get("weights-total").textContent = whole && total === 10 ? "10 / 10 points assigned." : "Weights must total 10. Use whole numbers from 0 to 10.";
    }

    get("interaction-settings-btn").addEventListener("click", () => {
      try {
        const settings = api.read().interactionSettings;
        settingsSnapshot = JSON.stringify(settings);
        Object.entries(weightFields).forEach(([key, input]) => { input.value = String(settings[key]); });
        get("settings-error").hidden = true;
        updateWeightTotal();
        openDialog(settingsDialog, weightFields.fb, () => get("interaction-settings-btn"));
      } catch (error) { showError(pageError, error); }
    });
    Object.values(weightFields).forEach((input) => input.addEventListener("input", updateWeightTotal));
    get("interaction-settings-form").addEventListener("submit", (event) => {
      event.preventDefault();
      try {
        const values = Object.values(weightFields).map((input) => input.value.trim());
        if (!values.every((value) => /^(?:[0-9]|10)$/.test(value))) throw new Error("Use whole-number weights from 0 to 10.");
        const settings = Object.fromEntries(Object.entries(weightFields).map(([key, input]) => [key, Number(input.value)]));
        if (JSON.stringify(api.read().interactionSettings) !== settingsSnapshot) throw new Error("Settings changed in another tab. Close and reopen this dialog before saving.");
        api.saveSettings(settings);
        settingsDialog.close();
        refresh();
        notice.textContent = "Interaction weights saved. Suggested scores have been recalculated.";
      } catch (error) { showError(get("settings-error"), error); }
    });

    get("add-checkpoint-btn").addEventListener("click", () => {
      try {
        const month = requireMonth();
        get("checkpoint-form").reset();
        get("checkpoint-type").value = "Facebook";
        get("checkpoint-expected").value = "Yes";
        get("checkpoint-date").value = today().slice(0, 7) === month ? today() : `${month}-01`;
        get("checkpoint-error").hidden = true;
        openDialog(checkpointDialog, get("checkpoint-title"), () => get("add-checkpoint-btn"));
      } catch (error) { showError(pageError, error); }
    });
    get("checkpoint-form").addEventListener("submit", (event) => {
      event.preventDefault();
      try {
        const checkpoint = api.addCheckpoint({
          type: get("checkpoint-type").value,
          title: get("checkpoint-title").value.trim(),
          date: get("checkpoint-date").value,
          interactionExpected: get("checkpoint-expected").value,
        });
        monthInput.value = checkpoint.month;
        checkpointDialog.close();
        refresh();
        notice.textContent = `Checkpoint added to ${monthLabel(checkpoint.month)}.`;
      } catch (error) { showError(get("checkpoint-error"), error); }
    });

    function checkpointSignature(checkpoint) {
      return JSON.stringify([checkpoint.month, checkpoint.type, checkpoint.interactionExpected]);
    }

    function openLog(checkpointId) {
      try {
        const month = requireMonth();
        const state = api.read();
        const checkpoint = state.checkpoints.find((item) => String(item.id) === checkpointId && item.month === month);
        if (!checkpoint) throw new Error("This checkpoint is no longer available in the selected month.");
        const members = activeMembers();
        const records = ownValue(state.checkpointInteractions, checkpoint.id) || {};
        const fragment = document.createDocumentFragment();
        const entries = [];
        members.forEach((member, index) => {
          const row = element("div", "interaction-log-row");
          const label = element("label", "interaction-log-member", member.name || "Unnamed member");
          const select = element("select", "form-input");
          select.id = `checkpoint-member-${index}`;
          select.dataset.interactionMember = String(member.id);
          label.htmlFor = select.id;
          const initial = ownValue(records, member.id) || "";
          ["", ...interactionChoices[checkpoint.type]].forEach((value) => {
            const option = element("option", "", value === "" ? "Unchecked" : value === "None" ? "No Interaction" : value);
            option.value = value;
            option.disabled = value === "" && initial !== "";
            select.append(option);
          });
          select.value = initial;
          row.append(label, select);
          entries.push({ memberId: member.id, initial, select });
          fragment.append(row);
        });
        if (!members.length) fragment.append(element("p", "interaction-empty", "No active members to check."));
        get("interaction-log-members").replaceChildren(fragment);
        get("interaction-log-title").textContent = checkpoint.title;
        get("interaction-log-help").textContent = `${checkpoint.type} · ${monthLabel(month)}. Unchecked members are excluded from the scoring denominator. No Interaction records a checked checkpoint with zero engagement.${checkpoint.interactionExpected === "No" ? " This optional checkpoint does not affect scores." : ""}`;
        get("interaction-log-error").hidden = true;
        get("interaction-log-save").disabled = members.length === 0;
        logSession = { checkpointId, month, signature: checkpointSignature(checkpoint), entries };
        openDialog(logDialog, entries[0]?.select || logDialog.querySelector("[data-close-dialog]"), () => findButton(checkpointList, "log-checkpoint", checkpointId));
      } catch (error) { showError(pageError, error); }
    }

    checkpointList.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-log-checkpoint]");
      if (button && checkpointList.contains(button)) openLog(button.dataset.logCheckpoint);
    });
    get("interaction-log-form").addEventListener("submit", (event) => {
      event.preventDefault();
      if (!logSession) return;
      try {
        if (requireMonth() !== logSession.month) throw new Error("The selected month changed. Close and reopen this checkpoint.");
        const state = api.read();
        const checkpoint = state.checkpoints.find((item) => String(item.id) === logSession.checkpointId);
        if (!checkpoint || checkpointSignature(checkpoint) !== logSession.signature) throw new Error("This checkpoint changed. Close and reopen it before saving.");
        const current = ownValue(state.checkpointInteractions, checkpoint.id) || {};
        const updates = Object.create(null);
        logSession.entries.forEach(({ memberId, initial, select }) => {
          if (select.value === initial) return;
          requireMember(memberId);
          if ((ownValue(current, memberId) || "") !== initial) throw new Error("An interaction changed in another tab. Close and reopen this checkpoint before saving.");
          if (!select.value) throw new Error("Choose an interaction or No Interaction for each changed member.");
          updates[String(memberId)] = select.value;
        });
        api.saveCheckpointInteractions(checkpoint.id, updates);
        logDialog.close();
        refresh();
        notice.textContent = "Checkpoint interactions saved.";
      } catch (error) { showError(get("interaction-log-error"), error); }
    });

    function readHR() {
      return Object.fromEntries(Object.entries(hrFields).map(([key, input]) => [key, input.checked]));
    }

    function evaluationSnapshot(month, memberId, state) {
      return JSON.stringify({ settings: state.interactionSettings, report: api.calculateMember(month, memberId, state) });
    }

    function updateEvaluationPreview() {
      if (!evaluationSession) return;
      try {
        const { month, memberId, state } = evaluationSession;
        const report = api.calculateMember(month, memberId, state, readHR());
        get("evaluation-suggested").textContent = points(report.suggestedScore);
        get("evaluation-hr-help").textContent = `HR: ${report.hr.checked} / 3 checks · ${points(report.hr.score)} / ${report.hr.weight} points. Each checked item earns ${points(report.hr.weight / 3)} points.`;
      } catch (error) { showError(get("evaluation-error"), error); }
    }

    function openEvaluation(memberId) {
      try {
        const month = requireMonth();
        const member = requireMember(memberId);
        const state = api.read();
        const report = api.calculateMember(month, member.id, state);
        const hr = ownValue(state.hrEvaluations, `${month}_${member.id}`) || {};
        Object.entries(hrFields).forEach(([key, input]) => { input.checked = hr[key] === true; });
        get("evaluation-title").textContent = `${member.name || "Unnamed member"} · ${monthLabel(month)}`;
        const fragment = document.createDocumentFragment();
        ["fb", "general", "sm"].forEach((key) => {
          const stat = report.categories[key];
          const card = element("section", "interaction-breakdown-card");
          card.append(element("h3", "", categoryLabels[key]));
          card.append(element("p", "interaction-breakdown-number", `${stat.interacted} / ${stat.checked}`));
          card.append(element("p", "interaction-muted", "Interacted / Total Checked"));
          const engagement = stat.checked ? `${points(stat.interacted / stat.checked * 100)}% engagement` : "No checked checkpoints; full category weight";
          card.append(element("p", "", `${engagement} · ${points(stat.score)} / ${stat.weight} points`));
          card.append(element("small", "interaction-muted", `${stat.total - stat.checked} expected checkpoints unchecked`));
          fragment.append(card);
        });
        get("evaluation-breakdown").replaceChildren(fragment);
        get("evaluation-final").value = report.finalEvaluation ? String(report.finalEvaluation.finalScore) : "";
        get("evaluation-note").value = report.finalEvaluation ? report.finalEvaluation.note : "";
        get("evaluation-error").hidden = true;
        get("evaluation-review-note").textContent = report.missingLogs > 0
          ? `${report.missingLogs} expected checkpoints are still unchecked. Their results are not included in the suggested score.`
          : report.finalEvaluation && report.needsReview ? "The suggested score has changed since the last evaluation. Review the final score before saving." : "";
        get("evaluation-review-note").hidden = !get("evaluation-review-note").textContent;
        evaluationSession = { month, memberId: member.id, state, snapshot: evaluationSnapshot(month, member.id, state) };
        updateEvaluationPreview();
        openDialog(evaluationDialog, hrFields.responds, () => findButton(tableBody, "evaluate-member", memberId));
      } catch (error) { showError(pageError, error); }
    }

    tableBody.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-evaluate-member]");
      if (button && tableBody.contains(button)) openEvaluation(button.dataset.evaluateMember);
    });
    Object.values(hrFields).forEach((input) => input.addEventListener("change", updateEvaluationPreview));
    get("evaluation-form").addEventListener("submit", (event) => {
      event.preventDefault();
      if (!evaluationSession) return;
      try {
        const { month, memberId, snapshot } = evaluationSession;
        if (requireMonth() !== month) throw new Error("The selected month changed. Close and reopen this evaluation.");
        requireMember(memberId);
        if (!/^(?:[0-9]|10)$/.test(get("evaluation-final").value)) throw new Error("Choose a whole-number final score from 0 to 10.");
        const state = api.read();
        if (evaluationSnapshot(month, memberId, state) !== snapshot) throw new Error("This member's interaction data or settings changed. Close and reopen the evaluation before saving.");
        api.saveEvaluation(month, memberId, { ...readHR(), finalScore: Number(get("evaluation-final").value), note: get("evaluation-note").value.trim() });
        evaluationDialog.close();
        refresh();
        notice.textContent = "Member evaluation saved.";
      } catch (error) { showError(get("evaluation-error"), error); }
    });

    monthInput.addEventListener("change", () => { notice.textContent = ""; refresh(); });
    window.addEventListener("storage", (event) => {
      if (event.key === null || ["members", "interactionSettings", "checkpoints", "checkpointInteractions", "hrEvaluations", "finalEvaluations"].includes(event.key)) refresh();
    });
    window.addEventListener("yly:interaction-changed", refresh);
    window.addEventListener("yly:data-changed", (event) => { if (!event.detail || event.detail.key === "members") refresh(); });
    refresh();
    const requestedMember = parameters.get("member");
    if (requestedMember && pageError.hidden) openEvaluation(requestedMember);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initializeInteraction, { once: true });
  else initializeInteraction();
})();
