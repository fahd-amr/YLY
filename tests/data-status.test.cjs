const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../js/data.js"), "utf8");
const members = [
  { id: 1, name: "Habiba", status: "Needs Follow-up", committee: "SM" },
  { id: 2, name: "Maha", status: "Up to date", committee: "SM" },
  { id: 3, name: "Jihad", status: "Archived", committee: "SM" },
  { id: 4, name: "Salma", status: "Up to date", committee: "SM" },
];

function activity(overrides = {}) {
  return {
    id: 10, name: "Content ideas", type: "Task", source: "SM",
    date: "2026-09-20", dueDate: "2026-09-22", deadline: "2026-09-22",
    formRequired: false, screenshotRequired: false,
    proofRequired: false, proofType: "screenshot",
    targetMembers: [1, 2],
    memberStatuses: [
      { memberId: 1, status: "pending" },
      { memberId: 2, status: "done", history: [{ status: "done", date: "2026-09-21" }], note: "Keep this" },
    ],
    ...overrides,
  };
}

function setup(initial = { members, activities: [activity()] }) {
  const stored = new Map(Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]));
  const writes = [];
  const events = [];
  const controls = { failRead: false, failWrite: false, failNotify: false, failWriteKey: "", failWriteOnce: false };
  const window = {
    localStorage: {
      getItem(key) {
        if (controls.failRead) throw new Error("Storage denied");
        return stored.has(key) ? stored.get(key) : null;
      },
      setItem(key, value) {
        if (controls.failWrite) throw new Error("Quota exceeded");
        if (controls.failWriteKey === key) {
          if (controls.failWriteOnce) controls.failWriteKey = "";
          throw new Error("Quota exceeded for " + key);
        }
        stored.set(key, value);
        writes.push({ key, value });
      },
      removeItem(key) { stored.delete(key); },
    },
    CustomEvent: class CustomEvent {
      constructor(type, { detail }) { this.type = type; this.detail = detail; }
    },
    dispatchEvent(event) {
      if (controls.failNotify) throw new Error("Notification failed");
      events.push(event);
    },
  };
  vm.runInNewContext(source, { window });
  return { api: window.YLYData, stored, writes, events, controls };
}

const plain = (value) => JSON.parse(JSON.stringify(value));

test("new installations seed only canonical member status arrays", () => {
  const { api, writes } = setup({});
  assert.equal(writes.length, 2);
  assert.equal(api.getMembers().length, 3);
  for (const entry of api.getActivities()) {
    assert.ok(entry.targetMembers.every((id) => typeof id === "number"));
    assert.equal(entry.memberStatuses.length, entry.targetMembers.length);
  }
});

test("initialization preserves intentionally empty storage", () => {
  const { api, writes } = setup({ members: [], activities: [] });
  api.initializeData();
  assert.equal(writes.length, 0);
  assert.deepEqual(plain(api.getActivities()), []);
});

test("legacy migration is idempotent and preserves assignment metadata", () => {
  const legacy = activity({ targetMembers: [
    { memberId: 1, status: "excuse", reason: "Family", proofReceived: true, history: ["applied", "selected"] },
    { memberId: 2, status: "done", note: "Original note" },
  ] });
  delete legacy.memberStatuses;
  const { api, stored, writes } = setup({ members, activities: [legacy] });
  const migrated = api.getActivities()[0];
  assert.deepEqual(plain(migrated.targetMembers), [1, 2]);
  assert.deepEqual(plain(migrated.memberStatuses), legacy.targetMembers.map((record) =>
    Object.hasOwn(record, "proofReceived") ? { ...record, proofType: "screenshot" } : record));
  const snapshot = stored.get("activities");
  api.initializeData();
  assert.equal(stored.get("activities"), snapshot);
  assert.equal(writes.length, 1);
});

test("mixed migration prefers canonical fields and retains legacy extensions and inactive records", () => {
  const { api } = setup({ members, activities: [activity({
    targetMembers: [{ memberId: 1, status: "pending", reason: "Legacy reason", history: ["applied"] }, 2],
    memberStatuses: [
      { memberId: "1", status: "attended", proofReceived: true },
      { memberId: 4, status: "done", note: "Removed target" },
    ],
  })] });
  const saved = api.getActivities()[0];
  assert.deepEqual(plain(saved.targetMembers), [1, 2]);
  const active = plain(api.getActivityMemberStatuses(saved));
  assert.equal(active.length, 2);
  assert.deepEqual(active[0], { memberId: "1", status: "attended", reason: "Legacy reason", history: ["applied"], proofReceived: true, proofType: "screenshot" });
  assert.deepEqual(active[1], { memberId: 2, status: "pending" });
  assert.equal(saved.memberStatuses.find((entry) => entry.memberId === 4).note, "Removed target");
});

test("helpers normalize legacy callers without mutating their objects", () => {
  const { api } = setup();
  const legacy = { type: "Task", targetMembers: [{ memberId: 1, status: "pending" }] };
  const before = JSON.stringify(legacy);
  assert.equal(api.getActivityMemberStatuses(legacy)[0].memberId, 1);
  assert.equal(JSON.stringify(legacy), before);
});

