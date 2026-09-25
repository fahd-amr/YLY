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

  function localToday() {
    const date = new Date();
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    ].join("-");
  }

  // Parse calendar dates locally so UTC conversion cannot shift the displayed day.
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

  function getSource(activity) {
    const source = typeof activity.source === "string" ? activity.source.trim() : "";
    const committee = typeof activity.committee === "string" ? activity.committee.trim() : "";
    return source || committee || "General";
  }

  function getAssignments(activity) {
    return window.YLYData.getActivityMemberStatuses(activity);
  }

  function getStatus(activity) {
    if (window.YLYData.isActivityArchived(activity)) return "Archived";
    const assignments = getAssignments(activity);
    if (!assignments.length) return "Pending Selection";
    const progress = assignments.map((assignment) => window.YLYData.getMemberActivityProgress(activity, assignment));
    if (progress.some((item) => normalize(item.status) === "pending proof")) return "Pending Proof";
    if (progress.some((item) => item.pending)) return "Pending";
    const date = parseDate(activity.date);
    if (date && date > parseDate(localToday())) return "Upcoming";
    return "Active";
  }

  function getStatusClass(status) {
    const value = normalize(status);
    if (value.startsWith("pending") || value === "needs follow up") return "badge-warning";
    if (value === "upcoming") return "badge-upcoming";
    if (["active", "done", "completed", "up to date"].includes(value)) return "badge-success";
    return "badge-neutral";
  }

  function initializeActivities() {
    const search = document.getElementById("activity-search");
    const list = document.getElementById("activities-list");
    const count = document.getElementById("activity-count");
    const errorMessage = document.getElementById("activities-error");
    const filters = document.querySelectorAll(".filter-pill[data-filter]");
    const addButton = document.getElementById("add-activity-button");
    const dialog = document.getElementById("activity-dialog");
    const form = document.getElementById("activity-form");
    const formError = document.getElementById("activity-form-error");
    const nameInput = document.getElementById("activity-name");
    const typeInput = document.getElementById("activity-type");
    const sourceInput = document.getElementById("activity-source");
    const dateInput = document.getElementById("activity-date");
    const deadlineInput = document.getElementById("activity-deadline");
    const proofRequiredInput = document.getElementById("activity-proof-required");
    const proofNotRequiredInput = document.getElementById("activity-proof-not-required");
    const proofTypeInput = document.getElementById("activity-proof-type");
    const proofTypeField = document.getElementById("activity-proof-type-field");
    const targetMembers = document.getElementById("activity-target-members");
    const saveButton = document.getElementById("activity-save-button");
    const cancelButton = document.getElementById("activity-cancel-button");
    const closeButton = document.getElementById("activity-close-button");
    const dialogTitle = document.getElementById("activity-dialog-title");
    const metadataFieldset = document.getElementById("activity-metadata-fieldset");
    const deleteDialog = document.getElementById("activity-delete-dialog");
    const deleteTitle = document.getElementById("activity-delete-title");
    const deleteMessage = document.getElementById("activity-delete-message");
    const deleteError = document.getElementById("activity-delete-error");
    const deleteConfirm = document.getElementById("activity-delete-confirm");
    const deleteArchive = document.getElementById("activity-delete-archive");
    const deleteCancel = document.getElementById("activity-delete-cancel");
    const deleteClose = document.getElementById("activity-delete-close");

    if (!search || !list || !count || !errorMessage || !dialog) return;

    let activities = [];
    let activeFilter = "All";
    let loadFailed = false;
    let dialogMode = "add";
    let editingActivityId = null;
    let deletingActivityId = null;
    let deleteRequiresForce = false;

    function renderActivities(data) {
      const cards = document.createDocumentFragment();
      const typeClasses = new Map([
        ["session", "badge-session"],
        ["event", "badge-event"],
        ["task", "badge-task"],
      ]);

      data.forEach((activity) => {
        const type = String(activity.type || "Activity").trim();
        const typeKey = normalize(type);
        const status = getStatus(activity);
        const card = createElement("article", "activity-card");
        const main = createElement("div", "activity-main");
        const copy = createElement("div", "activity-copy");
        const meta = createElement("div", "activity-meta");
        const dateLabel = createElement("p", "activity-date");
        const isTask = typeKey === "task";
        const primaryDateField = isTask ? "deadline" : "date";
        const fallbackDateField = isTask ? "date" : "deadline";
        const dateField = parseDate(activity[primaryDateField]) ? primaryDateField : fallbackDateField;
        const dateValue = activity[dateField];
        const date = parseDate(dateValue);

        copy.append(
          createElement("h2", "activity-name", activity.name || "Untitled activity"),
          createElement("p", "activity-source", `${getSource(activity)} ${type}`)
        );
        main.append(createElement("span", `status-badge ${typeClasses.get(typeKey) || "badge-neutral"}`, type), copy);

        if (date) {
          const time = createElement("time", "", date.toLocaleDateString(undefined, {
            year: "numeric", month: "short", day: "numeric",
          }));
          time.dateTime = dateValue;
          dateLabel.append(dateField === "deadline" ? "Deadline " : "Date ", time);
        } else {
          dateLabel.textContent = "Date not set";
        }

        const actions = createElement("div", "activity-actions");
        ["View", "Edit"].forEach((action) => {
          const button = createElement("button", "btn btn-secondary btn-small", action);
          button.type = "button";
          button.dataset.activityAction = action.toLowerCase();
          button.dataset.activityId = String(activity.id);
          button.setAttribute("aria-label", `${action} ${activity.name || "activity"}`);
          actions.append(button);
        });
        const menu = createElement("details", "action-menu");
        const trigger = createElement("summary", "action-menu-trigger", "⋯");
        trigger.setAttribute("aria-label", `More actions for ${activity.name || "activity"}`);
        const panel = createElement("div", "action-menu-panel");
        const archived = window.YLYData.isActivityArchived(activity);
        const archiveButton = createElement("button", "action-menu-item", archived ? "Restore Activity" : "Archive Activity");
        archiveButton.type = "button";
        archiveButton.dataset.activityAction = archived ? "restore" : "archive";
        archiveButton.dataset.activityId = String(activity.id);
        const deleteButton = createElement("button", "action-menu-item action-menu-item--danger", "Delete Activity");
        deleteButton.type = "button";
        deleteButton.dataset.activityAction = "delete";
        deleteButton.dataset.activityId = String(activity.id);
        panel.append(archiveButton, deleteButton);
        menu.append(trigger, panel);
        actions.append(menu);
        meta.append(dateLabel, createElement("span", `status-badge ${getStatusClass(status)}`, status), actions);
        card.append(main, meta);
        cards.append(card);
      });

      if (!data.length) {
        cards.append(createElement("p", "activities-empty", activities.length
          ? "No activities match your search and filters."
          : "No activities yet. Add an activity to get started."));
      }

      list.replaceChildren(cards);
      count.textContent = `${data.length} of ${activities.length} ${activities.length === 1 ? "activity" : "activities"}`;
    }

    function applyFilters() {
      if (loadFailed) return;
      const query = search.value.trim().toLocaleLowerCase();
      const selected = normalize(activeFilter);
      const types = { events: "event", sessions: "session", tasks: "task" };
      renderActivities(activities.filter((activity) => {
        if (!String(activity.name || "").toLocaleLowerCase().includes(query)) return false;
        const archived = window.YLYData.isActivityArchived(activity);
        if (selected === "archived") return archived;
        if (archived) return false;
        if (selected === "all") return true;
        if (types[selected]) return normalize(activity.type) === types[selected];
        if (selected === "general" || selected === "sm") return normalize(getSource(activity)) === selected;
        if (selected === "pending") {
          return normalize(getStatus(activity)).startsWith("pending");
        }
        return false;
      }));
    }

    function refreshActivities() {
      try {
        activities = window.YLYData.getActivities();
        loadFailed = false;
        errorMessage.hidden = true;
        applyFilters();
      } catch (error) {
        loadFailed = true;
        list.replaceChildren();
        count.textContent = "Activities unavailable";
        errorMessage.textContent = "Activities could not be loaded. Check that browser storage is enabled and the saved activities contain valid data, then reload the page.";
        errorMessage.hidden = false;
      }
    }

    function ensureOption(select, value) {
      if (!Array.from(select.options).some((option) => option.value === value)) {
        const option = createElement("option", "", value);
        option.value = value;
        option.dataset.legacy = "true";
        select.append(option);
      }
      select.value = value;
    }

    function updateProofFields() {
      const required = proofRequiredInput.checked;
      proofTypeField.hidden = !required;
      proofTypeInput.disabled = !required || dialogMode === "view";
    }

    function populateTargetMembers(members, assignedIds) {
      const assigned = new Set(assignedIds.map(String));
      const rendered = new Set();
      function appendMember(id, name, archived) {
        const key = String(id);
        if (rendered.has(key)) return;
        rendered.add(key);
        const label = createElement("label", "activity-member-option");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.name = "targetMember";
        checkbox.value = key;
        checkbox.checked = assigned.has(key);
        // Existing archived targets stay selectable, but cannot be newly assigned.
        checkbox.disabled = archived && !assigned.has(key);
        label.append(checkbox, createElement("span", "", name));
        targetMembers.append(label);
      }
      members.forEach((member) => {
        const archived = normalize(member.status) === "archived";
        if (archived && !assigned.has(String(member.id))) return;
        const name = member.committee ? `${member.name} (${member.committee})` : member.name;
        appendMember(member.id, `${name}${archived ? " (Archived)" : ""}`, archived);
      });
      assignedIds.forEach((id) => {
        if (!rendered.has(String(id))) appendMember(id, `Member unavailable (${id})`, false);
      });
      if (!rendered.size) {
        targetMembers.append(createElement("p", "text-muted", "No members available. You can save this activity without selecting members."));
      }
    }

    function openActivityDialog(mode = "add", activityId = null) {
      if (dialog.open) return;
      let activity = null;
      try {
        if (mode !== "add") {
          activity = window.YLYData.getActivities().find((item) => String(item.id) === String(activityId));
          if (!activity) throw new Error("This activity is no longer available. Refresh the list and try again.");
        }
      } catch (error) {
        errorMessage.textContent = error.message || "This activity could not be loaded. Check browser storage and try again.";
        errorMessage.hidden = false;
        return;
      }
      dialogMode = mode;
      editingActivityId = activity ? activity.id : null;
      form.reset();
      formError.hidden = true;
      saveButton.disabled = false;
      saveButton.hidden = mode === "view";
      metadataFieldset.disabled = mode === "view";
      dialogTitle.textContent = mode === "add" ? "Add Activity" : mode === "edit" ? "Edit Activity" : "View Activity";
      saveButton.textContent = mode === "edit" ? "Save Changes" : "Add Activity";
      cancelButton.textContent = mode === "view" ? "Close" : "Cancel";
      [nameInput, dateInput, deadlineInput].forEach((input) => input.setCustomValidity(""));
      [sourceInput, typeInput].forEach((select) => {
        select.querySelectorAll("option[data-legacy]").forEach((option) => option.remove());
      });
      nameInput.value = activity ? activity.name || "" : "";
      ensureOption(typeInput, activity ? activity.type || "Event" : "Event");
      ensureOption(sourceInput, activity ? getSource(activity) : "General");
      dateInput.value = activity ? activity.date || "" : localToday();
      deadlineInput.value = activity ? activity.deadline || "" : localToday();
      const proof = window.YLYData.getActivityProofSettings(activity || {});
      proofRequiredInput.checked = proof.required;
      proofNotRequiredInput.checked = !proof.required;
      proofTypeInput.value = proof.type || "screenshot";
      updateProofFields();
      targetMembers.replaceChildren();

      try {
        const members = window.YLYData.getMembers();
        const assignedIds = activity ? getAssignments(activity).map((assignment) => assignment.memberId) : [];
        populateTargetMembers(members, assignedIds);
      } catch (error) {
        saveButton.disabled = true;
        formError.textContent = "Members could not be loaded. Check browser storage and the saved members data, then reopen this dialog.";
        formError.hidden = false;
      }

      dialog.showModal();
      (mode === "view" ? closeButton : nameInput).focus();
    }

    function createActivityId(records) {
      let id;
      do {
        id = window.crypto && typeof window.crypto.randomUUID === "function"
          ? window.crypto.randomUUID()
          : `activity-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      } while (records.some((activity) => String(activity.id) === id));
      return id;
    }

    function closeActionMenus(exceptTarget = null) {
      list.querySelectorAll("details.action-menu").forEach((menu) => {
        if (!exceptTarget || !menu.contains(exceptTarget)) menu.open = false;
      });
    }

    function findCurrentActivity(activityId) {
      const activity = window.YLYData.getActivities().find((item) => String(item.id) === String(activityId));
      if (!activity) throw new Error("This activity no longer exists. Close this dialog and refresh the list.");
      return activity;
    }

    function showDeleteDetails(activity) {
      const records = window.YLYData.getActivityRecordCount(activity);
      deleteRequiresForce = records > 0;
      deleteTitle.textContent = "Delete Activity";
      deleteMessage.textContent = records > 0
        ? `This activity has records for ${records} members. Deleting it will remove their saved statuses. Consider Archiving instead.`
        : `Delete ${activity.name || "this activity"}? This cannot be undone.`;
      deleteConfirm.textContent = records > 0 ? "Force Delete" : "Delete";
      deleteArchive.hidden = records === 0;
    }

    function openDeleteDialog(activityId) {
      if (deleteDialog.open) return;
      try {
        const activity = findCurrentActivity(activityId);
        deletingActivityId = activity.id;
        showDeleteDetails(activity);
        deleteError.hidden = true;
        deleteDialog.showModal();
        deleteCancel.focus();
      } catch (error) {
        errorMessage.textContent = error.message || "This activity could not be loaded. Try again.";
        errorMessage.hidden = false;
      }
    }

    function setArchived(activityId, archived, fromDeleteDialog = false) {
      try {
        // The storage helper reads the latest activity so member history is kept.
        window.YLYData.archiveActivity(activityId, archived);
        if (fromDeleteDialog) deleteDialog.close();
        refreshActivities();
      } catch (error) {
        const target = fromDeleteDialog ? deleteError : errorMessage;
        target.textContent = error.message || "The activity could not be saved. Try again.";
        target.hidden = false;
      }
    }

    deleteConfirm.addEventListener("click", () => {
      if (!deleteDialog.open || deletingActivityId === null) return;
      deleteError.hidden = true;
      try {
        const activity = findCurrentActivity(deletingActivityId);
        if (!deleteRequiresForce && window.YLYData.getActivityRecordCount(activity) > 0) {
          // Another tab may have added records after a standard confirmation opened.
          // Present the updated warning and require a separate Force Delete click.
          showDeleteDetails(activity);
          deleteArchive.focus();
          return;
        }
        window.YLYData.deleteActivity(deletingActivityId, { force: deleteRequiresForce });
        deleteDialog.close();
        deletingActivityId = null;
        refreshActivities();
      } catch (error) {
        deleteError.textContent = error.message || "The activity could not be deleted. Try again.";
        deleteError.hidden = false;
      }
    });
    deleteArchive.addEventListener("click", () => {
      if (deleteDialog.open && deletingActivityId !== null && !deleteArchive.hidden) {
        setArchived(deletingActivityId, true, true);
      }
    });
    [deleteCancel, deleteClose].forEach((button) => button.addEventListener("click", () => deleteDialog.close()));
    document.addEventListener("click", (event) => closeActionMenus(event.target));
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      const openMenu = Array.from(list.querySelectorAll("details.action-menu")).find((menu) => menu.open);
      closeActionMenus();
      if (openMenu) openMenu.querySelector("summary").focus();
    });

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (dialogMode === "view" || saveButton.disabled) return;
      nameInput.setCustomValidity(nameInput.value.trim() ? "" : "Enter an activity name.");
      const date = parseDate(dateInput.value);
      const deadline = parseDate(deadlineInput.value);
      dateInput.setCustomValidity(date ? "" : "Choose a valid activity date.");
      deadlineInput.setCustomValidity(deadline ? "" : "Choose a valid deadline.");
      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }

      formError.hidden = true;
      try {
        const selectedIds = Array.from(targetMembers.querySelectorAll("input:checked"), (input) => input.value);
        const details = {
          name: nameInput.value.trim(),
          type: typeInput.value,
          source: sourceInput.value,
          date: dateInput.value,
          deadline: deadlineInput.value,
          proofRequired: proofRequiredInput.checked,
          proofType: proofTypeInput.value,
          targetMembers: selectedIds,
        };
        if (dialogMode === "edit") {
          // The helper merges metadata into the latest record, preserving every member's progress.
          window.YLYData.updateActivity(editingActivityId, details);
        } else {
          const latestActivities = window.YLYData.getActivities();
          const availableMembers = new Map(window.YLYData.getMembers()
            .filter((member) => normalize(member.status) !== "archived")
            .map((member) => [String(member.id), member]));
          if (selectedIds.some((id) => !availableMembers.has(id))) {
            throw new Error("A selected member was removed or archived. Reopen this dialog to refresh the member list, then try again.");
          }
          details.targetMembers = selectedIds.map((id) => availableMembers.get(id).id);
          latestActivities.push({
            id: createActivityId(latestActivities),
            ...details,
            memberStatuses: details.targetMembers.map((memberId) => ({ memberId, status: "pending" })),
          });
          window.YLYData.saveActivities(latestActivities);
        }
        dialog.close();
        refreshActivities();
      } catch (error) {
        formError.textContent = error.message || "The activity could not be saved. Check browser storage and the saved activities and members data, then try again.";
        formError.hidden = false;
      }
    });

    nameInput.addEventListener("input", () => nameInput.setCustomValidity(""));
    [proofRequiredInput, proofNotRequiredInput].forEach((input) => input.addEventListener("change", updateProofFields));
    [dateInput, deadlineInput].forEach((input) => {
      input.addEventListener("input", () => {
        dateInput.setCustomValidity("");
        deadlineInput.setCustomValidity("");
      });
    });
    addButton.addEventListener("click", () => openActivityDialog("add"));
    list.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-activity-action]");
      if (!button || !list.contains(button)) return;
      const { activityAction, activityId } = button.dataset;
      closeActionMenus();
      if (activityAction === "delete") openDeleteDialog(activityId);
      else if (activityAction === "archive" || activityAction === "restore") setArchived(activityId, activityAction === "archive");
      else openActivityDialog(activityAction, activityId);
    });
    cancelButton.addEventListener("click", () => dialog.close());
    closeButton.addEventListener("click", () => dialog.close());
    search.addEventListener("input", applyFilters);
    filters.forEach((button) => {
      button.addEventListener("click", () => {
        activeFilter = button.dataset.filter;
        filters.forEach((filter) => {
          const active = filter === button;
          filter.classList.toggle("active", active);
          filter.setAttribute("aria-pressed", String(active));
        });
        applyFilters();
      });
    });

    window.addEventListener("storage", (event) => {
      if (event.key === null || event.key === "activities" || event.key === "members") refreshActivities();
    });
    window.addEventListener("yly:data-changed", refreshActivities);

    function handleAddActivityLink() {
      if (window.location.hash !== "#add-activity") return;
      openActivityDialog();
      try {
        const url = new URL(window.location.href);
        url.hash = "";
        window.history.replaceState(window.history.state, "", url.href);
      } catch (error) {
        // Some file-based browser contexts do not allow history replacement.
      }
    }

    refreshActivities();
    handleAddActivityLink();
    window.addEventListener("hashchange", handleAddActivityLink);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeActivities, { once: true });
  } else {
    initializeActivities();
  }
})();
