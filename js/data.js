(function () {
  "use strict";

  const defaultMembers = [
    {
      id: 1,
      name: "Habiba",
      committee: "SM",
      status: "Needs Follow-up",
      joinedDate: "2026-08-01",
    },
    {
      id: 2,
      name: "Maha",
      committee: "SM",
      status: "Up to date",
      joinedDate: "2026-08-05",
    },
    {
      id: 3,
      name: "Jihad",
      committee: "SM",
      status: "Needs Follow-up",
      joinedDate: "2026-08-10",
    },
  ];

  const defaultActivities = [
    {
      id: 1,
      type: "Event",
      name: "Volunteer Welcome Day",
      date: "2026-09-15",
      deadline: "2026-09-16",
      formRequired: true,
      screenshotRequired: false,
      targetMembers: [1, 2, 3],
      memberStatuses: [
        { memberId: 1, status: "pending" },
        { memberId: 2, status: "attended" },
        { memberId: 3, status: "excused" },
      ],
    },
    {
      id: 2,
      type: "Session",
      name: "Social Media Basics",
      date: "2026-09-18",
      deadline: "2026-09-19",
      formRequired: false,
      screenshotRequired: true,
      targetMembers: [1, 2, 3],
      memberStatuses: [
        { memberId: 1, status: "attended" },
        { memberId: 2, status: "attended" },
        { memberId: 3, status: "pending" },
      ],
    },
    {
      id: 3,
      type: "Task",
      name: "Submit September Content Ideas",
      date: "2026-09-20",
      deadline: "2026-09-22",
      formRequired: true,
      screenshotRequired: true,
      targetMembers: [1, 2, 3],
      memberStatuses: [
        { memberId: 1, status: "pending" },
        { memberId: 2, status: "done" },
        { memberId: 3, status: "pending" },
      ],
    },
  ];

  function readArray(key) {
    let storedValue;

    try {
      storedValue = window.localStorage.getItem(key);
    } catch (error) {
      throw new Error(
        `YLY Follow-Up: cannot read "${key}". Allow browser storage for this site. ${error.message}`
      );
    }

    // A missing key differs from a saved empty array, which must be preserved.
    if (storedValue === null) {
      return null;
    }

    let data;

    try {
      data = JSON.parse(storedValue);
    } catch (error) {
      throw new Error(
        `YLY Follow-Up: "${key}" contains invalid JSON. Repair its localStorage entry before continuing; existing data has been preserved.`
      );
    }

    if (!Array.isArray(data)) {
      throw new TypeError(
        `YLY Follow-Up: "${key}" must contain an array. Repair its localStorage entry before continuing; existing data has been preserved.`
      );
    }

    return data;
  }

  function saveArray(key, data) {
    if (!Array.isArray(data)) {
      throw new TypeError(`YLY Follow-Up: "${key}" must be saved as an array.`);
    }

    let serializedData;

    try {
      serializedData = JSON.stringify(data);
    } catch (error) {
      throw new TypeError(
        `YLY Follow-Up: "${key}" must contain JSON-serializable data. ${error.message}`
      );
    }

    try {
      window.localStorage.setItem(key, serializedData);
    } catch (error) {
      throw new Error(
        `YLY Follow-Up: cannot save "${key}". Allow browser storage and check available storage space. ${error.message}`
      );
    }

    notifyChange(key);
  }

  function notifyChange(key) {
    // Native storage events reach other tabs; this event refreshes this window.
    try {
      if (typeof window.dispatchEvent === "function" && typeof window.CustomEvent === "function") {
        window.dispatchEvent(new window.CustomEvent("yly:data-changed", { detail: { key } }));
      }
    } catch (error) {
      // A failing UI notification must not report a successful save as failed.
    }
  }

  function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function isId(value) {
    return (typeof value === "string" && value.trim() !== "")
      || (typeof value === "number" && Number.isFinite(value));
  }

  function normalizeStatus(value, type) {
    let status = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (["excuse", "excuses", "excuse_after_selection", "excused_after_selection"].includes(status)) status = "excused";
    if (status === "notselected") status = "not_selected";
    if (type === "task" && status === "completed") status = "done";
    return status;
  }

  function normalizeProofType(value) {
    const type = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (["screenshot", "screen_shot"].includes(type)) return "screenshot";
    if (["form", "form_confirmation", "formconfirmation"].includes(type)) return "form_confirmation";
    return "";
  }

  function isCalendarDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000-")) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }

  function getActivityDeadline(activity) {
    const entry = isRecord(activity) ? activity : {};
    // dueDate is canonical; deadline remains an alias for existing pages and backups.
    return typeof entry.dueDate === "string" && entry.dueDate.trim()
      ? entry.dueDate.trim() : typeof entry.deadline === "string" ? entry.deadline.trim() : "";
  }

  function getActivityProofSettings(activity) {
    const entry = isRecord(activity) ? activity : {};
    return {
      required: typeof entry.proofRequired === "boolean"
        ? entry.proofRequired : Boolean(entry.screenshotRequired || entry.formRequired),
      type: normalizeProofType(entry.proofType)
        || (entry.screenshotRequired ? "screenshot" : entry.formRequired ? "form_confirmation" : "screenshot"),
    };
  }

  function isMemberArchived(member) {
    return normalizeStatus(member && member.status) === "archived";
  }

  function isActivityArchived(activity) {
    if (!isRecord(activity)) return false;
    if (typeof activity.archived === "boolean") return activity.archived;
    return activity.isArchived === true || normalizeStatus(activity.status) === "archived";
  }

  function normalizeActivity(activity) {
    if (!isRecord(activity)) return activity;

    const targetIds = [];
    const targetKeys = new Set();
    const records = new Map();
    const legacyTargets = Array.isArray(activity.targetMembers) ? activity.targetMembers : [];

    function addTarget(id) {
      if (!isId(id) || targetKeys.has(String(id))) return;
      targetKeys.add(String(id));
      targetIds.push(id);
    }

    legacyTargets.forEach((target) => {
      const id = isRecord(target) ? target.memberId : target;
      addTarget(id);
      if (isRecord(target) && isId(id)) records.set(String(id), { ...target });
    });

    // Canonical records win over legacy statuses, while retaining extra legacy
    // fields such as reasons and history that have no canonical replacement.
    (Array.isArray(activity.memberStatuses) ? activity.memberStatuses : []).forEach((record) => {
      if (!isRecord(record) || !isId(record.memberId)) return;
      const key = String(record.memberId);
      records.set(key, { ...records.get(key), ...record });
      if (!Array.isArray(activity.targetMembers)) addTarget(record.memberId);
    });

    targetIds.forEach((memberId) => {
      if (!records.has(String(memberId))) records.set(String(memberId), { memberId, status: "pending" });
    });

    const proof = getActivityProofSettings(activity);
    const memberStatuses = [...records.values()].map((record) => {
      const hasReceipt = ["proofReceived", "applicationProofReceived", "attendanceProofReceived"]
        .some((field) => typeof record[field] === "boolean");
      // Bind known legacy receipts before an activity's proof settings can be
      // edited. Unknown receipts remain unknown and do not create new work.
      return hasReceipt && !normalizeProofType(record.proofType)
        ? { ...record, proofType: proof.type } : record;
    });
    const deadline = getActivityDeadline(activity);
    const dates = deadline ? { dueDate: deadline, deadline } : {};
    return { ...activity, ...dates, proofRequired: proof.required, proofType: proof.type, targetMembers: targetIds, memberStatuses };
  }

  function getActivityMemberStatuses(activity) {
    const normalized = normalizeActivity(activity);
    if (!isRecord(normalized)) return [];
    const active = new Set(normalized.targetMembers.map(String));
    return normalized.memberStatuses.filter((record) => active.has(String(record.memberId)));
  }

  function getMemberActivityProgress(activity, record) {
    const type = String(activity && activity.type || "").trim().toLowerCase();
    const assignment = isRecord(record) ? record : {};
    let status = normalizeStatus(assignment.status, type) || "pending";
    let applied = null;
    let selection = "";
    let finalStatus = "";

    const permittedStatuses = {
      task: ["pending", "done", "excused", "pending_proof", "needs_follow_up"],
      session: ["pending", "attended", "excused", "absent", "needs_follow_up", "upcoming"],
      event: ["pending", "applied", "selected", "not_selected", "attended", "excused", "absent", "pending_selection", "pending_proof", "needs_follow_up", "upcoming"],
    };
    const incompatibleStatus = permittedStatuses[type] && !permittedStatuses[type].includes(status);
    if (incompatibleStatus) status = "pending";

    if (type === "event" && !incompatibleStatus) {
      const history = Array.isArray(assignment.history) ? assignment.history : [];
      history.forEach((step) => {
        const value = normalizeStatus(isRecord(step) ? step.status : step, type);
        if (value === "applied" || (isRecord(step) && step.applied === true)) applied = true;
        const recordedSelection = normalizeStatus(isRecord(step) ? step.selection : "");
        if (["selected", "not_selected"].includes(recordedSelection)) selection = recordedSelection;
        else if (["selected", "not_selected"].includes(value)) selection = value;
      });
      if (status === "applied") applied = true;
      if (["selected", "not_selected"].includes(status)) selection = status;
      if (["pending", "attended", "excused", "absent"].includes(status)) finalStatus = status;

      if (typeof assignment.applied === "boolean") {
        applied = assignment.applied;
        selection = applied ? normalizeStatus(assignment.selection) : "";
        if (!["selected", "not_selected"].includes(selection)) selection = "";
        finalStatus = selection === "selected" ? normalizeStatus(assignment.finalStatus) : "";
        if (selection === "selected" && !["pending", "attended", "excused", "absent"].includes(finalStatus)) finalStatus = "pending";
        status = !applied ? "pending" : !selection ? "applied" : selection === "not_selected" ? "not_selected" : finalStatus;
      } else {
        const explicitSelection = normalizeStatus(assignment.selection);
        if (["selected", "not_selected"].includes(explicitSelection)) selection = explicitSelection;
        const explicitFinal = normalizeStatus(assignment.finalStatus);
        if (["pending", "attended", "excused", "absent"].includes(explicitFinal)) finalStatus = explicitFinal;
      }
    }

    const outcome = status;
    const proof = getActivityProofSettings(activity);
    const pendingProofStages = [];
    const previousProofType = normalizeProofType(assignment.proofType);
    const mismatchedProof = Boolean(previousProofType && previousProofType !== proof.type);
    // Missing legacy receipts are unknown, not a newly invented requirement.
    // An explicit false or a receipt recorded for another proof type is pending.
    function checkProof(stage, field, relevant) {
      if (proof.required && relevant && (assignment[field] === false || mismatchedProof)) pendingProofStages.push(stage);
    }
    checkProof("task", "proofReceived", type === "task" && outcome === "done");
    checkProof("application", "applicationProofReceived", type === "event" && applied === true);
    checkProof("attendance", "attendanceProofReceived", type === "event" && selection === "selected" && outcome === "attended");
    const proofPending = pendingProofStages.length > 0;
    if (proofPending) status = "pending_proof";

    return {
      status,
      outcome,
      proofPending,
      pendingProofStages,
      pending: status.startsWith("pending") || ["applied", "selected", "needs_follow_up", "upcoming"].includes(status),
      completed: !proofPending && (type === "task" ? outcome === "done" : ["session", "event"].includes(type) && outcome === "attended"),
      applied,
      selection,
      finalStatus,
    };
  }

  function getMemberFollowUpStatus(member, activities) {
    if (isMemberArchived(member)) return "Archived";
    const pending = (activities || []).some((activity) => !isActivityArchived(activity) && getActivityMemberStatuses(activity)
      .some((record) => String(record.memberId) === String(member.id) && getMemberActivityProgress(activity, record).pending));
    return pending ? "Needs Follow-up" : "Up to date";
  }

  function initializeData() {
    // Validate both existing entries before adding any missing seed data.
    const members = readArray("members");
    const activities = readArray("activities");

    if (members === null) {
      saveArray("members", defaultMembers);
    }

    if (activities === null) {
      saveActivities(defaultActivities);
    } else {
      const normalized = activities.map(normalizeActivity);
      if (JSON.stringify(normalized) !== JSON.stringify(activities)) saveArray("activities", normalized);
    }
  }

  function getMembers() {
    return readArray("members") ?? [];
  }

  function saveMembers(members) {
    saveArray("members", members);
  }

  function getActivities() {
    return (readArray("activities") ?? []).map(normalizeActivity);
  }

  function saveActivities(activities) {
    if (!Array.isArray(activities)) throw new TypeError("Activities must be an array.");
    saveArray("activities", activities.map(normalizeActivity));
  }

  function requireActivity(activities, activityId) {
    if (!isId(activityId)) throw new TypeError("A valid activity ID is required.");
    const index = activities.findIndex((activity) => isRecord(activity) && String(activity.id) === String(activityId));
    if (index === -1) throw new Error("This activity no longer exists. Refresh the page and try again.");
    return index;
  }

  function validateFields(data, allowed, label) {
    if (!isRecord(data)) throw new TypeError(`${label} must be an object.`);
    Object.keys(data).forEach((key) => {
      if (!allowed.includes(key)) throw new TypeError(`Cannot update ${label} field "${key}".`);
    });
  }

  function updateMemberActivityStatus(activityId, memberId, statusData) {
    const activities = getActivities();
    const activityIndex = requireActivity(activities, activityId);
    const activity = activities[activityIndex];
    const member = isId(memberId) && getMembers().find((entry) => entry && String(entry.id) === String(memberId));
    if (!member) throw new Error("This member no longer exists.");
    if (isMemberArchived(member) || isActivityArchived(activity)) throw new Error("Archived members and activities are read-only. Restore them before updating a status.");
    if (!activity.targetMembers.some((id) => String(id) === String(memberId))) throw new Error("This member is no longer assigned to this activity.");
    const recordIndex = activity.memberStatuses.findIndex((record) => String(record.memberId) === String(memberId));
    const original = activity.memberStatuses[recordIndex];
    const type = String(activity.type || "").trim().toLowerCase();
    const fields = {
      task: ["status", "proofReceived", "excuseReason", "reason", "submissionDate", "isLate"],
      session: ["status", "excuseReason", "reason"],
      event: ["applied", "selection", "finalStatus", "excuseReason", "reason", "applicationProofReceived", "attendanceProofReceived"],
    };
    if (!fields[type]) throw new TypeError("Only Task, Session, and Event statuses can be updated.");
    validateFields(statusData, fields[type], "member status");
    if (!Object.keys(statusData).length) return original;

    const patch = { ...statusData };
    if (Object.hasOwn(patch, "reason")) {
      if (Object.hasOwn(patch, "excuseReason") && patch.reason !== patch.excuseReason) throw new TypeError("Excuse reasons must agree.");
      patch.excuseReason = patch.reason;
      delete patch.reason;
    }
    if (Object.hasOwn(patch, "excuseReason") && typeof patch.excuseReason !== "string") throw new TypeError("An excuse reason must be text.");
    if (Object.hasOwn(patch, "submissionDate") && !isCalendarDate(patch.submissionDate)) throw new TypeError("Choose a valid Submission Date.");
    for (const field of ["proofReceived", "applicationProofReceived", "attendanceProofReceived", "isLate"]) {
      if (Object.hasOwn(patch, field) && typeof patch[field] !== "boolean") throw new TypeError(`${field} must be true or false.`);
    }
    if (Object.hasOwn(patch, "status")) {
      if (typeof patch.status !== "string") throw new TypeError("Status must be text.");
      patch.status = normalizeStatus(patch.status, type);
      const permitted = type === "task" ? ["pending", "done", "excused"] : ["pending", "attended", "excused", "absent"];
      if (!permitted.includes(patch.status)) throw new TypeError("Choose a valid status for this activity type.");
    }
    if (type === "event") {
      if (Object.hasOwn(patch, "applied") && typeof patch.applied !== "boolean") throw new TypeError("Applied must be true or false.");
      for (const field of ["selection", "finalStatus"]) {
        if (!Object.hasOwn(patch, field)) continue;
        if (typeof patch[field] !== "string") throw new TypeError(`${field} must be text.`);
        patch[field] = normalizeStatus(patch[field]);
        if (field === "selection" && patch[field] === "pending_selection") patch[field] = "";
        const permitted = field === "selection" ? ["", "selected", "not_selected"] : ["", "pending", "attended", "excused", "absent"];
        if (!permitted.includes(patch[field])) throw new TypeError(`Choose a valid ${field}.`);
      }
    }

    const next = { ...original, ...patch };
    const proof = getActivityProofSettings(activity);
    const receiptFields = type === "task" ? ["proofReceived"] : type === "event" ? ["applicationProofReceived", "attendanceProofReceived"] : [];
    if (receiptFields.some((field) => Object.hasOwn(patch, field))) {
      // Changing proof type must not relabel another stage's old receipt as new proof.
      const oldType = normalizeProofType(original.proofType);
      if (oldType && oldType !== proof.type) {
        receiptFields.forEach((field) => {
          if (!Object.hasOwn(patch, field) && Object.hasOwn(original, field)) next[field] = false;
        });
      }
      next.proofType = proof.type;
    }
    if (type === "event") {
      if (typeof next.applied !== "boolean") throw new TypeError("Include the Applied value when updating an event.");
      next.selection = next.applied ? normalizeStatus(next.selection) : "";
      if (!["selected", "not_selected"].includes(next.selection)) next.selection = "";
      next.finalStatus = next.selection === "selected" ? normalizeStatus(next.finalStatus) || "pending" : "";
      if (next.selection === "selected" && !["pending", "attended", "excused", "absent"].includes(next.finalStatus)) next.finalStatus = "pending";
      next.status = !next.applied ? "pending" : !next.selection ? "applied" : next.selection === "not_selected" ? "not_selected" : next.finalStatus;
      if (!next.applied) delete next.applicationProofReceived;
      if (next.selection !== "selected" || next.finalStatus !== "attended") delete next.attendanceProofReceived;
    }
    if (type === "task") {
      const done = normalizeStatus(next.status, type) === "done";
      const suppliedDate = Object.hasOwn(patch, "submissionDate");
      const suppliedLate = Object.hasOwn(patch, "isLate");
      if (!done && (suppliedDate || suppliedLate)) throw new TypeError("Submission details can only be saved for a Done task.");
      delete next.timeliness;
      if (done) {
        const transitioned = normalizeStatus(original.status, type) !== "done";
        const submissionDate = suppliedDate ? patch.submissionDate
          : isCalendarDate(original.submissionDate) ? original.submissionDate
          : transitioned ? new Date().toISOString().split("T")[0] : "";
        const deadline = getActivityDeadline(activity);
        if ((suppliedDate || suppliedLate || transitioned) && !isCalendarDate(deadline)) {
          throw new TypeError("This task needs a valid Deadline before a submission can be saved. Edit the activity first.");
        }
        if (suppliedLate && !submissionDate) throw new TypeError("Record a Submission Date before updating task lateness.");
        if (submissionDate) {
          next.submissionDate = submissionDate;
          if (isCalendarDate(deadline)) next.isLate = submissionDate > deadline;
        }
        // Legacy completed tasks keep unknown submission dates unknown during
        // proof-only updates. Reading old records never invents dates or flags.
      } else {
        delete next.proofReceived;
        delete next.submissionDate;
        delete next.isLate;
      }
    }
    if (normalizeStatus(next.status, type) !== "excused") {
      if (Object.hasOwn(next, "excuseReason") || type === "event") next.excuseReason = "";
      if (Object.hasOwn(next, "reason")) next.reason = "";
    } else if (Object.hasOwn(patch, "excuseReason")) {
      next.excuseReason = patch.excuseReason.trim();
      if (Object.hasOwn(next, "reason")) next.reason = next.excuseReason;
    }

    if (JSON.stringify(next) === JSON.stringify(original)) return original;
    const now = new Date();
    const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const historyEntry = { status: next.status, date: localDate, timestamp: now.toISOString() };
    ["applied", "selection", "finalStatus", "proofReceived", "applicationProofReceived", "attendanceProofReceived", "proofType", "excuseReason", "submissionDate", "isLate"].forEach((field) => {
      if (Object.hasOwn(next, field)) historyEntry[field] = next[field];
    });
    next.history = [...(Array.isArray(original.history) ? original.history : []), historyEntry];
    activity.memberStatuses[recordIndex] = next;
    saveActivities(activities);
    return next;
  }

  function updateActivity(activityId, details) {
    const allowed = ["name", "type", "source", "date", "dueDate", "deadline", "formRequired", "screenshotRequired", "proofRequired", "proofType", "targetMembers"];
    validateFields(details, allowed, "activity");
    const activities = getActivities();
    const index = requireActivity(activities, activityId);
    const activity = activities[index];
    const patch = { ...details };
    for (const field of ["name", "type", "source", "date", "dueDate", "deadline"]) {
      if (!Object.hasOwn(patch, field)) continue;
      if (typeof patch[field] !== "string") throw new TypeError(`${field} must be text.`);
      patch[field] = patch[field].trim();
    }
    if (Object.hasOwn(patch, "name") && !patch.name) throw new TypeError("An activity name is required.");
    if (Object.hasOwn(patch, "type") && !["Event", "Session", "Task"].includes(patch.type)
      && patch.type !== String(activity.type ?? "").trim()) throw new TypeError("Choose Event, Session, or Task.");
    for (const field of ["formRequired", "screenshotRequired", "proofRequired"]) {
      if (Object.hasOwn(patch, field) && typeof patch[field] !== "boolean") throw new TypeError(`${field} must be true or false.`);
    }
    if (Object.hasOwn(patch, "proofType")) {
      if (typeof patch.proofType !== "string" || !normalizeProofType(patch.proofType)) throw new TypeError("Choose Screenshot or Form Confirmation for proof type.");
      patch.proofType = normalizeProofType(patch.proofType);
    }
    for (const field of ["date", "dueDate", "deadline"]) {
      if (!Object.hasOwn(patch, field) || patch[field] === "") continue;
      if (!isCalendarDate(patch[field])) throw new TypeError(`Choose a valid ${field === "dueDate" || field === "deadline" ? "Deadline" : field}.`);
    }
    if (Object.hasOwn(patch, "dueDate") || Object.hasOwn(patch, "deadline")) {
      if (Object.hasOwn(patch, "dueDate") && Object.hasOwn(patch, "deadline") && patch.dueDate !== patch.deadline) {
        throw new TypeError("The dueDate and deadline values must agree.");
      }
      const deadline = Object.hasOwn(patch, "dueDate") ? patch.dueDate : patch.deadline;
      patch.dueDate = deadline;
      patch.deadline = deadline;
    }
    if (Object.hasOwn(patch, "targetMembers")) {
      if (!Array.isArray(patch.targetMembers)) throw new TypeError("Target members must be an array of IDs.");
      const members = getMembers();
      const previous = new Set(activity.targetMembers.map(String));
      const seen = new Set();
      patch.targetMembers = patch.targetMembers.filter((id) => {
        if (!isId(id)) throw new TypeError("Target members must contain valid IDs.");
        const key = String(id);
        const member = members.find((candidate) => candidate && String(candidate.id) === key);
        if (!previous.has(key) && (!member || normalizeStatus(member.status) === "archived")) throw new Error("A selected member is unavailable. Refresh the member list and try again.");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    const next = normalizeActivity({ ...activity, ...patch });
    if (JSON.stringify(next) === JSON.stringify(activity)) return activity;
    activities[index] = next;
    saveActivities(activities);
    return next;
  }

  function requireMember(members, memberId) {
    if (!isId(memberId)) throw new TypeError("A valid member ID is required.");
    const index = members.findIndex((member) => isRecord(member) && String(member.id) === String(memberId));
    if (index === -1) throw new Error("This member no longer exists. Refresh the page and try again.");
    return index;
  }

  function archiveMember(memberId, archived = true) {
    if (typeof archived !== "boolean") throw new TypeError("Archived must be true or false.");
    const members = getMembers();
    const index = requireMember(members, memberId);
    const original = members[index];
    const status = archived ? "Archived" : getMemberFollowUpStatus({ ...original, status: "Active" }, getActivities());
    if (original.status === status) return original;
    const next = { ...original, status };
    members[index] = next;
    saveMembers(members);
    return next;
  }

  function archiveActivity(activityId, archived = true) {
    if (typeof archived !== "boolean") throw new TypeError("Archived must be true or false.");
    const activities = getActivities();
    const index = requireActivity(activities, activityId);
    if (activities[index].archived === archived) return activities[index];
    activities[index] = { ...activities[index], archived };
    saveActivities(activities);
    return activities[index];
  }

  function getActivityRecordCount(activity) {
    const normalized = normalizeActivity(activity);
    return isRecord(normalized) ? new Set(normalized.memberStatuses.map((record) => String(record.memberId))).size : 0;
  }

  function deleteActivity(activityId, { force = false } = {}) {
    if (typeof force !== "boolean") throw new TypeError("Force delete must be true or false.");
    const activities = getActivities();
    const index = requireActivity(activities, activityId);
    const removed = activities[index];
    const recordCount = getActivityRecordCount(removed);
    if (recordCount > 0 && !force) throw new Error(`This activity has records for ${recordCount} members. Archive it or confirm Force Delete.`);
    activities.splice(index, 1);
    saveActivities(activities);
    return removed;
  }

  function deleteMember(memberId) {
    const members = getMembers();
    const index = requireMember(members, memberId);
    const removed = members[index];
    const key = String(removed.id);
    const activities = getActivities().map((activity) => {
      if (!isRecord(activity)) return activity;
      return {
        ...activity,
        targetMembers: activity.targetMembers.filter((id) => String(id) !== key),
        memberStatuses: activity.memberStatuses.filter((record) => String(record.memberId) !== key),
      };
    });
    members.splice(index, 1);
    replaceCollections(members, activities, "delete this member");
    return removed;
  }

  function replaceCollections(members, activities, action) {

    // Prepare both writes first. A failed second write must restore the first
    // collection before reporting failure; notify listeners only after commit.
    const changes = [
      { key: "members", value: JSON.stringify(members) },
      { key: "activities", value: JSON.stringify(activities) },
    ];
    try {
      changes.forEach((change) => { change.previous = window.localStorage.getItem(change.key); });
    } catch (error) {
      throw new Error(`YLY Follow-Up: cannot read saved data to ${action}. ${error.message}`);
    }
    const written = [];
    try {
      changes.forEach((change) => {
        window.localStorage.setItem(change.key, change.value);
        written.push(change);
      });
    } catch (error) {
      const rollbackErrors = [];
      written.reverse().forEach((change) => {
        try {
          if (change.previous === null) window.localStorage.removeItem(change.key);
          else window.localStorage.setItem(change.key, change.previous);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError.message);
        }
      });
      const recovery = rollbackErrors.length ? ` Restoring saved data also failed: ${rollbackErrors.join(" ")}` : " Existing data was restored.";
      throw new Error(`YLY Follow-Up: cannot ${action}. ${error.message}${recovery}`);
    }
    changes.forEach((change) => notifyChange(change.key));
  }

  function getBackupData() {
    // Backups include archived entries and inactive assignment history exactly
    // as stored. Reading a backup never rewrites or filters either collection.
    return { members: readArray("members") ?? [], activities: readArray("activities") ?? [] };
  }

  function validateBackupData(backup) {
    if (!isRecord(backup) || !Array.isArray(backup.members) || !Array.isArray(backup.activities)) {
      throw new TypeError("Choose a YLY backup containing members and activities arrays.");
    }

    function requireUniqueId(id, seen, label) {
      if (!isId(id)) throw new TypeError(`${label} needs a non-empty string or numeric ID.`);
      const key = String(id);
      if (seen.has(key)) throw new TypeError(`${label} contains a duplicate ID: ${key}.`);
      seen.add(key);
    }

    function validateTypes(record, fields, type, label) {
      fields.forEach((field) => {
        if (Object.hasOwn(record, field) && typeof record[field] !== type) throw new TypeError(`${label}.${field} must be ${type === "boolean" ? "true or false" : "text"}.`);
      });
    }

    function validateStatusFields(record, label) {
      validateTypes(record, ["status", "selection", "finalStatus", "excuseReason", "reason", "proofType", "date", "timestamp", "submissionDate"], "string", label);
      validateTypes(record, ["applied", "proofReceived", "applicationProofReceived", "attendanceProofReceived", "isLate"], "boolean", label);
      if (Object.hasOwn(record, "submissionDate") && !isCalendarDate(record.submissionDate)) throw new TypeError(`${label}.submissionDate must be a valid calendar date.`);
      if (Object.hasOwn(record, "timeliness") && !["on-time", "late"].includes(record.timeliness)) {
        throw new TypeError(`${label}.timeliness must be "on-time" or "late".`);
      }
    }

    function validateAssignment(record, seen, label) {
      if (!isRecord(record)) throw new TypeError(`${label} must contain member status objects.`);
      requireUniqueId(record.memberId, seen, label);
      validateStatusFields(record, label);
      if (Object.hasOwn(record, "history")) {
        if (!Array.isArray(record.history)) throw new TypeError(`${label}.history must be an array.`);
        record.history.forEach((step) => {
          if (typeof step === "string") return;
          if (!isRecord(step)) throw new TypeError(`${label}.history must contain status text or timeline objects.`);
          validateStatusFields(step, `${label}.history`);
        });
      }
    }

    const memberIds = new Set();
    backup.members.forEach((member) => {
      if (!isRecord(member)) throw new TypeError("Members must contain member objects.");
      requireUniqueId(member.id, memberIds, "Members");
      validateTypes(member, ["name", "committee", "status", "joinedDate"], "string", "Member");
    });

    const activityIds = new Set();
    backup.activities.forEach((activity) => {
      if (!isRecord(activity)) throw new TypeError("Activities must contain activity objects.");
      requireUniqueId(activity.id, activityIds, "Activities");
      validateTypes(activity, ["name", "type", "source", "committee", "status", "date", "deadline", "dueDate", "proofType"], "string", "Activity");
      if (Object.hasOwn(activity, "dueDate") && activity.dueDate !== "" && !isCalendarDate(activity.dueDate)) throw new TypeError("Activity.dueDate must be a valid calendar date.");
      validateTypes(activity, ["archived", "isArchived", "proofRequired", "screenshotRequired", "formRequired"], "boolean", "Activity");
      if (!Object.hasOwn(activity, "targetMembers") && !Object.hasOwn(activity, "memberStatuses")) {
        throw new TypeError("Each activity needs a targetMembers or memberStatuses array.");
      }
      for (const field of ["targetMembers", "memberStatuses"]) {
        if (!Object.hasOwn(activity, field)) continue;
        if (!Array.isArray(activity[field])) throw new TypeError(`Activity.${field} must be an array.`);
        const seen = new Set();
        activity[field].forEach((record) => {
          if (field === "targetMembers" && !isRecord(record)) requireUniqueId(record, seen, "Activity.targetMembers");
          else validateAssignment(record, seen, `Activity.${field}`);
        });
      }
      // Missing member IDs can refer to preserved historic or inactive records;
      // they are intentionally not rejected or silently removed during restore.
    });
  }

  function restoreBackupData(backup) {
    validateBackupData(backup);
    // Clone before normalization so callers and extension fields stay intact.
    const restored = JSON.parse(JSON.stringify(backup));
    restored.activities = restored.activities.map(normalizeActivity);
    replaceCollections(restored.members, restored.activities, "restore this backup");
    return { members: restored.members, activities: restored.activities };
  }

  // Public API for this dashboard and the other application pages.
  window.YLYData = {
    initializeData,
    getMembers,
    saveMembers,
    getActivities,
    saveActivities,
    getActivityMemberStatuses,
    getActivityProofSettings,
    getActivityDeadline,
    getActivityRecordCount,
    getMemberActivityProgress,
    getMemberFollowUpStatus,
    isMemberArchived,
    isActivityArchived,
    updateMemberActivityStatus,
    updateActivity,
    archiveMember,
    archiveActivity,
    deleteMember,
    deleteActivity,
    getBackupData,
    restoreBackupData,
  };

  initializeData();
})();