test("a status update changes only the selected assignment and preserves all other stored data", () => {
  const { api, stored, writes, events } = setup({ members, activities: [activity(), activity({ id: 11, name: "Other task" })] });
  const beforeMembers = stored.get("members");
  const before = JSON.parse(stored.get("activities"));
  const result = api.updateMemberActivityStatus("10", "1", { status: "done", proofReceived: true });
  const after = JSON.parse(stored.get("activities"));
  assert.equal(result.status, "done");
  assert.equal(after[0].memberStatuses[0].proofReceived, true);
  assert.deepEqual(after[0].memberStatuses[1], before[0].memberStatuses[1]);
  assert.deepEqual(after[1], before[1]);
  assert.deepEqual({ ...after[0], memberStatuses: undefined }, { ...before[0], memberStatuses: undefined });
  assert.equal(stored.get("members"), beforeMembers);
  assert.equal(writes.length, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "yly:data-changed");
  assert.equal(events[0].detail.key, "activities");
  assert.ok(Number.isFinite(Date.parse(result.history[0].date)));
});

test("empty and repeated updates do not write or duplicate history", () => {
  const { api, stored, writes } = setup();
  const initial = stored.get("activities");
  api.updateMemberActivityStatus(10, 1, {});
  api.updateMemberActivityStatus(10, 1, { status: "pending" });
  assert.equal(stored.get("activities"), initial);
  assert.equal(writes.length, 0);
  api.updateMemberActivityStatus(10, 1, { status: "done", proofReceived: true });
  const saved = stored.get("activities");
  api.updateMemberActivityStatus(10, 1, { status: "done", proofReceived: true });
  assert.equal(stored.get("activities"), saved);
  assert.equal(writes.length, 1);
});

test("storage failures preserve saved data and do not emit change notifications", () => {
  const { api, stored, controls, events } = setup();
  const before = stored.get("activities");
  controls.failWrite = true;
  assert.throws(() => api.updateMemberActivityStatus(10, 1, { status: "done" }), /cannot save/);
  assert.equal(stored.get("activities"), before);
  assert.equal(events.length, 0);
  controls.failWrite = false;
  controls.failRead = true;
  assert.throws(() => api.updateMemberActivityStatus(10, 1, { status: "done" }), /cannot read/);
  assert.equal(stored.get("activities"), before);
});

test("a UI notification failure does not disguise a successfully persisted update", () => {
  const { api, controls } = setup();
  controls.failNotify = true;
  assert.equal(api.updateMemberActivityStatus(10, 1, { status: "done" }).status, "done");
  assert.equal(api.getActivities()[0].memberStatuses[0].status, "done");
});

test("event branches clear irrelevant current values and retain recorded history", () => {
  const { api } = setup({ members, activities: [activity({ type: "Event" })] });
  const excused = api.updateMemberActivityStatus(10, 1, {
    applied: true, selection: "selected", finalStatus: "excuse", excuseReason: "Family issue",
  });
  assert.equal(excused.status, "excused");
  assert.equal(excused.history[0].selection, "selected");
  assert.equal(api.getMemberActivityProgress(api.getActivities()[0], excused).pending, false);
  const notSelected = api.updateMemberActivityStatus(10, 1, {
    applied: true, selection: "not selected", finalStatus: "excused", excuseReason: "Stale reason",
  });
  assert.equal(notSelected.status, "not_selected");
  assert.equal(notSelected.finalStatus, "");
  assert.equal(notSelected.excuseReason, "");
  const pending = api.updateMemberActivityStatus(10, 1, {
    applied: false, selection: "selected", finalStatus: "attended", excuseReason: "Stale reason",
  });
  assert.equal(pending.status, "pending");
  assert.equal(pending.selection, "");
  assert.equal(pending.finalStatus, "");
  assert.equal(pending.excuseReason, "");
  assert.equal(pending.history.length, 3);
  assert.equal(pending.history[0].excuseReason, "Family issue");
  const progress = api.getMemberActivityProgress(api.getActivities()[0], pending);
  assert.equal(progress.pending, true);
  assert.equal(progress.applied, false);
  assert.equal(progress.selection, "");
});

test("event pending selection and pending final attendance both remain follow-ups", () => {
  const { api } = setup({ members, activities: [activity({ type: "Event" })] });
  let record = api.updateMemberActivityStatus(10, 1, { applied: true, selection: "", finalStatus: "", excuseReason: "" });
  assert.equal(record.status, "applied");
  assert.equal(api.getMemberActivityProgress(api.getActivities()[0], record).pending, true);
  record = api.updateMemberActivityStatus(10, 1, { applied: true, selection: "selected", finalStatus: "", excuseReason: "" });
  assert.equal(record.status, "pending");
  assert.equal(record.finalStatus, "pending");
  assert.equal(api.getMemberActivityProgress(api.getActivities()[0], record).pending, true);
});

test("session excuse reason clears when its status changes", () => {
  const { api } = setup({ members, activities: [activity({ type: "Session" })] });
  const excused = api.updateMemberActivityStatus(10, 1, { status: "Excuse", reason: "  Family  " });
  assert.equal(excused.excuseReason, "Family");
  const attended = api.updateMemberActivityStatus(10, 1, { status: "attended" });
  assert.equal(attended.excuseReason, "");
  assert.equal(api.getMemberActivityProgress(api.getActivities()[0], attended).completed, true);
});

test("task excuses retain an existing reason until their status changes", () => {
  const initial = activity({ memberStatuses: [{ memberId: 1, status: "excused", reason: "Family" }, { memberId: 2, status: "done" }] });
  const { api } = setup({ members, activities: [initial] });
  let record = api.updateMemberActivityStatus(10, 1, { status: "excused", proofReceived: false });
  assert.equal(record.reason, "Family");
  record = api.updateMemberActivityStatus(10, 1, { status: "pending" });
  assert.equal(record.reason, "");
});

