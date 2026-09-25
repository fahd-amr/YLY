var exportData = [];

(function () {
  "use strict";

  function normalize(value) {
    return String(value || "").trim().toLocaleLowerCase()
      .replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  }

  function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[character]);
  }

  // Parse calendar dates locally so both range boundaries are inclusive.
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

  function dateLabel(date) {
    return date.toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" });
  }

  function validMonth(value) {
    return typeof value === "string" && /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(value);
  }

  function monthLabel(month) {
    return parseDate(`${month}-01`).toLocaleDateString("en", { month: "long", year: "numeric" });
  }

  function getSource(activity) {
    const source = typeof activity.source === "string" ? activity.source.trim() : "";
    const committee = typeof activity.committee === "string" ? activity.committee.trim() : "";
    return normalize(source || committee || "General");
  }

  function getRecordedStatuses(assignment) {
    // History is stored in timeline order, as on the Member Details page.
    const steps = Array.isArray(assignment.history) ? assignment.history.map((step) => {
      return normalize(typeof step === "string" ? step : step && step.status);
    }).filter(Boolean) : [];
    const current = normalize(assignment.status);
    if (current && steps[steps.length - 1] !== current) steps.push(current);
    return steps;
  }

  function wasExcusedAfterSelection(steps) {
    let selected = false;
    return steps.some((status) => {
      if (status === "excused after selection" || status === "excuse after selection") return true;
      if (status === "selected") selected = true;
      return selected && (status === "excused" || status === "excuse");
    });
  }

  function summarizeMember(member, activities) {
    const stats = {
      sessions: { attended: 0, excuses: 0, absent: 0 },
      events: { applied: 0, selected: 0, notSelected: 0, attended: 0, excusesAfterSelection: 0 },
      tasks: { done: 0, doneOnTime: 0, doneLate: 0, pending: 0 },
      general: { completed: 0 },
      sm: { completed: 0 },
    };

    activities.forEach((activity) => {
      if (member.id === null || member.id === undefined) return;
      // Count at most one assignment for this member in each activity.
      const assignment = window.YLYData.getActivityMemberStatuses(activity).find((target) => target
        && target.memberId !== null && target.memberId !== undefined
        && String(target.memberId) === String(member.id));
      if (!assignment) return;

      const type = normalize(activity.type);
      const progress = window.YLYData.getMemberActivityProgress(activity, assignment);
      const status = normalize(progress.outcome || progress.status);
      if (type === "session") {
        if (status === "attended") stats.sessions.attended += 1;
        if (status === "excused" || status === "excuse") stats.sessions.excuses += 1;
        if (status === "absent") stats.sessions.absent += 1;
      } else if (type === "event") {
        if (typeof assignment.applied === "boolean") {
          // Current workflow fields take precedence over past decisions in history.
          if (progress.applied) stats.events.applied += 1;
          if (progress.applied && progress.selection === "selected") stats.events.selected += 1;
          if (progress.applied && progress.selection === "not_selected") stats.events.notSelected += 1;
          if (status === "attended") stats.events.attended += 1;
          if (progress.applied && progress.selection === "selected" && status === "excused") {
            stats.events.excusesAfterSelection += 1;
          }
        } else {
          // Preserve the meaning of legacy records that only contain status/history.
          const steps = getRecordedStatuses(assignment);
          const recorded = new Set(steps);
          if (recorded.has("applied")) stats.events.applied += 1;
          if (recorded.has("selected")) stats.events.selected += 1;
          if (recorded.has("not selected")) stats.events.notSelected += 1;
          if (recorded.has("attended")) stats.events.attended += 1;
          if (wasExcusedAfterSelection(steps)) stats.events.excusesAfterSelection += 1;
        }
      } else if (type === "task") {
        // Lateness describes a submitted task, independently of required proof.
        // Only a real boolean flag on a Done record counts; pending/excused
        // records and legacy manual timeliness values do not imply a late task.
        const submittedLate = status === "done" && assignment.isLate === true;
        if (submittedLate) stats.tasks.doneLate += 1;
        if (progress.completed) {
          stats.tasks.done += 1;
          if (!submittedLate) stats.tasks.doneOnTime += 1;
        }
        if (progress.pending) stats.tasks.pending += 1;
      }

      // Source totals overlap the type totals and use the current status only.
      if (progress.completed) {
        const source = getSource(activity);
        if (source === "general") stats.general.completed += 1;
        if (source === "sm") stats.sm.completed += 1;
      }
    });

    return stats;
  }

  function renderCategory(index, key, title, metrics, sourceCategory) {
    const titleId = `summary-${index}-${key}`;
    const layoutClass = metrics.length === 1 ? " summary-stats--one"
      : metrics.length === 2 ? " summary-stats--two" : "";
    return `
      <section class="summary-category${sourceCategory ? " summary-category--source" : ""}" aria-labelledby="${titleId}">
        <h3 id="${titleId}" class="summary-category-title">${escapeHTML(title)}</h3>
        <dl class="summary-stats${layoutClass}">
          ${metrics.map(([label, value]) => `
            <div class="summary-stat">
              <dt class="summary-stat-label">${escapeHTML(label)}</dt>
              <dd class="summary-stat-value">${value}</dd>
            </div>`).join("")}
        </dl>
      </section>`;
  }

  function renderMemberCard(member, stats, index, interactionEvaluation, interactionMonth, interactionAvailable) {
    const memberName = escapeHTML(member.name || "Unnamed member");
    const committee = escapeHTML(member.committee || "No committee");
    const profileURL = escapeHTML(`member-details.html?id=${encodeURIComponent(String(member.id ?? ""))}`);
    const categories = [
      renderCategory(index, "sessions", "Sessions", [
        ["Attended", stats.sessions.attended], ["Excuses", stats.sessions.excuses], ["Absent", stats.sessions.absent],
      ]),
      renderCategory(index, "events", "Events", [
        ["Applied", stats.events.applied], ["Selected", stats.events.selected],
        ["Not Selected", stats.events.notSelected], ["Attended", stats.events.attended],
        ["Excuses After Selection", stats.events.excusesAfterSelection],
      ]),
      renderCategory(index, "tasks", "Tasks", [
        ["Done", stats.tasks.done], ["Pending", stats.tasks.pending],
        ["On Time", stats.tasks.doneOnTime], ["Late Tasks", stats.tasks.doneLate],
      ]),
      renderCategory(index, "general", "General Activities", [["Completed", stats.general.completed]], true),
      renderCategory(index, "sm", "SM Activities", [["Completed", stats.sm.completed]], true),
      renderCategory(index, "interaction", "Interaction", [[
        validMonth(interactionMonth) ? monthLabel(interactionMonth) : "Evaluation month",
        interactionAvailable ? (interactionEvaluation ? `${interactionEvaluation.finalScore}/10` : "Pending") : "Unavailable",
      ]], true),
    ];

    return `
      <article class="summary-card" aria-labelledby="summary-member-${index}">
        <header class="summary-card-header">
          <h2 id="summary-member-${index}" class="summary-member-name"><a class="member-profile-link" href="${profileURL}">${memberName}</a></h2>
          <span class="status-badge committee-badge">${committee}</span>
        </header>
        <div class="summary-categories">${categories.join("")}</div>
      </article>`;
  }

  function initializeMonthlySummary() {
    const startInput = document.getElementById("summary-start");
    const endInput = document.getElementById("summary-end");
    const interactionMonthInput = document.getElementById("summary-interaction-month");
    const interactionError = document.getElementById("summary-interaction-error");
    const generateButton = document.getElementById("generate-summary-btn");
    const container = document.getElementById("summary-container");
    const errorMessage = document.getElementById("summary-error");
    const summaryStatus = document.getElementById("summary-status");
    const exportButton = document.getElementById("export-excel-btn");
    if (!startInput || !endInput || !interactionMonthInput || !interactionError || !generateButton || !container || !errorMessage || !summaryStatus || !exportButton) return;
    interactionMonthInput.value = parseDate(endInput.value) ? endInput.value.slice(0, 7) : window.YLYInteraction.currentMonth();
    let rendering = false;

    function renderMonthlySummary() {
      // Initializing missing Interaction keys can notify this page synchronously.
      if (rendering) return false;
      rendering = true;
      try { return renderSummaryContents(); }
      finally { rendering = false; }
    }

    function renderSummaryContents() {
      exportData.length = 0;
      exportButton.disabled = true;
      interactionError.hidden = true;
      interactionError.textContent = "";
      const startDate = parseDate(startInput.value);
      const endDate = parseDate(endInput.value);
      if (!startDate || !endDate || startDate > endDate) {
        container.innerHTML = "";
        summaryStatus.textContent = "Choose a valid date range.";
        errorMessage.textContent = !startDate || !endDate
          ? "Enter a valid start date and end date."
          : "The end date must be on or after the start date.";
        errorMessage.hidden = false;
        return false;
      }
      try {
        const members = window.YLYData.getMembers().filter((member) => member && typeof member === "object" && !Array.isArray(member) && !window.YLYData.isMemberArchived(member));
        // Historical reports include archived activities from previous cycles.
        const activities = window.YLYData.getActivities();
        const rangeActivities = [];
        let excludedCount = 0;
        activities.forEach((activity) => {
          const date = activity && typeof activity === "object" && !Array.isArray(activity)
            ? parseDate(activity.date) : null;
          if (!date) excludedCount += 1;
          else if (date >= startDate && date <= endDate) rangeActivities.push(activity);
        });
        const interactionMonth = interactionMonthInput.value;
        let interactionState = null;
        try {
          if (!validMonth(interactionMonth)) throw new Error("Choose a valid Interaction evaluation month.");
          interactionState = window.YLYInteraction.read();
        } catch (error) {
          interactionError.textContent = validMonth(interactionMonth)
            ? "Interaction scores could not be loaded. Activity summaries remain available, but Excel export is disabled until the saved Interaction data is valid."
            : "Choose a valid Interaction evaluation month to include scores and enable Excel export.";
          interactionError.hidden = false;
        }
        container.innerHTML = members.length
          ? members.map((member, index) => {
            const stats = summarizeMember(member, rangeActivities);
            const evaluationKey = `${interactionMonth}_${member.id}`;
            const evaluation = interactionState && Object.prototype.hasOwnProperty.call(interactionState.finalEvaluations, evaluationKey)
              ? interactionState.finalEvaluations[evaluationKey] : null;
            if (interactionState) exportData.push({
              "Name": String(member.name || "Unnamed member"),
              "Technical Evaluation /50": "",
              "Field Visits Entered": stats.events.attended,
              "Meetings Entered": stats.sessions.attended,
              "Interaction /10": evaluation ? evaluation.finalScore : "",
              "Respect Hierarchy /10": "",
              "Bonus /10": "",
              "Tasks Done Late": stats.tasks.doneLate,
            });
            return renderMemberCard(member, stats, index, evaluation, interactionMonth, Boolean(interactionState));
          }).join("")
          : `<p class="summary-empty">${escapeHTML("No members yet. Add a member to see their monthly summary.")}</p>`;
        summaryStatus.textContent = members.length
          ? `${members.length} ${members.length === 1 ? "member" : "members"} · ${rangeActivities.length} ${rangeActivities.length === 1 ? "activity" : "activities"} from ${dateLabel(startDate)} to ${dateLabel(endDate)} (inclusive)`
          : "No members to summarize.";
        if (excludedCount) {
          summaryStatus.textContent += ` · ${excludedCount} ${excludedCount === 1 ? "activity excluded because its date is missing or invalid" : "activities excluded because their dates are missing or invalid"}.`;
        }
        if (validMonth(interactionMonth)) summaryStatus.textContent += ` · Interaction evaluations: ${monthLabel(interactionMonth)}.`;
        errorMessage.hidden = true;
        errorMessage.textContent = "";
        exportButton.disabled = exportData.length === 0;
        return Boolean(interactionState);
      } catch (error) {
        exportData.length = 0;
        container.innerHTML = "";
        summaryStatus.textContent = "Monthly summary unavailable";
        errorMessage.textContent = "The monthly summary could not be loaded. Check that browser storage is enabled and the saved members and activities contain valid data, then reload the page.";
        errorMessage.hidden = false;
        return false;
      }
    }

    exportButton.addEventListener("click", () => {
      // Re-read storage before exporting, even if another tab just changed it.
      if (!renderMonthlySummary()) return;
      if (!exportData.length) {
        errorMessage.textContent = "There are no active members to export.";
        errorMessage.hidden = false;
        return;
      }
      const XLSX = window.XLSX;
      if (!XLSX) {
        errorMessage.textContent = "Excel export could not load. Check your internet connection and reload this page.";
        errorMessage.hidden = false;
        return;
      }
      try {
        const ws = XLSX.utils.json_to_sheet(exportData);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Monthly Summary");
        XLSX.writeFile(wb, "YLY_Monthly_Summary.xlsx");
      } catch (error) {
        errorMessage.textContent = "The Excel file could not be exported. Please try again.";
        errorMessage.hidden = false;
      }
    });

    generateButton.addEventListener("click", renderMonthlySummary);
    function invalidateSummary() {
      exportData.length = 0;
      exportButton.disabled = true;
      container.innerHTML = "";
      summaryStatus.textContent = "Select Generate Summary to apply this date range and Interaction evaluation month.";
      errorMessage.hidden = true;
      interactionError.hidden = true;
    }
    [startInput, endInput].forEach((input) => {
      input.addEventListener("input", () => {
        interactionMonthInput.value = parseDate(endInput.value) ? endInput.value.slice(0, 7) : "";
        invalidateSummary();
      });
    });
    interactionMonthInput.addEventListener("input", invalidateSummary);
    interactionMonthInput.addEventListener("change", invalidateSummary);
    window.addEventListener("storage", (event) => {
      if (event.key === null || ["members", "activities", "interactionSettings", "checkpoints", "checkpointInteractions", "hrEvaluations", "finalEvaluations"].includes(event.key)) renderMonthlySummary();
    });
    window.addEventListener("yly:data-changed", renderMonthlySummary);
    window.addEventListener("yly:interaction-changed", renderMonthlySummary);
    renderMonthlySummary();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeMonthlySummary, { once: true });
  } else {
    initializeMonthlySummary();
  }
})();
