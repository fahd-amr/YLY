(function () {
  "use strict";

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function localToday() {
    const date = new Date();
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    ].join("-");
  }

  function initializeMembers() {
    const search = document.getElementById("member-search");
    const tableBody = document.getElementById("members-table-body");
    const count = document.getElementById("member-count");
    const errorMessage = document.getElementById("members-error");
    const filters = document.querySelectorAll(".filter-pill[data-status]");
    const addButton = document.getElementById("add-member-button");
    const dialog = document.getElementById("member-dialog");
    const dialogTitle = document.getElementById("member-dialog-title");
    const form = document.getElementById("member-form");
    const fields = document.getElementById("member-fields");
    const nameInput = document.getElementById("member-name");
    const committeeInput = document.getElementById("member-committee");
    const statusInput = document.getElementById("member-status");
    const joinedDateInput = document.getElementById("member-joined-date");
    const formError = document.getElementById("member-form-error");
    const saveButton = document.getElementById("member-save-button");
    const cancelButton = document.getElementById("member-cancel-button");
    const closeButton = document.getElementById("member-close-button");
    const notice = document.getElementById("member-notice");
    const deleteDialog = document.getElementById("member-delete-dialog");
    const deleteMessage = document.getElementById("member-delete-message");
    const deleteError = document.getElementById("member-delete-error");
    const deleteButton = document.getElementById("member-delete-confirm");

    if (!search || !tableBody || !count || !errorMessage || !dialog) return;

    let members = [];
    let pendingByMember = new Map();
    let activeStatus = "All";
    let loadFailed = false;
    let dialogMode = "add";
    let editingId = null;
    let initialMembership = "Up to date";
    let deletingMemberId = null;

    function closeActionMenus(except) {
      tableBody.querySelectorAll(".action-menu[open]").forEach((menu) => {
        if (menu !== except) menu.open = false;
      });
    }

    function openDeleteMember(memberId) {
      try {
        const member = window.YLYData.getMembers().find((item) => String(item.id) === String(memberId));
        if (!member) throw new Error("This member no longer exists.");
        deletingMemberId = member.id;
        deleteMessage.textContent = `Delete ${member.name} permanently? This will remove their saved activity history.`;
        deleteError.hidden = true;
        deleteButton.disabled = false;
        deleteDialog.showModal();
        document.getElementById("member-delete-cancel").focus();
      } catch (error) {
        errorMessage.textContent = error.message;
        errorMessage.hidden = false;
      }
    }

    function createMemberMenu(member) {
      const archived = window.YLYData.isMemberArchived(member);
      const menu = createElement("details", "action-menu");
      const trigger = createElement("summary", "action-menu-trigger", "\u22ef");
      trigger.setAttribute("aria-label", `More actions for ${member.name}`);
      const panel = createElement("div", "action-menu-panel");
      const archiveButton = createElement("button", "action-menu-item", archived ? "Restore Member" : "Archive Member");
      archiveButton.type = "button";
      archiveButton.addEventListener("click", () => {
        menu.open = false;
        try {
          window.YLYData.archiveMember(member.id, !archived);
          refreshMembers();
          notice.textContent = `${member.name} ${archived ? "restored" : "archived"}.`;
          search.focus();
        } catch (error) {
          errorMessage.textContent = error.message;
          errorMessage.hidden = false;
        }
      });
      const removeButton = createElement("button", "action-menu-item action-menu-item--danger", "Delete Permanently");
      removeButton.type = "button";
      removeButton.addEventListener("click", () => {
        menu.open = false;
        trigger.focus();
        openDeleteMember(member.id);
      });
      panel.append(archiveButton, removeButton);
      menu.append(trigger, panel);
      menu.addEventListener("toggle", () => { if (menu.open) closeActionMenus(menu); });
      return menu;
    }

    function renderMembers(data) {
      const rows = document.createDocumentFragment();
      const badgeClasses = {
        "Needs Follow-up": "badge-warning",
        "Up to date": "badge-success",
        Archived: "badge-neutral",
      };

      data.forEach((member) => {
        const row = document.createElement("tr");
        const profileUrl = `member-details.html?id=${encodeURIComponent(String(member.id))}`;
        const nameCell = createElement("th", "member-name-cell");
        nameCell.scope = "row";
        const nameLink = createElement("a", "member-profile-link", member.name);
        nameLink.href = profileUrl;
        nameCell.append(nameLink);
        const statusCell = document.createElement("td");
        const pendingCell = document.createElement("td");
        const actionCell = document.createElement("td");
        const actions = createElement("div", "member-actions");
        const pending = pendingByMember.get(String(member.id)) || 0;

        statusCell.append(createElement(
          "span",
          `status-badge ${badgeClasses[member.status] || "badge-neutral"}`,
          member.status || "Unknown"
        ));
        pendingCell.append(createElement(
          "span",
          pending ? "pending-count" : "text-muted",
          pending
        ));

        const viewLink = createElement("a", "table-action", "View");
        viewLink.href = profileUrl;
        viewLink.setAttribute("aria-label", `View ${member.name}`);
        const editButton = createElement("button", "table-action", "Edit");
        editButton.type = "button";
        editButton.setAttribute("aria-label", `Edit ${member.name}`);
        editButton.addEventListener("click", () => openMemberDialog("edit", member));
        actions.append(viewLink, editButton, createMemberMenu(member));
        actionCell.append(actions);
        row.append(
          nameCell,
          createElement("td", "", member.committee),
          statusCell,
          pendingCell,
          actionCell
        );
        rows.append(row);
      });

      if (!data.length) {
        const row = document.createElement("tr");
        const cell = createElement(
          "td",
          "members-empty",
          members.length
            ? (activeStatus === "Archived" && !search.value.trim() ? "No archived members." : "No members match your search and filters.")
            : "No members yet. Add a member to get started."
        );
        cell.colSpan = 5;
        row.append(cell);
        rows.append(row);
      }

      tableBody.replaceChildren(rows);
      const scopeCount = members.filter((member) => window.YLYData.isMemberArchived(member) === (activeStatus === "Archived")).length;
      count.textContent = `${data.length} of ${scopeCount} ${activeStatus === "Archived" ? "archived" : "active"} ${scopeCount === 1 ? "member" : "members"}`;
    }

    function applyFilters() {
      if (loadFailed) return;
      const query = search.value.trim().toLocaleLowerCase();
      renderMembers(members.filter((member) => (
        window.YLYData.isMemberArchived(member) === (activeStatus === "Archived") &&
        (activeStatus === "All" || member.status === activeStatus) &&
        String(member.name || "").toLocaleLowerCase().includes(query)
      )));
    }

    function refreshMembers() {
      try {
        const activities = window.YLYData.getActivities().filter((activity) => !window.YLYData.isActivityArchived(activity));
        members = window.YLYData.getMembers().map((member) => ({
          ...member,
          status: window.YLYData.getMemberFollowUpStatus(member, activities),
        }));
        pendingByMember = new Map(members.map((member) => [String(member.id), 0]));

        activities.forEach((activity) => {
          window.YLYData.getActivityMemberStatuses(activity).forEach((assignment) => {
            const id = String(assignment.memberId);
            if (pendingByMember.has(id) && window.YLYData.getMemberActivityProgress(activity, assignment).pending) {
              pendingByMember.set(id, pendingByMember.get(id) + 1);
            }
          });
        });

        loadFailed = false;
        errorMessage.hidden = true;
        applyFilters();
      } catch (error) {
        loadFailed = true;
        tableBody.replaceChildren();
        count.textContent = "Members unavailable";
        errorMessage.textContent = "Members could not be loaded. Check that browser storage is enabled and the saved members and activities contain valid data, then reload the page.";
        errorMessage.hidden = false;
      }
    }

    function openMemberDialog(mode, member) {
      dialogMode = mode;
      editingId = member ? member.id : null;
      form.reset();
      formError.hidden = true;
      nameInput.setCustomValidity("");
      committeeInput.setCustomValidity("");
      nameInput.value = member ? member.name || "" : "";
      committeeInput.value = member ? member.committee || "" : "SM";
      statusInput.value = member && member.status === "Archived" ? "Archived" : "Up to date";
      initialMembership = statusInput.value;
      joinedDateInput.value = member ? member.joinedDate || "" : localToday();
      fields.disabled = mode === "view";
      saveButton.hidden = mode === "view";
      cancelButton.textContent = mode === "view" ? "Close" : "Cancel";
      dialogTitle.textContent = mode === "view" ? "Member Details" : mode === "edit" ? "Edit Member" : "Add Member";
      saveButton.textContent = mode === "add" ? "Add Member" : "Save Changes";
      if (!dialog.open) dialog.showModal();
      if (mode !== "view") nameInput.focus();
    }

    function createMemberId(records) {
      let id;
      do {
        id = window.crypto && typeof window.crypto.randomUUID === "function"
          ? window.crypto.randomUUID()
          : `member-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      } while (records.some((member) => String(member.id) === id));
      return id;
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (dialogMode === "view") return;

      nameInput.setCustomValidity(nameInput.value.trim() ? "" : "Enter a member name.");
      committeeInput.setCustomValidity(committeeInput.value.trim() ? "" : "Enter a committee.");
      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }

      formError.hidden = true;
      try {
        // Read again so an edit preserves members saved in another tab.
        const latestMembers = window.YLYData.getMembers();
        const values = {
          name: nameInput.value.trim(),
          committee: committeeInput.value.trim(),
          status: statusInput.value,
          joinedDate: joinedDateInput.value,
        };

        if (dialogMode === "edit") {
          const index = latestMembers.findIndex((member) => String(member.id) === String(editingId));
          if (index === -1) {
            formError.textContent = "This member no longer exists. Close this dialog and refresh the page.";
            formError.hidden = false;
            return;
          }
          // A name edit must not undo a membership change made in another tab.
          if (statusInput.value === initialMembership) values.status = latestMembers[index].status;
          latestMembers[index] = { ...latestMembers[index], ...values };
        } else {
          latestMembers.push({ id: createMemberId(latestMembers), ...values });
        }

        window.YLYData.saveMembers(latestMembers);
        dialog.close();
        refreshMembers();
      } catch (error) {
        formError.textContent = "The member could not be saved. Check browser storage and the saved members data, then try again.";
        formError.hidden = false;
      }
    });

    [nameInput, committeeInput].forEach((input) => {
      input.addEventListener("input", () => input.setCustomValidity(""));
    });
    addButton.addEventListener("click", () => openMemberDialog("add"));
    cancelButton.addEventListener("click", () => dialog.close());
    closeButton.addEventListener("click", () => dialog.close());
    document.getElementById("member-delete-cancel").addEventListener("click", () => deleteDialog.close());
    document.getElementById("member-delete-close").addEventListener("click", () => deleteDialog.close());
    deleteDialog.addEventListener("close", () => { deletingMemberId = null; });
    deleteButton.addEventListener("click", () => {
      if (deletingMemberId === null) return;
      deleteButton.disabled = true;
      deleteError.hidden = true;
      try {
        window.YLYData.deleteMember(deletingMemberId);
        deleteDialog.close();
        deletingMemberId = null;
        refreshMembers();
        notice.textContent = "Member and their saved activity history deleted.";
        search.focus();
      } catch (error) {
        deleteError.textContent = error.message;
        deleteError.hidden = false;
      } finally {
        deleteButton.disabled = false;
      }
    });
    document.addEventListener("click", (event) => {
      tableBody.querySelectorAll(".action-menu[open]").forEach((menu) => {
        if (!menu.contains(event.target)) menu.open = false;
      });
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        const openMenu = tableBody.querySelectorAll(".action-menu[open]")[0];
        closeActionMenus();
        if (openMenu) openMenu.children[0].focus();
      }
    });
    search.addEventListener("input", applyFilters);

    filters.forEach((button) => {
      button.addEventListener("click", () => {
        activeStatus = button.dataset.status;
        filters.forEach((filter) => {
          const active = filter === button;
          filter.classList.toggle("active", active);
          filter.setAttribute("aria-pressed", String(active));
        });
        applyFilters();
      });
    });

    window.addEventListener("storage", (event) => {
      if (event.key === null || event.key === "members" || event.key === "activities") {
        refreshMembers();
      }
    });
    window.addEventListener("yly:data-changed", refreshMembers);

    function handleAddMemberLink() {
      if (window.location.hash !== "#add-member") return;
      openMemberDialog("add");
      // Consume the shortcut so the same Add Member link can be used again.
      try {
        const url = new URL(window.location.href);
        url.hash = "";
        window.history.replaceState(window.history.state, "", url.href);
      } catch (error) {
        // Some file-based browser contexts do not allow history replacement.
      }
    }

    refreshMembers();
    handleAddMemberLink();
    window.addEventListener("hashchange", handleAddMemberLink);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeMembers, { once: true });
  } else {
    initializeMembers();
  }
})();