test("proof requirements distinguish unknown legacy proof from explicitly missing proof", () => {
  const { api } = setup();
  const required = activity({ screenshotRequired: true, proofRequired: true });
  let progress = api.getMemberActivityProgress(required, { status: "completed" });
  assert.equal(progress.status, "done");
  assert.equal(progress.completed, true);
  progress = api.getMemberActivityProgress(required, { status: "done", proofReceived: false });
  assert.equal(progress.status, "pending_proof");
  assert.equal(progress.pending, true);
  assert.equal(progress.completed, false);
  assert.equal(api.getMemberActivityProgress(required, { status: "done", proofReceived: true }).completed, true);
  assert.equal(api.getMemberActivityProgress(activity(), { status: "done", proofReceived: false }).completed, true);
});

test("legacy event progress never invents Applied or Selected history from attendance", () => {
  const { api } = setup();
  const event = activity({ type: "Event" });
  const attended = { memberId: 1, status: "attended" };
  const before = JSON.stringify(attended);
  let progress = api.getMemberActivityProgress(event, attended);
  assert.equal(progress.applied, null);
  assert.equal(progress.selection, "");
  assert.equal(progress.completed, true);
  assert.equal(JSON.stringify(attended), before);
  progress = api.getMemberActivityProgress(event, { status: "excused", history: ["applied", { status: "selected" }] });
  assert.equal(progress.applied, true);
  assert.equal(progress.selection, "selected");
  assert.equal(progress.completed, false);
});

test("follow-up status derives from active assignments and retains Archived", () => {
  const { api } = setup();
  const activities = api.getActivities();
  assert.equal(api.getMemberFollowUpStatus(members[0], activities), "Needs Follow-up");
  assert.equal(api.getMemberFollowUpStatus(members[1], activities), "Up to date");
  assert.equal(api.getMemberFollowUpStatus(members[2], activities), "Archived");
  api.updateMemberActivityStatus(10, 1, { status: "done" });
  assert.equal(api.getMemberFollowUpStatus(members[0], api.getActivities()), "Up to date");
  assert.equal(api.getMembers()[0].status, "Needs Follow-up", "derived status must not overwrite member metadata");
});

test("invalid assignment IDs, protected fields, and invalid values cannot write", () => {
  const { api, stored, writes } = setup();
  const before = stored.get("activities");
  const invalid = [
    () => api.updateMemberActivityStatus(999, 1, { status: "done" }),
    () => api.updateMemberActivityStatus(10, 999, { status: "done" }),
    () => api.updateMemberActivityStatus(10, 4, { status: "done" }),
    () => api.updateMemberActivityStatus(10, null, { status: "done" }),
    () => api.updateMemberActivityStatus(10, 1, { memberId: 2 }),
    () => api.updateMemberActivityStatus(10, 1, { history: [] }),
    () => api.updateMemberActivityStatus(10, 1, { type: "Session" }),
    () => api.updateMemberActivityStatus(10, 1, { status: "attended" }),
    () => api.updateMemberActivityStatus(10, 1, { proofReceived: "false" }),
    () => api.updateMemberActivityStatus(10, 1, { excuseReason: {} }),
    () => api.updateMemberActivityStatus(10, 1, { applied: true }),
    () => api.updateMemberActivityStatus(10, 1, []),
  ];
  for (const update of invalid) assert.throws(update);
  assert.equal(stored.get("activities"), before);
  assert.equal(writes.length, 0);
});

test("invalid event fields are rejected before any state is saved", () => {
  const { api, writes } = setup({ members, activities: [activity({ type: "Event" })] });
  for (const patch of [
    { applied: "true" }, { applied: true, selection: "maybe" },
    { applied: true, selection: "selected", finalStatus: "done" },
    { selection: "selected" }, { status: "attended" }, { proofReceived: true },
  ]) assert.throws(() => api.updateMemberActivityStatus(10, 1, patch));
  assert.equal(writes.length, 0);
});

test("activity metadata edits merge against the latest saved progress", () => {
  const { api, stored } = setup();
  const staleActivity = api.getActivities()[0];
  api.updateMemberActivityStatus(10, 1, { status: "done", proofReceived: true });
  const latestStatuses = JSON.stringify(api.getActivities()[0].memberStatuses);
  const edited = api.updateActivity(10, {
    name: "Revised content ideas", type: "Session", source: "General",
    date: "2026-09-25", targetMembers: staleActivity.targetMembers,
  });
  assert.equal(edited.name, "Revised content ideas");
  assert.equal(edited.type, "Session");
  assert.equal(JSON.stringify(edited.memberStatuses), latestStatuses);
  assert.equal(stored.get("members"), JSON.stringify(members));
  assert.throws(() => api.updateActivity(10, { memberStatuses: staleActivity.memberStatuses }), /Cannot update/);
});

test("adding, removing, and re-adding targets preserves progress and defaults only new assignments", () => {
  const { api } = setup();
  api.updateMemberActivityStatus(10, 1, { status: "done", proofReceived: true });
  const original = JSON.stringify(api.getActivities()[0].memberStatuses[0]);
  let updated = api.updateActivity(10, { targetMembers: [2, 4] });
  assert.deepEqual(plain(api.getActivityMemberStatuses(updated)).map((record) => record.memberId), [2, 4]);
  assert.equal(updated.memberStatuses.find((record) => record.memberId === 4).status, "pending");
  assert.equal(JSON.stringify(updated.memberStatuses.find((record) => record.memberId === 1)), original);
  assert.equal(api.getMemberFollowUpStatus(members[0], [updated]), "Up to date");
  assert.throws(() => api.updateMemberActivityStatus(10, 1, { status: "pending" }), /no longer assigned/);
  updated = api.updateActivity(10, { targetMembers: [1, 2, 4] });
  assert.equal(JSON.stringify(api.getActivityMemberStatuses(updated).find((record) => record.memberId === 1)), original);
});

