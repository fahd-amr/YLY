(function () {
  "use strict";

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function normalize(value) {
    return String(value || "").trim().toLocaleLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  }

  function statusLabel(status) {
    const value = String(status || "").trim();
    if (!value) return "Status not set";
    if (normalize(value) === "needs follow up") return "Needs Follow-up";
    if (normalize(value) === "up to date") return "Up to date";
    return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toLocaleUpperCase());
  }

  function isPending(status) {
    const value = normalize(status);
    return value.startsWith("pending") || value === "needs follow up";
  }

  function statusClass(status) {
    const value = normalize(status);
    if (isPending(status)) return "badge-warning";
    if (["attended", "done", "completed", "up to date"].includes(value)) return "badge-success";
    if (["upcoming", "applied", "selected"].includes(value)) return "badge-upcoming";
    return "badge-neutral";
  }

  // Calendar dates are parsed locally, preserving the day in every time zone.
  function parseDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(0);
    date.setFullYear(year, month - 1, day);
    date.setHours(0, 0, 0, 0);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
      ? date
      : null;
  }

  function formatDate(date) {
    return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function getSource(activity) {
    const source = typeof activity.source === "string" ? activity.source.trim() : "";
    const committee = typeof activity.committee === "string" ? activity.committee.trim() : "";
    return source || committee || "General";
  }

  function reasonLabel(status, reason) {
    if (typeof reason !== "string" || !reason.trim()) return "";
    return ["excuse", "excused"].includes(normalize(status))
      ? `Excuse - ${reason.trim()}`
      : reason.trim();
  }

  function renderActivity(activity, assignment, progress, readOnly) {
    const row = createElement("li", `profile-activity-row${readOnly ? "" : " is-interactive"}`);
    if (!readOnly) row.dataset.statusActivityId = String(activity.id);
    const info = createElement("div", "profile-activity-info");
    const type = normalize(activity.type);
    const typeClasses = { session: "badge-session", event: "badge-event", task: "badge-task" };
    const status = createElement("div", "profile-activity-status");
    const meta = createElement("p", "profile-activity-meta");
    const primaryDateField = type === "task" ? "deadline" : "date";
    const fallbackDateField = type === "task" ? "date" : "deadline";
    const dateField = parseDate(activity[primaryDateField]) ? primaryDateField : fallbackDateField;
    const date = parseDate(activity[dateField]);

    info.append(
      createElement("span", `status-badge ${Object.prototype.hasOwnProperty.call(typeClasses, type) ? typeClasses[type] : "badge-neutral"}`, statusLabel(activity.type || "Activity")),
      createElement("h4", "profile-activity-title", activity.name || "Untitled activity")
    );
    meta.append(`${getSource(activity)} · `);
    if (date) {
      const time = createElement("time", "", formatDate(date));
      time.dateTime = activity[dateField];
      meta.append(dateField === "deadline" ? "Deadline " : "Date ", time);
    } else {
      meta.append("Date not set");
    }
    info.append(meta);
    const lateTask = type === "task" && progress.outcome === "done" && assignment.isLate === true;
    status.append(createElement("span", `status-badge ${lateTask ? "status-late" : statusClass(progress.status)}`, lateTask ? "Done (Late)" : statusLabel(progress.status)));
    if (lateTask && progress.proofPending) {
      status.append(createElement("span", "status-badge badge-warning", "Pending Proof"));
    }
    if (type === "task" && progress.outcome === "done" && parseDate(assignment.submissionDate)) {
      const submitted = createElement("p", "profile-activity-note");
      const time = createElement("time", "", formatDate(parseDate(assignment.submissionDate)));
      time.dateTime = assignment.submissionDate;
      submitted.append("Submitted ", time);
      status.append(submitted);
    }

    // Optional assignment extensions: reason/excuseReason and history: ["applied",
    // { status: "selected", date: "2026-09-20", reason: "..." }]. Only saved steps
    // belonging to this member are shown; completed statuses imply no past steps.
    const reason = reasonLabel(progress.outcome || progress.status, assignment.excuseReason || assignment.reason);
    if (reason) status.append(createElement("p", "profile-activity-note", reason));

    const proof = window.YLYData.getActivityProofSettings(activity);
    if (proof.required) {
      const proofName = proof.type === "form_confirmation" ? "Form confirmation" : "Screenshot";
      const matchingType = !assignment.proofType || assignment.proofType === proof.type;
      const receiptNote = (label, key) => {
        const received = matchingType ? assignment[key] : false;
        const receipt = received === true ? "received" : received === false ? "not received" : "not recorded";
        status.append(createElement("p", "profile-activity-note", `${label}: ${receipt}`));
      };
      if (type === "task" && (progress.outcome === "done" || progress.status === "done" || progress.status === "pending_proof")) {
        receiptNote(proofName, "proofReceived");
      }
      if (type === "event") {
        if (progress.applied) receiptNote(`Application ${proofName.toLocaleLowerCase()}`, "applicationProofReceived");
        if ((progress.outcome || progress.status) === "attended") receiptNote(`Attendance ${proofName.toLocaleLowerCase()}`, "attendanceProofReceived");
      }
    }

    let history = Array.isArray(assignment.history) ? assignment.history.flatMap((step) => {
      if (typeof step === "string" && step.trim()) return [{ status: step }];
      if (step && typeof step.status === "string" && step.status.trim()) return [step];
      return [];
    }) : [];

    const hasEventWorkflow = type === "event" && ["applied", "selection", "finalStatus"].some((key) => Object.prototype.hasOwnProperty.call(assignment, key));
    if (hasEventWorkflow) {
      // Explicit workflow fields describe the current progression, while history
      // remains available for legacy records that did not store these fields.
      history = [];
      if (progress.applied) history.push({ status: "applied" });
      if (progress.applied && progress.selection) history.push({ status: progress.selection });
      if (progress.applied && progress.selection === "selected") {
        history.push({ status: progress.finalStatus || "pending" });
      }
    }

    if (history.length) {
      if (!hasEventWorkflow && normalize(assignment.status) && normalize(history[history.length - 1].status) !== normalize(assignment.status)) {
        history.push({ status: assignment.status });
      }
      const timeline = createElement("ol", "status-timeline");
      timeline.setAttribute("aria-label", hasEventWorkflow ? "Current event progress" : "Status history");
      history.forEach((step) => {
        const item = createElement("li", "timeline-step");
        const lateStep = type === "task" && ["done", "completed"].includes(normalize(step.status)) && step.isLate === true;
        item.append(createElement("span", `timeline-label${lateStep ? " status-late" : ""}`, lateStep ? "Done (Late)" : statusLabel(step.status)));
        const stepDate = parseDate(step.date);
        if (stepDate) {
          const time = createElement("time", "timeline-date", formatDate(stepDate));
          time.dateTime = step.date;
          item.append(time);
        }
        const stepReason = reasonLabel(step.status, step.excuseReason || step.reason);
        if (stepReason) item.append(createElement("span", "profile-activity-note", stepReason));
        timeline.append(item);
      });
      info.append(timeline);
    }

    const updateButton = createElement("button", "btn btn-secondary profile-update-button", "Update Status");
    updateButton.type = "button";
    updateButton.disabled = readOnly;
    if (readOnly) updateButton.title = "Restore this member to update activity statuses.";
    updateButton.setAttribute("aria-label", `Update status for ${activity.name || "this activity"}`);
    status.append(updateButton);

    row.append(info, status);
    return row;
  }

  function initializeMemberDetails() {
    const memberId = new URLSearchParams(window.location.search).get("id");
    if (memberId === null || !memberId.trim()) {
      window.location.replace("members.html");
      return;
    }

    const content = document.getElementById("member-details-content");
    const errorMessage = document.getElementById("member-details-error");
    if (!content || !errorMessage) return;

    const initial = document.getElementById("profile-initial");
    const name = document.getElementById("profile-name");
    const committee = document.getElementById("profile-committee");
    const status = document.getElementById("profile-status");
    const joinedDate = document.getElementById("profile-joined-date");
    const totalPending = document.getElementById("total-pending");
    const eventsAttended = document.getElementById("events-attended");
    const tasksDone = document.getElementById("tasks-done");
    const editButton = document.getElementById("edit-member-button");
    const interactionMonth = document.getElementById("member-interaction-month");
    const interactionError = document.getElementById("member-interaction-error");
    const interactionStats = document.getElementById("member-interaction-stats");
    const interactionResults = document.getElementById("member-interaction-results");
    const interactionSuggested = document.getElementById("member-interaction-suggested");
    const interactionFinal = document.getElementById("member-interaction-final");
    const interactionNote = document.getElementById("member-interaction-note");
    const interactionKeys = ["interactionSettings", "checkpoints", "checkpointInteractions", "hrEvaluations", "finalEvaluations"];
    let currentProfileMember = null;
    let renderingInteraction = false;
    const tabs = ["overview", "activities", "interaction"].map((key) => ({
      key,
      button: document.getElementById(`profile-tab-${key}`),
      panel: document.getElementById(`profile-panel-${key}`),
    }));
    function activateTab(index, focus = false) {
      tabs.forEach((tab, position) => {
        const selected = position === index;
        tab.button.setAttribute("aria-selected", String(selected));
        tab.button.tabIndex = selected ? 0 : -1;
        tab.panel.hidden = !selected;
      });
      if (focus) tabs[index].button.focus();
      if (tabs[index].key === "interaction") refreshInteraction();
    }
    tabs.forEach((tab, index) => {
      tab.button.addEventListener("click", () => activateTab(index));
      tab.button.addEventListener("keydown", (event) => {
        const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
          : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
            : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
        if (next === null) return;
        event.preventDefault();
        activateTab(next, true);
      });
    });
    const now = new Date();
    interactionMonth.value = typeof window.YLYInteraction?.currentMonth === "function"
      ? window.YLYInteraction.currentMonth()
      : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    interactionMonth.addEventListener("change", refreshInteraction);

    function refreshInteraction() {
      if (!currentProfileMember || renderingInteraction) return;
      renderingInteraction = true;
      try {
        if (!window.YLYInteraction) throw new Error("The interaction module could not be loaded. Reload the page to try again.");
        const state = window.YLYInteraction.read();
        const report = window.YLYInteraction.calculateMember(interactionMonth.value, currentProfileMember.id, state);
        const fragment = document.createDocumentFragment();
        const points = (value) => String(Math.round((value + Number.EPSILON) * 100) / 100);
        [["fb", "Facebook"], ["general", "General"], ["sm", "SM"]].forEach(([key, label]) => {
          const category = report.categories[key];
          const card = createElement("article", "stat-card member-interaction-score");
          card.append(
            createElement("h3", "stat-label", label),
            createElement("p", "stat-number", `${points(category.score)} / ${category.weight}`),
            createElement("p", "status-help", `${category.interacted} interacted / ${category.checked} checked`)
          );
          if (!category.checked) card.append(createElement("p", "status-help", "No checked checkpoints: full category weight."));
          const unchecked = category.total - category.checked;
          if (unchecked) card.append(createElement("p", "status-help", `${unchecked} expected checkpoint${unchecked === 1 ? "" : "s"} not checked yet.`));
          fragment.append(card);
        });
        const hr = createElement("article", "stat-card member-interaction-score");
        hr.append(
          createElement("h3", "stat-label", "HR"),
          createElement("p", "stat-number", `${points(report.hr.score)} / ${report.hr.weight}`),
          createElement("p", "status-help", `${report.hr.checked} of 3 HR checks`)
        );
        fragment.append(hr);
        interactionStats.replaceChildren(fragment);
        interactionSuggested.textContent = `${points(report.suggestedScore)} / 10`;
        interactionFinal.textContent = report.finalEvaluation ? `${report.finalEvaluation.finalScore} / 10` : "Pending";
        interactionNote.textContent = report.finalEvaluation
          ? report.finalEvaluation.note || "No evaluation note was added."
          : "No evaluation has been saved for this month.";
        interactionResults.hidden = false;
        interactionError.textContent = "";
        interactionError.hidden = true;
      } catch (error) {
        // Interaction data is independent of activity data: keep activity editing usable.
        interactionStats.replaceChildren();
        interactionSuggested.textContent = "—";
        interactionFinal.textContent = "—";
        interactionNote.textContent = "";
        interactionResults.hidden = true;
        interactionError.textContent = error.message || "Interaction details could not be loaded. Check the saved interaction data.";
        interactionError.hidden = false;
      } finally {
        renderingInteraction = false;
      }
    }
    const groups = [
      { key: "pending", matches: (item) => item.progress.pending, empty: "No pending items. You're all caught up!" },
      { key: "sessions", matches: (item) => normalize(item.activity.type) === "session", empty: "No sessions assigned to this member." },
      { key: "events", matches: (item) => normalize(item.activity.type) === "event", empty: "No events assigned to this member." },
      { key: "tasks", matches: (item) => normalize(item.activity.type) === "task", empty: "No tasks assigned to this member." },
    ].map((group) => ({
      ...group,
      list: document.getElementById(`member-${group.key}-list`),
      count: document.getElementById(`${group.key}-count`),
    }));

    function showPageError(message) {
      currentProfileMember = null;
      content.hidden = true;
      editButton.disabled = true;
      initial.textContent = "";
      name.textContent = "";
      committee.textContent = "";
      status.textContent = "";
      joinedDate.textContent = "";
      [totalPending, eventsAttended, tasksDone].forEach((stat) => { stat.textContent = "—"; });
      groups.forEach((group) => {
        group.list.replaceChildren();
        group.count.textContent = "—";
      });
      document.title = "Member Details | YLY Follow-Up";
      errorMessage.textContent = message;
      errorMessage.hidden = false;
    }

    function refreshProfile() {
      try {
        const members = window.YLYData.getMembers();
        const member = members.find((record) => record && String(record.id) === memberId);
        if (!member) {
          showPageError("Member not found. This member may have been removed. Return to Members to choose another member.");
          return;
        }
        const activities = window.YLYData.getActivities();
        const assignments = activities.flatMap((activity) => {
          if (!activity || activity.id === undefined || activity.id === null || window.YLYData.isActivityArchived(activity)) return [];
          const assignment = window.YLYData.getActivityMemberStatuses(activity).find((target) => String(target.memberId) === memberId);
          return assignment ? [{ activity, assignment, progress: window.YLYData.getMemberActivityProgress(activity, assignment) }] : [];
        });

        const memberName = String(member.name || "Unnamed member");
        initial.textContent = Array.from(memberName.trim())[0]?.toLocaleUpperCase() || "?";
        name.textContent = memberName;
        committee.textContent = member.committee || "No committee";
        const followUpStatus = window.YLYData.getMemberFollowUpStatus(member, activities);
        status.textContent = followUpStatus;
        status.className = `status-badge ${statusClass(followUpStatus)}`;
        const date = parseDate(member.joinedDate);
        joinedDate.replaceChildren();
        if (date) {
          const time = createElement("time", "", formatDate(date));
          time.dateTime = member.joinedDate;
          joinedDate.append("Joined ", time);
        } else {
          joinedDate.textContent = "Joined date not set";
        }

        totalPending.textContent = assignments.filter((item) => item.progress.pending).length;
        eventsAttended.textContent = assignments.filter((item) => normalize(item.activity.type) === "event" && (item.progress.outcome || item.progress.status) === "attended").length;
        tasksDone.textContent = assignments.filter((item) => normalize(item.activity.type) === "task" && item.progress.completed).length;
        groups.forEach((group) => {
          const items = assignments.filter(group.matches);
          const fragment = document.createDocumentFragment();
          items.forEach((item) => fragment.append(renderActivity(item.activity, item.assignment, item.progress, window.YLYData.isMemberArchived(member))));
          if (!items.length) fragment.append(createElement("li", "profile-list-empty", group.empty));
          group.list.replaceChildren(fragment);
          group.count.textContent = items.length;
        });
        document.title = `${memberName} | YLY Follow-Up`;
        errorMessage.hidden = true;
        errorMessage.textContent = "";
        editButton.disabled = false;
        content.hidden = false;
        currentProfileMember = member;
        refreshInteraction();
      } catch (error) {
        showPageError("Member details could not be loaded. Check that browser storage is enabled and the saved members and activities contain valid data, then reload the page.");
      }
    }

    const dialog = document.getElementById("member-dialog");
    const form = document.getElementById("member-form");
    const nameInput = document.getElementById("member-name");
    const committeeInput = document.getElementById("member-committee");
    const statusInput = document.getElementById("member-status");
    const joinedDateInput = document.getElementById("member-joined-date");
    const formError = document.getElementById("member-form-error");

    const statusDialog = document.getElementById("status-dialog");
    const statusForm = document.getElementById("status-form");
    const activityStatusInput = document.getElementById("status-value");
    const submissionDateInput = document.getElementById("submission-date");
    const proofInput = document.getElementById("status-proof");
    const applicationProofInput = document.getElementById("status-application-proof");
    const attendanceProofInput = document.getElementById("status-attendance-proof");
    const appliedInput = document.getElementById("status-applied");
    const selectionInput = document.getElementById("status-selection");
    const finalStatusInput = document.getElementById("status-final");
    const reasonInput = document.getElementById("status-reason");
    const statusFormError = document.getElementById("status-form-error");
    const statusNotice = document.getElementById("status-notice");
    let statusSession = null;
    let initialMembership = "Up to date";

    function canonicalStatus(value) {
      const normalized = normalize(value).replace(/ /g, "_");
      if (normalized === "excuse") return "excused";
      if (normalized === "completed") return "done";
      return normalized;
    }

    function setStatusField(key, input, visible) {
      document.getElementById(`status-${key}-field`).hidden = !visible;
      input.disabled = !visible;
    }

    function updateStatusFields(resetHidden) {
      if (!statusSession) return;
      const type = statusSession.type;
      const isTask = type === "task";
      const isEvent = type === "event";
      const showSelection = isEvent && appliedInput.checked;
      const showFinal = showSelection && selectionInput.value === "selected";
      const showTaskProof = isTask && activityStatusInput.value === "done" && statusSession.proof.required;
      const showSubmissionDate = isTask && activityStatusInput.value === "done";
      const showApplicationProof = showSelection && statusSession.proof.required;
      const showAttendanceProof = showFinal && finalStatusInput.value === "attended" && statusSession.proof.required;

      if (resetHidden && isEvent) {
        if (!showSelection) selectionInput.value = "";
        if (!showFinal) finalStatusInput.value = "pending";
      }
      const showReason = !isEvent && activityStatusInput.value === "excused"
        || showFinal && finalStatusInput.value === "excused";
      if (resetHidden && !showReason) reasonInput.value = "";

      setStatusField("value", activityStatusInput, !isEvent);
      if (showSubmissionDate && submissionDateInput.disabled && !submissionDateInput.value) {
        submissionDateInput.value = new Date().toISOString().split("T")[0];
      }
      setStatusField("submission-date", submissionDateInput, showSubmissionDate);
      submissionDateInput.required = showSubmissionDate;
      submissionDateInput.setCustomValidity("");
      setStatusField("proof", proofInput, showTaskProof);
      setStatusField("application-proof", applicationProofInput, showApplicationProof);
      setStatusField("attendance-proof", attendanceProofInput, showAttendanceProof);
      setStatusField("applied", appliedInput, isEvent);
      setStatusField("selection", selectionInput, showSelection);
      setStatusField("final", finalStatusInput, showFinal);
      setStatusField("reason", reasonInput, showReason);
      reasonInput.required = showReason;
      reasonInput.setCustomValidity("");
    }

    function readStatusForm() {
      if (statusSession.type !== "event") {
        const payload = {
          status: activityStatusInput.value,
          excuseReason: activityStatusInput.value === "excused" ? reasonInput.value.trim() : "",
        };
        if (!proofInput.disabled) payload.proofReceived = proofInput.checked;
        if (statusSession.type === "task" && activityStatusInput.value === "done") payload.submissionDate = submissionDateInput.value;
        return payload;
      }
      const applied = appliedInput.checked;
      const selection = applied ? selectionInput.value : "";
      const finalStatus = selection === "selected" ? finalStatusInput.value : "";
      const payload = {
        applied,
        selection,
        finalStatus,
        excuseReason: finalStatus === "excused" ? reasonInput.value.trim() : "",
      };
      if (!applicationProofInput.disabled) payload.applicationProofReceived = applicationProofInput.checked;
      if (!attendanceProofInput.disabled) payload.attendanceProofReceived = attendanceProofInput.checked;
      return payload;
    }

    function eventFormDefaults(assignment, progress) {
      const hasWorkflow = ["applied", "selection", "finalStatus"].some((key) => Object.prototype.hasOwnProperty.call(assignment, key));
      if (hasWorkflow) {
        return { applied: progress.applied, selection: progress.selection || "", finalStatus: progress.finalStatus || "pending" };
      }

      // Old records may only contain a terminal status. Inferences here only
      // prefill controls: an unchanged Save passes {} and never stores them.
      const history = Array.isArray(assignment.history) ? assignment.history.map((step) => canonicalStatus(typeof step === "string" ? step : step && step.status)) : [];
      const current = canonicalStatus(assignment.status);
      const stages = history.concat(current);
      const selected = stages.some((step) => ["selected", "attended", "excused", "absent"].includes(step));
      const selection = current === "not_selected" ? "not_selected" : selected ? "selected" : stages.includes("not_selected") ? "not_selected" : "";
      return {
        applied: stages.some((step) => ["applied", "selected", "not_selected", "attended", "excused", "absent"].includes(step)),
        selection,
        finalStatus: ["attended", "excused", "absent"].includes(current) ? current : "pending",
      };
    }

    function openStatusDialog(activityId) {
      if (statusDialog.open || dialog.open) return;
      try {
        const member = window.YLYData.getMembers().find((record) => record && String(record.id) === memberId);
        if (!member) throw new Error("This member no longer exists. Return to Members to choose another member.");
        if (window.YLYData.isMemberArchived(member)) throw new Error("Restore this archived member before updating activity statuses.");
        const activity = window.YLYData.getActivities().find((record) => record && String(record.id) === activityId);
        if (!activity) throw new Error("This activity no longer exists. Reload the profile to see the latest activities.");
        if (window.YLYData.isActivityArchived(activity)) throw new Error("This activity is archived. Reload the profile to see active activities.");
        const assignment = window.YLYData.getActivityMemberStatuses(activity).find((record) => String(record.memberId) === memberId);
        if (!assignment) throw new Error("This activity is no longer assigned to this member. Reload the profile to see the latest activities.");
        const type = normalize(activity.type);
        if (!["task", "session", "event"].includes(type)) throw new Error("This activity must have a Task, Session, or Event type before its status can be updated.");
        const progress = window.YLYData.getMemberActivityProgress(activity, assignment);

        const proof = window.YLYData.getActivityProofSettings(activity);
        statusSession = { activityId, type, proof, snapshot: "", recordSnapshot: JSON.stringify(assignment), originalOutcome: progress.outcome };
        statusForm.reset();
        statusFormError.hidden = true;
        statusFormError.textContent = "";
        statusNotice.hidden = true;
        document.getElementById("status-dialog-title").textContent = `Update ${statusLabel(type)} Status`;
        document.getElementById("status-dialog-description").textContent = `${activity.name || "Untitled activity"} · ${name.textContent}. Current saved status: ${statusLabel(progress.status)}.`;
        const proofName = proof.type === "form_confirmation" ? "Form Confirmation" : "Screenshot";
        document.getElementById("status-proof-label").textContent = `${proofName} Received`;
        document.getElementById("status-application-proof-label").textContent = `Application ${proofName} Received`;
        document.getElementById("status-attendance-proof-label").textContent = `Attendance ${proofName} Received`;
        const matchingProofType = !assignment.proofType || assignment.proofType === proof.type;
        const receipts = [
          ["proof", proofInput, "proofReceived"],
          ["application-proof", applicationProofInput, "applicationProofReceived"],
          ["attendance-proof", attendanceProofInput, "attendanceProofReceived"],
        ];
        receipts.forEach(([key, input, field]) => {
          input.checked = matchingProofType && assignment[field] === true;
          const receipt = !matchingProofType ? "Saved proof does not match the current proof type."
            : assignment[field] === true ? "Saved proof: received."
              : assignment[field] === false ? "Saved proof: not received."
                : "Not recorded in this member's saved data. Changing this status records whether proof was received.";
          document.getElementById(`status-${key}-help`).textContent = receipt;
        });

        const choices = type === "task" ? [["pending", "Pending"], ["done", "Done"], ["excused", "Excuse"]]
          : [["pending", "Pending"], ["attended", "Attended"], ["excused", "Excuse"], ["absent", "Absent"]];
        activityStatusInput.replaceChildren(...choices.map(([value, label]) => {
          const option = createElement("option", "", label);
          option.value = value;
          return option;
        }));
        let currentStatus = canonicalStatus(assignment.status);
        if (type === "task" && currentStatus === "pending_proof") currentStatus = "done";
        activityStatusInput.value = choices.some(([value]) => value === currentStatus) ? currentStatus : "pending";
        submissionDateInput.value = type === "task" && currentStatus === "done" && parseDate(assignment.submissionDate) ? assignment.submissionDate : "";
        submissionDateInput.disabled = true;
        statusSession.needsSubmission = type === "task" && currentStatus === "done" && !parseDate(assignment.submissionDate);
        reasonInput.value = typeof assignment.excuseReason === "string" ? assignment.excuseReason
          : typeof assignment.reason === "string" ? assignment.reason : "";
        if (type === "event") {
          const defaults = eventFormDefaults(assignment, progress);
          appliedInput.checked = Boolean(defaults.applied);
          selectionInput.value = defaults.selection;
          finalStatusInput.value = ["pending", "attended", "excused", "absent"].includes(canonicalStatus(defaults.finalStatus))
            ? canonicalStatus(defaults.finalStatus) : "pending";
        }
        updateStatusFields(false);
        statusSession.snapshot = JSON.stringify(readStatusForm());
        statusDialog.showModal();
        (type === "event" ? appliedInput : activityStatusInput).focus();
      } catch (error) {
        statusSession = null;
        errorMessage.textContent = error.message || "The activity status could not be loaded. Check browser storage and try again.";
        errorMessage.hidden = false;
      }
    }

    content.addEventListener("click", (event) => {
      const row = event.target.closest("[data-status-activity-id]");
      if (!row || !content.contains(row)) return;
      // Native buttons supply Enter/Space keyboard behavior; pointer users can
      // click anywhere on the same row. Member editing has its own button only.
      openStatusDialog(row.dataset.statusActivityId);
    });

    statusForm.addEventListener("change", () => updateStatusFields(true));
    reasonInput.addEventListener("input", () => reasonInput.setCustomValidity(""));
    submissionDateInput.addEventListener("input", () => submissionDateInput.setCustomValidity(""));
    statusForm.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!statusSession) return;
      const payload = readStatusForm();
      const initialPayload = JSON.parse(statusSession.snapshot);
      let unchanged = JSON.stringify(payload) === statusSession.snapshot && !statusSession.needsSubmission;
      // An unchanged legacy excuse may predate the reason field. Preserve it.
      reasonInput.setCustomValidity(!unchanged && reasonInput.required && !reasonInput.value.trim() ? "Enter an excuse reason." : "");
      submissionDateInput.setCustomValidity(!submissionDateInput.disabled && !parseDate(submissionDateInput.value) ? "Choose a valid submission date." : "");
      if (!unchanged && !statusForm.checkValidity()) {
        statusForm.reportValidity();
        return;
      }
      statusFormError.hidden = true;
      try {
        const activity = window.YLYData.getActivities().find((record) => record && String(record.id) === statusSession.activityId);
        if (!activity) throw new Error("This activity was removed. Close this dialog and reload the profile.");
        if (window.YLYData.isActivityArchived(activity)) throw new Error("This activity was archived. Close this dialog and reload the profile.");
        if (normalize(activity.type) !== statusSession.type) throw new Error("This activity's type changed. Close and reopen its status dialog before saving.");
        const latestProof = window.YLYData.getActivityProofSettings(activity);
        if (latestProof.required !== statusSession.proof.required || latestProof.type !== statusSession.proof.type) {
          throw new Error("This activity's proof requirement changed. Close and reopen its status dialog before saving.");
        }
        const assignment = window.YLYData.getActivityMemberStatuses(activity).find((record) => String(record.memberId) === memberId);
        if (!assignment) {
          throw new Error("This member is no longer assigned to the activity. Close this dialog and reload the profile.");
        }
        if (statusSession.type === "task" && JSON.stringify(assignment) !== statusSession.recordSnapshot) {
          throw new Error("This member's task status changed. Close and reopen the status dialog before saving.");
        }
        if (statusSession.type === "task" && payload.status === "done") {
          const deadline = window.YLYData.getActivityDeadline(activity);
          if (!parseDate(deadline)) throw new Error("Set a valid Deadline on this task before recording a submission.");
          payload.isLate = payload.submissionDate > deadline;
          if (assignment.isLate !== payload.isLate) unchanged = false;
          // A date correction must not turn an unknown receipt into missing proof.
          if (statusSession.originalOutcome === "done" && initialPayload.proofReceived === payload.proofReceived) delete payload.proofReceived;
        }
        const member = window.YLYData.getMembers().find((record) => record && String(record.id) === memberId);
        if (!member) {
          throw new Error("This member no longer exists. Close this dialog and return to Members.");
        }
        if (window.YLYData.isMemberArchived(member)) throw new Error("This member was archived. Restore the member before updating activity statuses.");
        window.YLYData.updateMemberActivityStatus(statusSession.activityId, memberId, unchanged ? {} : payload);
        statusDialog.close();
        refreshProfile();
        statusNotice.textContent = unchanged ? "Status is unchanged." : "Member activity status updated.";
        statusNotice.hidden = false;
      } catch (error) {
        statusFormError.textContent = error.message || "The status could not be saved. Check browser storage and try again.";
        statusFormError.hidden = false;
      }
    });

    ["status-cancel-button", "status-close-button"].forEach((id) => {
      document.getElementById(id).addEventListener("click", () => statusDialog.close());
    });
    statusDialog.addEventListener("close", () => {
      if (statusSession) {
        const row = Array.from(content.querySelectorAll("[data-status-activity-id]")).find((item) => item.dataset.statusActivityId === statusSession.activityId);
        const button = row && row.querySelector(".profile-update-button");
        if (button) button.focus();
      }
      statusSession = null;
    });

    function openMemberDialog() {
      if (dialog.open || statusDialog.open) return;
      try {
        const member = window.YLYData.getMembers().find((record) => record && String(record.id) === memberId);
        if (!member) {
          refreshProfile();
          return;
        }
        form.reset();
        formError.hidden = true;
        [nameInput, committeeInput, joinedDateInput].forEach((input) => input.setCustomValidity(""));
        nameInput.value = member.name || "";
        committeeInput.value = member.committee || "";
        statusInput.value = window.YLYData.isMemberArchived(member) ? "Archived" : "Up to date";
        initialMembership = statusInput.value;
        joinedDateInput.value = member.joinedDate || "";
        dialog.showModal();
        nameInput.focus();
      } catch (error) {
        showPageError("This member could not be loaded for editing. Check browser storage and the saved members data, then reload the page.");
      }
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      nameInput.setCustomValidity(nameInput.value.trim() ? "" : "Enter a member name.");
      committeeInput.setCustomValidity(committeeInput.value.trim() ? "" : "Enter a committee.");
      joinedDateInput.setCustomValidity(parseDate(joinedDateInput.value) ? "" : "Choose a valid joined date.");
      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }
      formError.hidden = true;
      try {
        // Merge into the latest record to preserve IDs, extra fields, and other members.
        const latestMembers = window.YLYData.getMembers();
        const index = latestMembers.findIndex((member) => member && String(member.id) === memberId);
        if (index === -1) {
          formError.textContent = "This member no longer exists. Close this dialog and return to Members.";
          formError.hidden = false;
          refreshProfile();
          return;
        }
        const updatedMembers = latestMembers.slice();
        updatedMembers[index] = {
          ...latestMembers[index],
          name: nameInput.value.trim(),
          committee: committeeInput.value.trim(),
          status: statusInput.value === initialMembership ? latestMembers[index].status : statusInput.value,
          joinedDate: joinedDateInput.value,
        };
        window.YLYData.saveMembers(updatedMembers);
        dialog.close();
        refreshProfile();
      } catch (error) {
        formError.textContent = "The member could not be saved. Check browser storage and the saved members data, then try again.";
        formError.hidden = false;
      }
    });

    [nameInput, committeeInput, joinedDateInput].forEach((input) => {
      input.addEventListener("input", () => input.setCustomValidity(""));
    });
    editButton.addEventListener("click", openMemberDialog);
    document.getElementById("member-cancel-button").addEventListener("click", () => dialog.close());
    document.getElementById("member-close-button").addEventListener("click", () => dialog.close());
    window.addEventListener("storage", (event) => {
      if (event.key === null || event.key === "members" || event.key === "activities") refreshProfile();
      else if (interactionKeys.includes(event.key)) refreshInteraction();
    });
    window.addEventListener("yly:interaction-changed", refreshInteraction);
    window.addEventListener("yly:data-changed", refreshProfile);
    refreshProfile();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeMemberDetails, { once: true });
  } else {
    initializeMemberDetails();
  }
})();
