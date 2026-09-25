(function () {
  "use strict";

  const dateFormatter = new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function parseDeadline(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return null;
    }

    const [year, month, day] = value.split("-").map(Number);
    // Construct a local calendar date; parsing an ISO string would use UTC.
    const date = new Date(0);
    date.setFullYear(year, month - 1, day);
    date.setHours(0, 0, 0, 0);

    return date.getFullYear() === year &&
      date.getMonth() === month - 1 &&
      date.getDate() === day
      ? date
      : null;
  }

  function createListItem(title, meta, description) {
    const item = createElement("li", "dashboard-list-item");
    const content = createElement("div", "list-item-content");
    content.append(
      createElement("p", "list-item-title", title),
      createElement("p", "list-item-meta", meta)
    );
    if (description) {
      content.append(createElement("p", "list-item-description", description));
    }
    item.append(content);
    return item;
  }

  function initializeBackupControls() {
    const backupButton = document.getElementById("backup-data-btn");
    const restoreButton = document.getElementById("restore-data-btn");
    const fileInput = document.getElementById("restore-file");
    const status = document.getElementById("backup-status");
    const errorMessage = document.getElementById("backup-error");
    const startCycleButton = document.getElementById("start-cycle-btn");
    if (!backupButton || !restoreButton || !fileInput || !status || !errorMessage) return;
    let busy = false;

    function setBusy(value) {
      busy = value;
      backupButton.disabled = value;
      restoreButton.disabled = value;
      fileInput.disabled = value;
      if (startCycleButton) startCycleButton.disabled = value;
    }

    function clearMessages() {
      status.textContent = "";
      errorMessage.textContent = "";
      errorMessage.hidden = true;
    }

    function showError(message, error) {
      status.textContent = "";
      errorMessage.textContent = `${message} ${error.message || "Please try again."}`;
      errorMessage.hidden = false;
    }

    backupButton.addEventListener("click", () => {
      if (busy) return;
      clearMessages();
      setBusy(true);
      let downloadURL;
      let link;
      try {
        const backup = window.YLYData.getBackupData();
        const blob = new window.Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
        downloadURL = window.URL.createObjectURL(blob);
        link = document.createElement("a");
        link.href = downloadURL;
        link.download = "YLY_Backup.json";
        document.body.append(link);
        link.click();
        status.textContent = "Backup download started.";
      } catch (error) {
        showError("The backup could not be downloaded.", error);
      } finally {
        if (link) link.remove();
        if (downloadURL) {
          // Give the browser time to start reading the download before cleanup.
          window.setTimeout(() => window.URL.revokeObjectURL(downloadURL), 1000);
        }
        setBusy(false);
      }
    });

    restoreButton.addEventListener("click", () => {
      if (busy) return;
      clearMessages();
      fileInput.value = "";
      try {
        fileInput.click();
      } catch (error) {
        showError("The backup file picker could not be opened.", error);
      }
    });

    function readFile(file) {
      if (typeof file.text === "function") return file.text();
      return new Promise((resolve, reject) => {
        const reader = new window.FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error("The selected file could not be read."));
        reader.onabort = () => reject(new Error("Reading the selected file was cancelled."));
        reader.readAsText(file);
      });
    }

    fileInput.addEventListener("change", async () => {
      if (busy) return;
      const file = fileInput.files && fileInput.files[0];
      if (!file) { fileInput.value = ""; return; }
      clearMessages();
      setBusy(true);
      status.textContent = "Reading backup…";
      let restored = false;
      try {
        const contents = await readFile(file);
        let backup;
        try {
          backup = JSON.parse(String(contents).replace(/^\uFEFF/, ""));
        } catch (error) {
          throw new Error("The selected file does not contain valid JSON.");
        }
        window.YLYData.restoreBackupData(backup);
        restored = true;
        status.textContent = "Backup restored. Reloading…";
      } catch (error) {
        showError("The backup could not be restored.", error);
      } finally {
        fileInput.value = "";
        setBusy(false);
      }
      if (restored) {
        try {
          window.location.reload();
        } catch (error) {
          status.textContent = "Backup restored. Reload the page to continue.";
        }
      }
    });
  }

  function initializeCycleControls() {
    const button = document.getElementById("start-cycle-btn");
    const errorMessage = document.getElementById("dashboard-error");
    if (!button || !errorMessage) return;

    button.addEventListener("click", () => {
      // A restore may still be reading its file. Do not archive stale data
      // that would immediately be replaced when that operation finishes.
      if (button.disabled) return;
      button.disabled = true;
      let saved = false;
      try {
        if (!window.confirm("Start a new cycle? This will archive all active items to clear the board, but keep past data saved in history.")) return;
        errorMessage.hidden = true;
        // Read on confirmation so activities added in another tab are included.
        const currentActivities = window.YLYData.getActivities();
        if (currentActivities.some((activity) => !activity || typeof activity !== "object" || Array.isArray(activity))) {
          throw new Error("Saved activities contain an invalid entry. Repair it or restore a valid backup before starting a new cycle.");
        }
        const activities = currentActivities.map((activity) => ({
          ...activity,
          archived: true,
        }));
        window.YLYData.saveActivities(activities);
        saved = true;
        window.location.reload();
      } catch (error) {
        errorMessage.textContent = saved
          ? "The new cycle was started and past activity data was saved. Reload this page to continue."
          : `The new cycle could not be started. ${error.message || "Check browser storage and try again."}`;
        errorMessage.hidden = false;
      } finally {
        button.disabled = false;
      }
    });
  }

  function initializeInteractionReviews() {
    const completed = document.getElementById("interaction-completed-count");
    const pending = document.getElementById("interaction-pending-count");
    const monthLabel = document.getElementById("interaction-review-month");
    const list = document.getElementById("interaction-follow-up-list");
    const errorMessage = document.getElementById("dashboard-interaction-error");
    if (!completed || !pending || !monthLabel || !list || !errorMessage) return;
    let rendering = false;

    function renderInteractionReviews() {
      // read() may initialize a missing storage key and synchronously notify
      // listeners. The active render already includes that initialized data.
      if (rendering) return;
      rendering = true;
      list.replaceChildren();
      errorMessage.hidden = true;
      try {
        const api = window.YLYInteraction;
        if (!api) throw new Error("The interaction data module could not be loaded.");
        const month = api.currentMonth();
        const [year, monthNumber] = month.split("-").map(Number);
        const date = new Date(0);
        date.setFullYear(year, monthNumber - 1, 1);
        monthLabel.textContent = new Intl.DateTimeFormat("en", { month: "long", year: "numeric" }).format(date);
        const state = api.read();
        const members = window.YLYData.getMembers().filter((member) => !window.YLYData.isMemberArchived(member));
        let completedCount = 0;
        members.forEach((member) => {
          const key = `${month}_${member.id}`;
          // A final score of zero is still a completed evaluation. Review
          // warnings about checkpoints do not make a saved final score pending.
          if (Object.prototype.hasOwnProperty.call(state.finalEvaluations, key)) {
            completedCount += 1;
            return;
          }
          const item = createElement("li", "dashboard-list-item");
          const content = createElement("div", "list-item-content");
          const title = createElement("p", "list-item-title");
          const link = createElement("a", "member-name-link", member.name);
          link.href = `interaction.html?month=${encodeURIComponent(month)}&member=${encodeURIComponent(member.id)}`;
          title.append(link);
          content.append(
            title,
            createElement("p", "list-item-meta", member.committee),
            createElement("p", "list-item-description", "Interaction Evaluation Pending")
          );
          item.append(content);
          list.append(item);
        });
        completed.textContent = completedCount;
        pending.textContent = members.length - completedCount;
        if (!list.children.length) {
          list.append(createElement("li", "list-empty", members.length
            ? "All active members have a final interaction score for this month."
            : "No active members to evaluate."));
        }
      } catch (error) {
        completed.textContent = "\u2014";
        pending.textContent = "\u2014";
        list.replaceChildren();
        errorMessage.textContent = `Interaction reviews could not be loaded. ${error.message || "Check browser storage and reload the page."}`;
        errorMessage.hidden = false;
      } finally {
        rendering = false;
      }
    }

    renderInteractionReviews();
    const keys = ["members", "interactionSettings", "checkpoints", "checkpointInteractions", "hrEvaluations", "finalEvaluations"];
    window.addEventListener("storage", (event) => {
      if (event.key === null || keys.includes(event.key)) renderInteractionReviews();
    });
    window.addEventListener("yly:interaction-changed", renderInteractionReviews);
    window.addEventListener("yly:data-changed", renderInteractionReviews);
    // Refresh the month when returning to a dashboard left open overnight.
    window.addEventListener("focus", renderInteractionReviews);
  }

  function initializeDashboard() {
    initializeBackupControls();
    initializeCycleControls();
    initializeInteractionReviews();
    const totalMembers = document.getElementById("total-members");
    const totalPending = document.getElementById("total-pending-items");
    const upcomingCount = document.getElementById("upcoming-deadlines-count");
    const followUpList = document.getElementById("follow-up-list");
    const deadlineList = document.getElementById("upcoming-deadlines-list");
    const errorMessage = document.getElementById("dashboard-error");

    if (!totalMembers || !totalPending || !upcomingCount ||
        !followUpList || !deadlineList || !errorMessage) return;

    function renderDashboard() {
      followUpList.replaceChildren();
      deadlineList.replaceChildren();
      errorMessage.hidden = true;

      try {
        const members = window.YLYData.getMembers().filter((member) => !window.YLYData.isMemberArchived(member));
        const activities = window.YLYData.getActivities().filter((activity) => !window.YLYData.isActivityArchived(activity));
        const pendingByMember = new Map(
          members.map((member) => [String(member.id), []])
        );
        let pendingCount = 0;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const upcoming = [];

        activities.forEach((activity) => {
          window.YLYData.getActivityMemberStatuses(activity).forEach((assignment) => {
            const pending = pendingByMember.get(String(assignment.memberId));
            if (pending && window.YLYData.getMemberActivityProgress(activity, assignment).pending) {
              pending.push(activity);
              pendingCount += 1;
            }
          });

          const deadline = parseDeadline(activity.deadline);
          if (deadline && deadline > today) {
            upcoming.push({ activity, deadline });
          }
        });

        totalMembers.textContent = members.length;
        totalPending.textContent = pendingCount;
        upcomingCount.textContent = upcoming.length;

        members.forEach((member) => {
          const pending = pendingByMember.get(String(member.id));
          if (!pending.length) return;

          const description = pending
            .map((activity) => `${activity.type}: ${activity.name}`)
            .join(" · ");
          const item = createListItem(member.name, member.committee, description);
          item.append(createElement(
            "span",
            "status-badge status-pending",
            `${pending.length} pending`
          ));
          followUpList.append(item);
        });

        upcoming.sort((first, second) => first.deadline - second.deadline);
        upcoming.forEach(({ activity, deadline }) => {
          const item = createListItem(activity.name, activity.type);
          const time = createElement("time", "deadline-date", dateFormatter.format(deadline));
          time.dateTime = activity.deadline;
          item.append(time);
          deadlineList.append(item);
        });

        if (!followUpList.children.length) {
          followUpList.append(createElement("li", "list-empty", "All caught up! No pending items."));
        }
        if (!deadlineList.children.length) {
          deadlineList.append(createElement("li", "list-empty", "No upcoming deadlines."));
        }
      } catch (error) {
        totalMembers.textContent = "—";
        totalPending.textContent = "—";
        upcomingCount.textContent = "—";
        followUpList.replaceChildren();
        deadlineList.replaceChildren();
        errorMessage.textContent = "Dashboard data could not be loaded. Check that browser storage is enabled and the saved members and activities contain valid data, then reload the page.";
        errorMessage.hidden = false;
      }
    }

    renderDashboard();
    // Keep an open dashboard in sync with changes made in another tab.
    window.addEventListener("storage", (event) => {
      if (event.key === null || event.key === "members" || event.key === "activities") {
        renderDashboard();
      }
    });
    window.addEventListener("yly:data-changed", renderDashboard);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeDashboard, { once: true });
  } else {
    initializeDashboard();
  }
})();