test("retained archived and missing targets are allowed, but new unavailable targets are rejected", () => {
  const { api } = setup({ members, activities: [activity({ targetMembers: [1, 3, 999] })] });
  assert.doesNotThrow(() => api.updateActivity(10, { name: "Edited", targetMembers: [1, 3, 999] }));
  api.updateActivity(10, { targetMembers: [1] });
  assert.throws(() => api.updateActivity(10, { targetMembers: [1, 3] }), /unavailable/);
  assert.throws(() => api.updateActivity(10, { targetMembers: [1, 999] }), /unavailable/);
});

test("invalid metadata edits preserve storage, including impossible calendar dates", () => {
  const { api, writes, stored } = setup();
  const before = stored.get("activities");
  for (const patch of [
    { id: 999 }, { name: " " }, { type: "Meeting" }, { date: "2026-02-31" },
    { deadline: "tomorrow" }, { screenshotRequired: "true" },
    { targetMembers: [1, { memberId: 2 }] }, { source: false },
  ]) assert.throws(() => api.updateActivity(10, patch));
  assert.equal(stored.get("activities"), before);
  assert.equal(writes.length, 0);
});

test("saveActivities canonicalizes legacy callers without retaining a second status source", () => {
  const { api } = setup();
  api.saveActivities([{ id: 1, type: "Task", targetMembers: [{ memberId: 1, status: "done" }] }]);
  const saved = api.getActivities()[0];
  assert.deepEqual(plain(saved.targetMembers), [1]);
  assert.deepEqual(plain(saved.memberStatuses), [{ memberId: 1, status: "done" }]);
});

test("malformed stored data is reported without resetting either collection", () => {
  const { api, stored, writes } = setup();
  stored.set("activities", "invalid json");
  assert.throws(() => api.initializeData(), /invalid JSON/);
  assert.equal(stored.get("activities"), "invalid json");
  assert.equal(stored.get("members"), JSON.stringify(members));
  assert.equal(writes.length, 0);
});

test("proof settings migrate legacy requirements without erasing them and honor explicit No", () => {
  const legacy = activity({ formRequired: true, screenshotRequired: false });
  delete legacy.proofRequired;
  delete legacy.proofType;
  const { api, writes } = setup({ members, activities: [legacy] });
  const saved = api.getActivities()[0];
  assert.deepEqual(plain(api.getActivityProofSettings(saved)), { required: true, type: "form_confirmation" });
  assert.equal(saved.formRequired, true);
  assert.equal(saved.screenshotRequired, false);
  api.initializeData();
  assert.equal(writes.length, 1, "migration must run only once");
  assert.deepEqual(plain(api.getActivityProofSettings({ screenshotRequired: true, formRequired: true })), { required: true, type: "screenshot" });
  assert.deepEqual(plain(api.getActivityProofSettings({ proofRequired: false, screenshotRequired: true, proofType: "Form Confirmation" })), { required: false, type: "form_confirmation" });
  const explicitNo = activity({ proofRequired: false, screenshotRequired: true });
  assert.equal(api.getMemberActivityProgress(explicitNo, { status: "done", proofReceived: false }).completed, true);
});

test("proof metadata validation preserves assignment history and legacy fields", () => {
  const { api, stored, writes } = setup();
  const before = JSON.stringify(api.getActivities()[0].memberStatuses);
  const updated = api.updateActivity(10, { proofRequired: true, proofType: "Form Confirmation" });
  assert.equal(updated.proofRequired, true);
  assert.equal(updated.proofType, "form_confirmation");
  assert.equal(updated.screenshotRequired, false);
  assert.equal(JSON.stringify(updated.memberStatuses), before);
  const snapshot = stored.get("activities");
  for (const patch of [{ proofRequired: "yes" }, { proofType: "photo album" }, { proofType: 1 }]) {
    assert.throws(() => api.updateActivity(10, patch));
  }
  assert.equal(stored.get("activities"), snapshot);
  assert.equal(writes.length, 1);
});

test("proof is contextual and separately tracked at both event stages", () => {
  const { api } = setup();
  const event = activity({ type: "Event", proofRequired: true });
  let progress = api.getMemberActivityProgress(event, {
    status: "attended", applied: true, selection: "selected", finalStatus: "attended",
    applicationProofReceived: false, attendanceProofReceived: false,
  });
  assert.equal(progress.outcome, "attended");
  assert.equal(progress.status, "pending_proof");
  assert.equal(progress.pending, true);
  assert.equal(progress.completed, false);
  assert.deepEqual(plain(progress.pendingProofStages), ["application", "attendance"]);
  progress = api.getMemberActivityProgress(event, {
    applied: true, selection: "selected", finalStatus: "attended",
    applicationProofReceived: true, attendanceProofReceived: false,
  });
  assert.deepEqual(plain(progress.pendingProofStages), ["attendance"]);
  progress = api.getMemberActivityProgress(event, {
    applied: true, selection: "not_selected", applicationProofReceived: false, attendanceProofReceived: false,
  });
  assert.deepEqual(plain(progress.pendingProofStages), ["application"]);
  progress = api.getMemberActivityProgress(event, {
    applied: false, selection: "selected", finalStatus: "attended",
    applicationProofReceived: false, attendanceProofReceived: false,
  });
  assert.equal(progress.proofPending, false);
  assert.equal(progress.status, "pending");
  progress = api.getMemberActivityProgress(event, {
    applied: true, selection: "selected", finalStatus: "excused",
    applicationProofReceived: true, attendanceProofReceived: false,
  });
  assert.equal(progress.proofPending, false);
  assert.equal(progress.pending, false);
  progress = api.getMemberActivityProgress(event, { status: "attended" });
  assert.equal(progress.completed, true, "legacy attendance must not invent missing stage receipts");
  const task = activity({ proofRequired: true });
  assert.equal(api.getMemberActivityProgress(task, { status: "pending", proofReceived: false }).proofPending, false);
  assert.equal(api.getMemberActivityProgress(task, { status: "excused", proofReceived: false }).pending, false);
  const session = activity({ type: "Session", proofRequired: true });
  assert.equal(api.getMemberActivityProgress(session, { status: "attended", proofReceived: false }).completed, true);
});

test("changing proof type cannot silently reuse another type's recorded receipt", () => {
  const { api } = setup({ members, activities: [activity({ type: "Event", proofRequired: true })] });
  api.updateMemberActivityStatus(10, 1, {
    applied: true, selection: "selected", finalStatus: "attended",
    applicationProofReceived: true, attendanceProofReceived: true,
  });
  const changed = api.updateActivity(10, { proofType: "form_confirmation" });
  let record = changed.memberStatuses[0];
  assert.equal(record.proofType, "screenshot");
  assert.deepEqual(plain(api.getMemberActivityProgress(changed, record).pendingProofStages), ["application", "attendance"]);
  record = api.updateMemberActivityStatus(10, 1, { attendanceProofReceived: true });
  assert.equal(record.proofType, "form_confirmation");
  assert.equal(record.applicationProofReceived, false);
  assert.equal(record.attendanceProofReceived, true);
  assert.deepEqual(plain(api.getMemberActivityProgress(changed, record).pendingProofStages), ["application"]);
  record = api.updateMemberActivityStatus(10, 1, { applicationProofReceived: true });
  assert.equal(api.getMemberActivityProgress(changed, record).completed, true);
  assert.equal(record.history[0].proofType, "screenshot");
  assert.equal(record.history[0].applicationProofReceived, true);
});

test("legacy known receipts are bound to their original proof type before metadata changes", () => {
  for (const type of ["Task", "Event"]) {
    const legacyRecord = type === "Task"
      ? { memberId: 1, status: "done", proofReceived: true }
      : { memberId: 1, status: "attended", applied: true, selection: "selected", finalStatus: "attended", applicationProofReceived: true, attendanceProofReceived: true };
    const initial = activity({ type, proofRequired: true, memberStatuses: [legacyRecord, { memberId: 2, status: "pending" }] });
    const { api, writes } = setup({ members, activities: [initial] });
    const normalized = api.getActivities()[0];
    assert.equal(normalized.memberStatuses[0].proofType, "screenshot");
    assert.equal(Object.hasOwn(normalized.memberStatuses[1], "proofType"), false);
    api.initializeData();
    assert.equal(writes.length, 1);
    const changed = api.updateActivity(10, { proofType: "form_confirmation" });
    const progress = api.getMemberActivityProgress(changed, changed.memberStatuses[0]);
    assert.equal(progress.completed, false);
    assert.equal(progress.proofPending, true);
    assert.deepEqual(plain(progress.pendingProofStages), type === "Task" ? ["task"] : ["application", "attendance"]);
    assert.deepEqual(plain(changed.memberStatuses[0]), { ...legacyRecord, proofType: "screenshot" });
  }
});

test("event updates clear hidden dependent receipts and preserve their previous history", () => {
  const { api } = setup({ members, activities: [activity({ type: "Event", proofRequired: true })] });
  const otherBefore = JSON.stringify(api.getActivities()[0].memberStatuses[1]);
  api.updateMemberActivityStatus(10, 1, {
    applied: true, selection: "selected", finalStatus: "attended",
    applicationProofReceived: true, attendanceProofReceived: true,
  });
  let record = api.updateMemberActivityStatus(10, 1, { selection: "not_selected" });
  assert.equal(record.applicationProofReceived, true);
  assert.equal(Object.hasOwn(record, "attendanceProofReceived"), false);
  assert.equal(record.history[0].attendanceProofReceived, true);
  record = api.updateMemberActivityStatus(10, 1, { applied: false });
  assert.equal(Object.hasOwn(record, "applicationProofReceived"), false);
  assert.equal(Object.hasOwn(record, "attendanceProofReceived"), false);
  assert.equal(JSON.stringify(api.getActivities()[0].memberStatuses[1]), otherBefore);
  assert.match(record.history[0].date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Number.isFinite(Date.parse(record.history[0].timestamp)));
  record = api.updateMemberActivityStatus(10, 1, { applied: true, selection: "Pending Selection" });
  assert.equal(record.selection, "");
  assert.equal(record.status, "applied");
  for (const patch of [{ applicationProofReceived: 1 }, { attendanceProofReceived: "false" }]) {
    assert.throws(() => api.updateMemberActivityStatus(10, 1, patch));
  }
});

test("task proof is cleared outside Done while excuses retain their reason", () => {
  const { api } = setup({ members, activities: [activity({ type: " Task ", proofRequired: true })] });
  let record = api.updateMemberActivityStatus(10, 1, { status: "done", proofReceived: true });
  assert.equal(api.getMemberActivityProgress(api.getActivities()[0], record).completed, true);
  record = api.updateMemberActivityStatus(10, 1, { status: "Excuse", excuseReason: " Family " });
  assert.equal(record.excuseReason, "Family");
  assert.equal(Object.hasOwn(record, "proofReceived"), false);
  assert.equal(record.history[0].proofReceived, true);
  assert.equal(api.getMemberActivityProgress(api.getActivities()[0], record).pending, false);
});

test("a type change preserves old statuses but treats incompatible outcomes as pending", () => {
  const { api } = setup();
  const before = JSON.stringify(api.getActivities()[0].memberStatuses);
  const changed = api.updateActivity(10, { type: "Session" });
  const record = changed.memberStatuses.find((entry) => entry.memberId === 2);
  assert.equal(JSON.stringify(changed.memberStatuses), before);
  assert.equal(record.status, "done");
  assert.equal(api.getMemberActivityProgress(changed, record).outcome, "pending");
  assert.equal(api.getMemberActivityProgress(changed, record).pending, true);
  assert.equal(api.getMemberActivityProgress(activity({ type: "Event" }), {
    status: "done", applied: true, selection: "selected", finalStatus: "attended",
  }).pending, true, "incompatible current outcome must not revive stale event fields");
});

test("metadata edits retain an existing legacy type without introducing new unsupported types", () => {
  const { api } = setup({ members, activities: [activity({ type: "Legacy Workshop" })] });
  const updated = api.updateActivity(10, { name: "Revised workshop", type: "Legacy Workshop" });
  assert.equal(updated.name, "Revised workshop");
  assert.equal(updated.type, "Legacy Workshop");
  assert.throws(() => api.updateActivity(10, { type: "Another Legacy Type" }), /Choose Event/);
  assert.doesNotThrow(() => api.updateActivity(10, { type: "Session" }));
});

test("archiving preserves all records, removes pending follow-ups, and can be restored", () => {
  const { api, stored } = setup();
  const beforeActivity = api.getActivities()[0];
  const beforeMembers = stored.get("members");
  const archived = api.archiveActivity(10);
  assert.equal(api.isActivityArchived(archived), true);
  assert.deepEqual(plain(archived), { ...plain(beforeActivity), archived: true });
  assert.equal(api.getActivities().length, 1);
  assert.equal(api.getActivityMemberStatuses(archived).length, 2);
  assert.equal(api.getMemberFollowUpStatus(members[0], api.getActivities()), "Up to date");
  assert.equal(stored.get("members"), beforeMembers);
  assert.throws(() => api.updateMemberActivityStatus(10, 1, { status: "done" }), /read-only/);
  api.archiveActivity(10, false);
  assert.equal(api.getMemberFollowUpStatus(members[0], api.getActivities()), "Needs Follow-up");
  const beforeStatuses = stored.get("activities");
  const archivedMember = api.archiveMember(1);
  assert.equal(api.isMemberArchived(archivedMember), true);
  assert.deepEqual(plain(archivedMember), { ...members[0], status: "Archived" });
  assert.equal(stored.get("activities"), beforeStatuses);
  assert.throws(() => api.updateMemberActivityStatus(10, 1, { status: "done" }), /read-only/);
  assert.equal(api.archiveMember(1, false).status, "Needs Follow-up");
  assert.equal(api.isMemberArchived({ status: "  archived  " }), true);
  assert.equal(api.isActivityArchived({ status: "Archived" }), true);
  assert.equal(api.isActivityArchived({ archived: false, isArchived: true }), false);
});

test("activity deletion counts inactive records and requires explicit force for latest data", () => {
  const initial = activity({ targetMembers: [], memberStatuses: [
    { memberId: 1, status: "done" }, { memberId: "1", status: "done" }, { memberId: 4, status: "pending" },
  ] });
  const { api, stored } = setup({ members, activities: [initial, activity({ id: 11, targetMembers: [], memberStatuses: [] })] });
  assert.equal(api.getActivityRecordCount(api.getActivities()[0]), 2);
  const before = stored.get("activities");
  assert.throws(() => api.deleteActivity(10), /records for 2 members/);
  assert.equal(stored.get("activities"), before);
  const untouched = api.getActivities()[1];
  api.deleteActivity("10", { force: true });
  assert.deepEqual(plain(api.getActivities()), [plain(untouched)]);
  assert.equal(stored.get("members"), JSON.stringify(members));
  const oldEmpty = api.getActivities()[0];
  api.updateActivity(11, { targetMembers: [1] });
  assert.equal(api.getActivityRecordCount(oldEmpty), 0);
  assert.throws(() => api.deleteActivity(11), /records for 1 members/);
  api.deleteActivity(11, { force: true });
  api.saveActivities([activity({ id: 12, targetMembers: [], memberStatuses: [] })]);
  assert.equal(api.deleteActivity(12).id, 12);
  assert.equal(api.getActivities().length, 0);
});

test("deleting a member removes active and inactive history without changing anyone else", () => {
  const { api, stored, events } = setup({ members, activities: [
    activity(), activity({ id: 11, archived: true, targetMembers: [2] }),
    activity({ id: 12, targetMembers: [4], memberStatuses: [{ memberId: 4, status: "done", history: ["done"] }] }),
  ] });
  const before = plain(api.getActivities());
  assert.equal(api.deleteMember("1").id, 1);
  assert.deepEqual(plain(api.getMembers()), members.filter((member) => member.id !== 1));
  const after = plain(api.getActivities());
  for (let index = 0; index < after.length; index += 1) {
    assert.deepEqual(after[index], {
      ...before[index],
      targetMembers: before[index].targetMembers.filter((id) => String(id) !== "1"),
      memberStatuses: before[index].memberStatuses.filter((record) => String(record.memberId) !== "1"),
    });
  }
  assert.deepEqual(events.map((event) => event.detail.key), ["members", "activities"]);
  assert.equal(JSON.parse(stored.get("activities"))[1].archived, true);
});

test("a failed member deletion rolls back both collections and emits no success event", () => {
  const { api, stored, controls, events } = setup();
  const beforeMembers = stored.get("members");
  const beforeActivities = stored.get("activities");
  controls.failWriteKey = "activities";
  assert.throws(() => api.deleteMember(1), /cannot delete.*Existing data was restored/);
  assert.equal(stored.get("members"), beforeMembers);
  assert.equal(stored.get("activities"), beforeActivities);
  assert.equal(events.length, 0);
  controls.failWriteKey = "members";
  assert.throws(() => api.deleteMember(1), /cannot delete/);
  assert.equal(stored.get("members"), beforeMembers);
  assert.equal(stored.get("activities"), beforeActivities);
  controls.failWriteKey = "";
  assert.throws(() => api.deleteMember(999), /no longer exists/);
  api.deleteMember(1);
  assert.equal(api.getMembers().some((member) => member.id === 1), false);
});

test("task lateness uses strict calendar-day comparison and ignores caller-supplied flags", () => {
  for (const [submissionDate, expected] of [["2026-09-21", false], ["2026-09-22", false], ["2026-09-23", true]]) {
    const { api } = setup();
    const record = api.updateMemberActivityStatus(10, 1, { status: "done", submissionDate, isLate: !expected });
    assert.equal(record.submissionDate, submissionDate);
    assert.equal(record.isLate, expected);
    assert.equal(record.history[0].submissionDate, submissionDate);
    assert.equal(record.history[0].isLate, expected);
    assert.equal(api.getMemberActivityProgress(api.getActivities()[0], record).completed, true);
    assert.equal(Object.hasOwn(record, "timeliness"), false);
  }
});

test("transitioning a task to Done defaults to today's UTC date but repeated saves retain its date", () => {
  const { api, writes } = setup();
  const before = new Date().toISOString().split("T")[0];
  const record = api.updateMemberActivityStatus(10, 1, { status: "done" });
  const after = new Date().toISOString().split("T")[0];
  assert.ok([before, after].includes(record.submissionDate));
  assert.equal(record.isLate, record.submissionDate > "2026-09-22");
  const past = api.updateMemberActivityStatus(10, 1, { submissionDate: "2026-09-21" });
  assert.equal(past.isLate, false);
  const count = writes.length;
  const saved = api.updateMemberActivityStatus(10, 1, { status: "done" });
  assert.equal(saved.submissionDate, "2026-09-21");
  assert.equal(writes.length, count);
});

test("submission date edits preserve unknown proof and isolate other members and activities", () => {
  const { api, stored } = setup({ members, activities: [activity({ proofRequired: true }), activity({ id: 11 })] });
  const before = plain(api.getActivities());
  const record = api.updateMemberActivityStatus(10, 2, { submissionDate: "2026-09-23" });
  assert.equal(record.isLate, true);
  assert.equal(Object.hasOwn(record, "proofReceived"), false);
  assert.equal(api.getMemberActivityProgress(api.getActivities()[0], record).completed, true);
  const after = JSON.parse(stored.get("activities"));
  assert.deepEqual(after[0].memberStatuses[0], before[0].memberStatuses[0]);
  assert.deepEqual(after[1], before[1]);
  assert.deepEqual(plain(record.history[0]), before[0].memberStatuses[1].history[0]);
});

test("late tasks retain proof-pending semantics without losing their recorded submission", () => {
  const { api } = setup({ members, activities: [activity({ proofRequired: true })] });
  let record = api.updateMemberActivityStatus(10, 1, { status: "done", submissionDate: "2026-09-23", proofReceived: false });
  let progress = api.getMemberActivityProgress(api.getActivities()[0], record);
  assert.equal(record.isLate, true);
  assert.equal(progress.outcome, "done");
  assert.equal(progress.proofPending, true);
  assert.equal(progress.completed, false);
  record = api.updateMemberActivityStatus(10, 1, { proofReceived: true });
  progress = api.getMemberActivityProgress(api.getActivities()[0], record);
  assert.equal(record.submissionDate, "2026-09-23");
  assert.equal(record.isLate, true);
  assert.equal(progress.completed, true);
});

test("legacy Done records never acquire a submission date from reads, empty patches, or proof-only edits", () => {
  const legacy = activity({ targetMembers: [1], memberStatuses: [{ memberId: 1, status: "done", timeliness: "late", history: [{ status: "done", timeliness: "late" }] }] });
  const { api, stored, writes } = setup({ members, activities: [legacy] });
  const before = stored.get("activities");
  const record = api.getActivities()[0].memberStatuses[0];
  assert.equal(Object.hasOwn(record, "submissionDate"), false);
  assert.equal(Object.hasOwn(record, "isLate"), false);
  api.updateMemberActivityStatus(10, 1, {});
  assert.equal(stored.get("activities"), before);
  const updated = api.updateMemberActivityStatus(10, 1, { proofReceived: true });
  assert.equal(Object.hasOwn(updated, "submissionDate"), false);
  assert.equal(Object.hasOwn(updated, "isLate"), false);
  assert.equal(Object.hasOwn(updated, "timeliness"), false);
  assert.equal(updated.history[0].timeliness, "late");
  assert.equal(writes.length, 1);
});

test("leaving Done clears submission fields but preserves their previous history", () => {
  const { api } = setup();
  api.updateMemberActivityStatus(10, 1, { status: "done", submissionDate: "2026-09-23" });
  const record = api.updateMemberActivityStatus(10, 1, { status: "excuse", excuseReason: "Family" });
  assert.equal(record.status, "excused");
  assert.equal(Object.hasOwn(record, "submissionDate"), false);
  assert.equal(Object.hasOwn(record, "isLate"), false);
  assert.equal(record.history[0].submissionDate, "2026-09-23");
  assert.equal(record.history[0].isLate, true);
  assert.equal(Object.hasOwn(record.history[1], "submissionDate"), false);
});

test("invalid submission dates and inappropriate task timing fields cannot write", () => {
  const { api, stored } = setup();
  const before = stored.get("activities");
  for (const submissionDate of ["", "2026-02-29", "2026-04-31", "0000-01-01", "2026-9-22", "2026-09-22T00:00:00Z", "tomorrow", null, 123]) {
    assert.throws(() => api.updateMemberActivityStatus(10, 1, { status: "done", submissionDate }), /Submission Date/);
  }
  for (const patch of [
    { status: "done", isLate: "true" }, { timeliness: "late" },
    { submissionDate: "2026-09-21" }, { isLate: true },
  ]) assert.throws(() => api.updateMemberActivityStatus(10, 1, patch));
  assert.throws(() => api.updateMemberActivityStatus(10, 2, { isLate: true }), /Submission Date/);
  assert.equal(stored.get("activities"), before);
  for (const type of ["Session", "Event"]) {
    const page = setup({ members, activities: [activity({ type })] });
    for (const patch of [{ submissionDate: "2026-09-21" }, { isLate: false }]) {
      assert.throws(() => page.api.updateMemberActivityStatus(10, 1, patch), /Cannot update/);
    }
  }
});

test("submissions require a valid task deadline while legacy proof-only edits remain available", () => {
  for (const deadline of ["", "2026-02-30", "unknown"]) {
    const { api, stored } = setup({ members, activities: [activity({ dueDate: deadline, deadline })] });
    const before = stored.get("activities");
    assert.throws(() => api.updateMemberActivityStatus(10, 1, { status: "done", submissionDate: "2026-09-22" }), /valid Deadline/);
    assert.throws(() => api.updateMemberActivityStatus(10, 1, { status: "done" }), /valid Deadline/);
    assert.equal(stored.get("activities"), before);
    const record = api.updateMemberActivityStatus(10, 2, { proofReceived: true });
    assert.equal(Object.hasOwn(record, "submissionDate"), false);
  }
});

test("valid leap dates are accepted and comparison uses the latest saved deadline", () => {
  const { api } = setup({ members, activities: [activity({ dueDate: "2028-02-29", deadline: "2028-02-29" })] });
  let record = api.updateMemberActivityStatus(10, 1, { status: "done", submissionDate: "2028-02-29" });
  assert.equal(record.isLate, false);
  api.updateActivity(10, { deadline: "2028-02-28" });
  record = api.updateMemberActivityStatus(10, 1, { proofReceived: true });
  assert.equal(record.submissionDate, "2028-02-29");
  assert.equal(record.isLate, true);
});

test("deadline aliases migrate legacy data, prefer dueDate and avoid blank fields on undated activities", () => {
  const legacy = activity();
  delete legacy.dueDate;
  const undated = activity({ id: 12 });
  delete undated.dueDate;
  delete undated.deadline;
  const { api, writes } = setup({ members, activities: [legacy, activity({ id: 11, dueDate: "2026-09-25" }), undated] });
  const [first, second, third] = api.getActivities();
  assert.equal(first.dueDate, "2026-09-22");
  assert.equal(second.deadline, "2026-09-25");
  assert.equal(api.getActivityDeadline(second), "2026-09-25");
  assert.equal(Object.hasOwn(third, "dueDate"), false);
  assert.equal(Object.hasOwn(third, "deadline"), false);
  assert.equal(api.getActivityDeadline({ dueDate: "", deadline: "2026-09-22" }), "2026-09-22");
  assert.equal(api.getActivityDeadline(null), "");
  api.initializeData();
  assert.equal(writes.length, 1);
});

test("editing either deadline alias synchronizes both and rejects conflicting edits", () => {
  const { api, stored } = setup();
  let entry = api.updateActivity(10, { deadline: "2026-09-23" });
  assert.equal(entry.dueDate, "2026-09-23");
  entry = api.updateActivity(10, { dueDate: "2026-09-24" });
  assert.equal(entry.deadline, "2026-09-24");
  const before = stored.get("activities");
  for (const patch of [
    { dueDate: "2026-09-24", deadline: "2026-09-25" },
    { dueDate: "2026-02-30" }, { dueDate: false },
  ]) assert.throws(() => api.updateActivity(10, patch));
  assert.equal(stored.get("activities"), before);
  entry = api.updateActivity(10, { deadline: "" });
  assert.equal(entry.dueDate, "");
  assert.equal(entry.deadline, "");
});

test("backups round-trip submission dates, flags and legacy timing history and reject malformed fields atomically", () => {
  const { api, stored } = setup();
  const backup = { members, activities: [activity({ targetMembers: [1], memberStatuses: [
    { memberId: 1, status: "done", submissionDate: "2026-09-23", isLate: true, history: [
      { status: "done", timeliness: "late" },
      { status: "done", submissionDate: "2026-09-23", isLate: true },
    ] },
  ] })] };
  api.restoreBackupData(backup);
  assert.deepEqual(plain(api.getBackupData()), backup);
  const before = Object.fromEntries(stored);
  for (const patch of [{ submissionDate: "2026-02-30" }, { submissionDate: false }, { isLate: "true" }]) {
    for (const inHistory of [false, true]) {
      const invalid = plain(backup);
      Object.assign(inHistory ? invalid.activities[0].memberStatuses[0].history[1] : invalid.activities[0].memberStatuses[0], patch);
      assert.throws(() => api.restoreBackupData(invalid));
      assert.deepEqual(Object.fromEntries(stored), before);
    }
  }
  for (const dueDate of ["2026-02-30", false]) {
    const invalid = plain(backup);
    invalid.activities[0].dueDate = dueDate;
    assert.throws(() => api.restoreBackupData(invalid));
    assert.deepEqual(Object.fromEntries(stored), before);
  }
});
