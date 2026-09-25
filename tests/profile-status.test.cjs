const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Exercise real profile handlers and real storage helpers without a DOM dependency.
class Element {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.listeners = {};
    this.value = "";
    this.checked = this.disabled = this.hidden = this.required = this.open = false;
    this.className = "";
  }
  set textContent(value) { this.children = []; this.text = String(value); }
  get textContent() { return (this.text || "") + this.children.map((child) => child.textContent).join(""); }
  append(...children) {
    children.forEach((child) => {
      if (typeof child !== "object") { const node = new Element("text"); node.textContent = child; child = node; }
      if (child.tagName === "FRAGMENT") { this.append(...child.children); return; }
      child.parent = this;
      this.children.push(child);
    });
  }
  replaceChildren(...children) { this.children = []; this.text = ""; this.append(...children); }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  fire(type, event = {}) { (this.listeners[type] || []).forEach((listener) => listener({ target: this, preventDefault() {}, ...event })); }
  matches(selector) {
    if (selector === "[data-status-activity-id]") return this.dataset.statusActivityId !== undefined;
    if (selector.startsWith(".")) return this.className.split(/\s+/).includes(selector.slice(1));
    return this.tagName === selector.toUpperCase();
  }
  querySelectorAll(selector) { return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector) || null; }
  contains(item) { return item === this || this.children.some((child) => child.contains(item)); }
  setCustomValidity(message) { this.validationMessage = message; }
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  close() { this.open = false; this.fire("close"); }
  reset() { this.children.forEach((child) => { child.value = ""; child.checked = false; child.reset(); }); }
  checkValidity() { return !this.children.some((child) => !child.disabled && (child.validationMessage || child.required && !child.value || !child.checkValidity())); }
  reportValidity() { this.reported = true; }
}

const root = path.join(__dirname, "..");
const fixtureMember = { id: 1, name: "Habiba", committee: "SM", status: "Up to date", joinedDate: "2026-09-01" };
function fixtureActivity(type = "Task", changes = {}, assignment = {}) {
  return {
    id: "first", name: `${type} activity`, type, source: "SM", date: "2026-09-20", deadline: "2026-09-22",
    proofRequired: true, proofType: "screenshot", targetMembers: [1, 2],
    memberStatuses: [{ memberId: 1, status: "pending", ...assignment }, { memberId: 2, status: "done", proofReceived: true, customNote: "Other member history" }],
    ...changes,
  };
}
function setup({ activity = fixtureActivity(), member = fixtureMember, search = "?id=1", otherActivities = [] } = {}) {
  const elements = {};
  const html = fs.readFileSync(path.join(root, "member-details.html"), "utf8");
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const node = elements[match[2]] = new Element(match[1]);
    node.hidden = /\shidden(?:\s|>)/.test(match[0]);
    node.disabled = /\sdisabled(?:\s|>)/.test(match[0]);
    node.required = /\srequired(?:\s|>)/.test(match[0]);
  }
  const statusIds = ["status-value", "submission-date", "status-proof", "status-application-proof", "status-attendance-proof", "status-applied", "status-selection", "status-final", "status-reason"];
  elements["status-form"].append(...statusIds.map((id) => elements[id]));
  elements["member-form"].append(...["member-name", "member-committee", "member-status", "member-joined-date"].map((id) => elements[id]));
  elements["member-details-content"].append(...["member-pending-list", "member-sessions-list", "member-events-list", "member-tasks-list"].map((id) => elements[id]));
  const stored = new Map([["members", JSON.stringify([member, { id: 2, name: "Maha", status: "Up to date" }])], ["activities", JSON.stringify([activity, ...otherActivities])]]);
  const writes = [];
  const window = new Element("window");
  window.location = { search, replace(value) { this.redirect = value; } };
  window.localStorage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => { stored.set(key, value); writes.push(key); },
    removeItem: (key) => stored.delete(key),
  };
  window.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
  window.dispatchEvent = (event) => window.fire(event.type, event);
  const document = {
    readyState: "complete", getElementById: (id) => elements[id],
    createElement: (tag) => new Element(tag), createDocumentFragment: () => new Element("fragment"),
  };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : ["2026-09-26T00:30:00Z"])); } }
  const context = vm.createContext({ window, document, URLSearchParams, Date: Clock, console });
  for (const file of ["data.js", "member-details.js"]) vm.runInContext(fs.readFileSync(path.join(root, "js", file), "utf8"), context, { filename: file });
  const current = () => window.YLYData.getActivities().find((item) => item.id === activity.id);
  const assignment = () => current().memberStatuses.find((item) => item.memberId === 1);
  const rows = () => elements["member-details-content"].querySelectorAll("[data-status-activity-id]");
  const open = () => {
    const row = rows().find((item) => item.dataset.statusActivityId === String(activity.id));
    assert.ok(row, "Expected an interactive activity row");
    elements["member-details-content"].fire("click", { target: row.querySelector(".profile-activity-title") });
    assert.equal(elements["status-dialog"].open, true, elements["member-details-error"].textContent);
  };
  const change = (id, value) => {
    const input = elements[id];
    if (typeof value === "boolean") input.checked = value; else input.value = value;
    elements["status-form"].fire("change", { target: input });
  };
  const save = () => elements["status-form"].fire("submit");
  return { elements, window, stored, writes, current, assignment, rows, open, change, save };
}

test("activity clicks open only Update Status; member edits have a separate button", () => {
  const app = setup();
  app.open();
  assert.equal(app.elements["member-dialog"].open, false);
  app.elements["status-cancel-button"].fire("click");
  app.elements["edit-member-button"].fire("click");
  assert.equal(app.elements["member-dialog"].open, true);
  assert.equal(app.elements["status-dialog"].open, false);
});

test("required task proof appears only for Done, saves per member, and refreshes pending totals", () => {
  const app = setup();
  const otherBefore = JSON.stringify(app.current().memberStatuses[1]);
  app.open();
  assert.equal(app.elements["status-proof-field"].hidden, true);
  app.change("status-value", "done");
  assert.equal(app.elements["status-proof-field"].hidden, false);
  assert.equal(app.elements["status-proof-label"].textContent, "Screenshot Received");
  app.save();
  assert.equal(app.elements["status-dialog"].open, false, app.elements["status-form-error"].textContent);
  assert.equal(app.assignment().proofReceived, false);
  assert.equal(app.elements["total-pending"].textContent, "1");
  assert.equal(app.elements["tasks-done"].textContent, "0");
  app.open();
  app.change("status-proof", true);
  app.save();
  assert.equal(app.assignment().proofReceived, true);
  assert.equal(app.elements["total-pending"].textContent, "0");
  assert.equal(app.elements["tasks-done"].textContent, "1");
  assert.equal(JSON.stringify(app.current().memberStatuses[1]), otherBefore);
});

for (const type of ["Task", "Session", "Event"]) {
  test(`${type}: explicit Proof Required No hides and omits every proof control`, () => {
    const app = setup({ activity: fixtureActivity(type, { proofRequired: false, screenshotRequired: true }) });
    app.open();
    if (type === "Task") app.change("status-value", "done");
    if (type === "Session") app.change("status-value", "attended");
    if (type === "Event") {
      app.change("status-applied", true);
      app.change("status-selection", "selected");
      app.change("status-final", "attended");
    }
    for (const key of ["proof", "application-proof", "attendance-proof"]) {
      assert.equal(app.elements[`status-${key}-field`].hidden, true);
      assert.equal(app.elements[`status-${key}`].disabled, true);
    }
    app.save();
    assert.equal(app.elements["status-dialog"].open, false, app.elements["status-form-error"].textContent);
    for (const field of ["proofReceived", "applicationProofReceived", "attendanceProofReceived"]) assert.equal(app.assignment()[field], undefined);
    assert.equal(app.elements["total-pending"].textContent, "0");
  });
}

for (const type of ["Task", "Session"]) {
  test(`${type} excuses require a reason, which clears when the status changes`, () => {
    const app = setup({ activity: fixtureActivity(type) });
    app.open();
    app.change("status-value", "excused");
    assert.equal(app.elements["status-reason-field"].hidden, false);
    assert.equal(app.elements["status-reason"].required, true);
    assert.equal(app.elements["status-proof-field"].hidden, true);
    app.save();
    assert.equal(app.elements["status-dialog"].open, true);
    assert.equal(app.assignment().status, "pending");
    app.elements["status-reason"].value = "  Family issue  ";
    app.save();
    assert.equal(app.assignment().excuseReason, "Family issue");
    app.open();
    app.change("status-value", "pending");
    assert.equal(app.elements["status-reason-field"].hidden, true);
    assert.equal(app.elements["status-reason"].disabled, true);
    app.save();
    assert.equal(app.assignment().excuseReason, "");
  });
}

test("session proof controls stay hidden even for required attendance proof", () => {
  const app = setup({ activity: fixtureActivity("Session") });
  app.open();
  app.change("status-value", "attended");
  assert.equal(app.elements["status-proof-field"].hidden, true);
  assert.equal(app.elements["status-application-proof-field"].hidden, true);
  assert.equal(app.elements["status-attendance-proof-field"].hidden, true);
});

test("events track application and attendance receipts separately with Pending Selection", () => {
  const app = setup({ activity: fixtureActivity("Event") });
  app.open();
  assert.equal(app.elements["status-selection-field"].hidden, true);
  app.change("status-applied", true);
  assert.equal(app.elements["status-selection"].value, "");
  assert.equal(app.elements["status-final-field"].hidden, true);
  assert.equal(app.elements["status-application-proof-field"].hidden, false);
  assert.equal(app.elements["status-application-proof-label"].textContent, "Application Screenshot Received");
  app.change("status-application-proof", true);
  app.change("status-selection", "selected");
  app.change("status-final", "attended");
  assert.equal(app.elements["status-attendance-proof-field"].hidden, false);
  assert.equal(app.elements["status-attendance-proof-label"].textContent, "Attendance Screenshot Received");
  assert.equal(app.elements["status-attendance-proof"].checked, false);
  app.save();
  assert.equal(app.assignment().applicationProofReceived, true);
  assert.equal(app.assignment().attendanceProofReceived, false);
  assert.equal(app.elements["events-attended"].textContent, "1");
  assert.equal(app.elements["total-pending"].textContent, "1");
  assert.match(app.elements["member-events-list"].textContent, /Attendance screenshot: not received/);
  assert.match(app.elements["member-events-list"].textContent, /AppliedSelectedAttended/);
  app.open();
  app.change("status-attendance-proof", true);
  app.save();
  assert.equal(app.assignment().attendanceProofReceived, true);
  assert.equal(app.elements["total-pending"].textContent, "0");
});

test("event excuses and branch changes clear hidden selection, final status, and reason", () => {
  const app = setup({ activity: fixtureActivity("Event", { proofRequired: false }) });
  app.open();
  app.change("status-applied", true);
  app.change("status-selection", "selected");
  app.change("status-final", "excused");
  app.save();
  assert.equal(app.elements["status-dialog"].open, true);
  app.elements["status-reason"].value = "Family issue";
  app.save();
  assert.equal(app.assignment().excuseReason, "Family issue");
  app.open();
  app.change("status-selection", "not_selected");
  assert.equal(app.elements["status-final-field"].hidden, true);
  assert.equal(app.elements["status-reason"].value, "");
  app.save();
  assert.equal(app.assignment().finalStatus, "");
  assert.equal(app.assignment().excuseReason, "");
  assert.equal(app.assignment().status, "not_selected");
  app.open();
  app.change("status-applied", false);
  app.save();
  assert.equal(app.assignment().selection, "");
  assert.equal(app.assignment().finalStatus, "");
  assert.equal(app.assignment().status, "pending");
  assert.equal(app.assignment().history[0].excuseReason, "Family issue");
});

test("form confirmation labels and proof type mismatch never reuse old screenshot receipts", () => {
  const app = setup({ activity: fixtureActivity("Task", { proofType: "form_confirmation" }, { status: "done", proofType: "screenshot", proofReceived: true }) });
  app.open();
  assert.equal(app.elements["status-proof-label"].textContent, "Form Confirmation Received");
  assert.equal(app.elements["status-proof"].checked, false);
  assert.match(app.elements["status-proof-help"].textContent, /current proof type/);
  assert.equal(app.elements["total-pending"].textContent, "1");
  app.change("status-proof", true);
  app.save();
  assert.equal(app.assignment().proofType, "form_confirmation");
  assert.equal(app.elements["total-pending"].textContent, "0");
  const event = setup({ activity: fixtureActivity("Event", { proofType: "form_confirmation" }) });
  event.open();
  event.change("status-applied", true);
  event.change("status-selection", "selected");
  event.change("status-final", "attended");
  assert.equal(event.elements["status-application-proof-label"].textContent, "Application Form Confirmation Received");
  assert.equal(event.elements["status-attendance-proof-label"].textContent, "Attendance Form Confirmation Received");
});

test("unchanged legacy session and event terminal statuses preserve unknown proof and history without writes", () => {
  for (const [type, status] of [["Session", "excused"], ["Event", "attended"]]) {
    const app = setup({ activity: fixtureActivity(type, {}, { status }) });
    const before = app.stored.get("activities");
    const writes = app.writes.length;
    app.open();
    app.save();
    assert.equal(app.elements["status-dialog"].open, false, `${type}: ${app.elements["status-form-error"].textContent}`);
    assert.equal(app.stored.get("activities"), before);
    assert.equal(app.writes.length, writes);
  }
});

test("Task Done shows a required Submission Date defaulting to today's UTC date", () => {
  const app = setup();
  app.open();
  const field = app.elements["status-submission-date-field"];
  const input = app.elements["submission-date"];
  assert.equal(field.hidden, true);
  assert.equal(input.disabled, true);
  assert.equal(input.required, false);
  app.change("status-value", "done");
  assert.equal(field.hidden, false);
  assert.equal(input.disabled, false);
  assert.equal(input.required, true);
  assert.equal(input.value, "2026-09-26");
  app.change("submission-date", "2026-09-21");
  app.save();
  assert.equal(app.elements["status-dialog"].open, false, app.elements["status-form-error"].textContent);
  assert.equal(app.assignment().submissionDate, "2026-09-21");
  assert.equal(app.assignment().isLate, false);
  app.open();
  assert.equal(input.value, "2026-09-21", "Reopening must preserve the recorded submission date");
});

test("Submission Date is hidden and disabled outside Task Done", () => {
  for (const [type, status] of [["Task", "pending"], ["Task", "excused"], ["Session", "attended"], ["Session", "excused"], ["Event", "attended"]]) {
    const app = setup({ activity: fixtureActivity(type) });
    app.open();
    if (type === "Event") {
      app.change("status-applied", true);
      app.change("status-selection", "selected");
      app.change("status-final", status);
    } else {
      if (type === "Task") app.change("status-value", "done");
      app.change("status-value", status);
    }
    assert.equal(app.elements["status-submission-date-field"].hidden, true, `${type} ${status}`);
    assert.equal(app.elements["submission-date"].disabled, true, `${type} ${status}`);
    assert.equal(app.elements["submission-date"].required, false, `${type} ${status}`);
  }
});

test("changing a submitted task back to Pending clears current submission fields and retains history", () => {
  const app = setup({ activity: fixtureActivity("Task", { proofRequired: false }) });
  app.open();
  app.change("status-value", "done");
  app.change("submission-date", "2026-09-23");
  app.save();
  app.open();
  app.change("status-value", "pending");
  assert.equal(app.elements["status-submission-date-field"].hidden, true);
  assert.equal(app.elements["submission-date"].disabled, true);
  app.save();
  assert.equal(app.elements["status-dialog"].open, false, app.elements["status-form-error"].textContent);
  assert.equal(app.assignment().status, "pending");
  assert.equal(app.assignment().submissionDate, undefined);
  assert.equal(app.assignment().isLate, undefined);
  assert.ok(app.assignment().history.some((step) => step.submissionDate === "2026-09-23" && step.isLate === true));
  assert.equal(app.elements["member-tasks-list"].querySelectorAll(".status-badge").some((badge) => badge.className.split(/\s+/).includes("status-late")), false);
  assert.equal(app.elements["total-pending"].textContent, "1");
});

for (const [submissionDate, isLate] of [["2026-09-21", false], ["2026-09-22", false], ["2026-09-23", true]]) {
  test(`Task submission ${submissionDate} compares strictly against its September 22 deadline`, () => {
    const app = setup({ activity: fixtureActivity("Task", { dueDate: "2026-09-22", proofRequired: false }) });
    const peerBefore = JSON.stringify(app.current().memberStatuses[1]);
    app.open();
    app.change("status-value", "done");
    app.change("submission-date", submissionDate);
    app.save();
    assert.equal(app.elements["status-dialog"].open, false, app.elements["status-form-error"].textContent);
    assert.equal(app.assignment().submissionDate, submissionDate);
    assert.equal(app.assignment().isLate, isLate);
    assert.equal(JSON.stringify(app.current().memberStatuses[1]), peerBefore);
    assert.equal(app.elements["total-pending"].textContent, "0");
    assert.equal(app.elements["tasks-done"].textContent, "1");
    const badges = app.elements["member-tasks-list"].querySelectorAll(".status-badge");
    const lateBadge = badges.find((badge) => badge.className.split(/\s+/).includes("status-late"));
    if (isLate) assert.equal(lateBadge?.textContent, "Done (Late)");
    else assert.equal(lateBadge, undefined);
  });
}

test("legacy task deadlines remain usable and an edited deadline is read again before saving", () => {
  const app = setup({ activity: fixtureActivity("Task", { proofRequired: false }) });
  app.open();
  app.change("status-value", "done");
  app.change("submission-date", "2026-09-24");
  app.window.YLYData.updateActivity("first", { dueDate: "2026-09-25" });
  app.save();
  assert.equal(app.elements["status-dialog"].open, false, app.elements["status-form-error"].textContent);
  assert.equal(app.assignment().submissionDate, "2026-09-24");
  assert.equal(app.assignment().isLate, false);
});

test("invalid or missing submission dates cannot be saved", () => {
  for (const date of ["", "2026-02-30", "2026-9-21", "invalid"]) {
    const app = setup({ activity: fixtureActivity("Task", { proofRequired: false }) });
    app.open();
    app.change("status-value", "done");
    app.change("submission-date", date);
    const before = app.stored.get("activities");
    app.save();
    assert.equal(app.elements["status-dialog"].open, true, date);
    assert.equal(app.stored.get("activities"), before, date);
  }
});

test("tasks without a valid deadline cannot save an automatic late classification", () => {
  for (const deadline of ["", "2026-02-30"]) {
    const app = setup({ activity: fixtureActivity("Task", { deadline, dueDate: deadline, proofRequired: false }) });
    app.open();
    app.change("status-value", "done");
    const before = app.stored.get("activities");
    app.save();
    assert.equal(app.elements["status-dialog"].open, true);
    assert.match(app.elements["status-form-error"].textContent, /deadline/i);
    assert.equal(app.stored.get("activities"), before);
  }
});

test("canceling a submission date edit never writes member history", () => {
  const app = setup();
  app.open();
  app.change("status-value", "done");
  app.change("submission-date", "2026-09-21");
  const before = app.stored.get("activities");
  const writesBefore = app.writes.length;
  app.elements["status-cancel-button"].fire("click");
  assert.equal(app.elements["status-dialog"].open, false);
  assert.equal(app.stored.get("activities"), before);
  assert.equal(app.writes.length, writesBefore);
});

test("late Done tasks keep their late badge while missing proof remains pending", () => {
  const app = setup({ activity: fixtureActivity("Task", {}, { status: "done", submissionDate: "2026-09-23", isLate: true, proofReceived: false }) });
  const badges = app.elements["member-tasks-list"].querySelectorAll(".status-badge");
  assert.equal(badges.find((badge) => badge.className.split(/\s+/).includes("status-late"))?.textContent, "Done (Late)");
  assert.ok(badges.some((badge) => badge.textContent === "Pending Proof"));
  assert.equal(app.elements["total-pending"].textContent, "1");
  assert.equal(app.elements["tasks-done"].textContent, "0");
  assert.ok(app.elements["member-tasks-list"].querySelectorAll("time").some((time) => time.dateTime === "2026-09-23"));
});

test("saving a legacy Done task records today's submission without inventing a proof receipt", () => {
  const app = setup({ activity: fixtureActivity("Task", {}, { status: "done" }) });
  app.open();
  assert.equal(app.elements["submission-date"].value, "2026-09-26");
  app.save();
  assert.equal(app.elements["status-dialog"].open, false, app.elements["status-form-error"].textContent);
  assert.equal(app.assignment().submissionDate, "2026-09-26");
  assert.equal(app.assignment().isLate, true);
  assert.equal(app.assignment().proofReceived, undefined);
});

test("editing only a saved submission date preserves unknown proof, then unchanged save preserves history", () => {
  const app = setup({ activity: fixtureActivity("Task", {}, { status: "done", submissionDate: "2026-09-21", isLate: false }) });
  app.open();
  app.change("submission-date", "2026-09-23");
  app.save();
  assert.equal(app.elements["status-dialog"].open, false, app.elements["status-form-error"].textContent);
  assert.equal(app.assignment().submissionDate, "2026-09-23");
  assert.equal(app.assignment().isLate, true);
  assert.equal(app.assignment().proofReceived, undefined);
  const before = app.stored.get("activities");
  const writesBefore = app.writes.length;
  app.open();
  app.save();
  assert.equal(app.elements["status-dialog"].open, false, app.elements["status-form-error"].textContent);
  assert.equal(app.stored.get("activities"), before);
  assert.equal(app.writes.length, writesBefore);
});

test("recording a date for a legacy Pending Proof task does not silently complete its proof", () => {
  const app = setup({ activity: fixtureActivity("Task", {}, { status: "pending_proof" }) });
  app.open();
  assert.equal(app.elements["status-value"].value, "done");
  assert.equal(app.elements["submission-date"].value, "2026-09-26");
  app.save();
  assert.equal(app.elements["status-dialog"].open, false, app.elements["status-form-error"].textContent);
  assert.equal(app.assignment().submissionDate, "2026-09-26");
  assert.equal(app.assignment().isLate, true);
  assert.equal(app.elements["total-pending"].textContent, "1");
  assert.equal(app.elements["tasks-done"].textContent, "0");
  assert.ok(app.elements["member-tasks-list"].querySelectorAll(".status-badge").some((badge) => badge.textContent === "Pending Proof"));
});

test("an unchanged Task Done dialog cannot overwrite a newer member status", () => {
  const app = setup({ activity: fixtureActivity("Task", { proofRequired: false }, { status: "done", submissionDate: "2026-09-21", isLate: false }) });
  app.open();
  app.window.YLYData.updateMemberActivityStatus("first", 1, { status: "pending" });
  const before = app.stored.get("activities");
  const writesBefore = app.writes.length;
  app.save();
  assert.equal(app.elements["status-dialog"].open, true);
  assert.match(app.elements["status-form-error"].textContent, /changed.*reopen/i);
  assert.equal(app.assignment().status, "pending");
  assert.equal(app.stored.get("activities"), before);
  assert.equal(app.writes.length, writesBefore);
});

test("failed saves retain the modal and do not change other members or the saved record", () => {
  const app = setup();
  app.open();
  app.change("status-value", "done");
  const before = app.stored.get("activities");
  app.window.localStorage.setItem = () => { throw new Error("Storage unavailable"); };
  app.save();
  assert.equal(app.elements["status-dialog"].open, true);
  assert.equal(app.elements["status-form-error"].hidden, false);
  assert.equal(app.stored.get("activities"), before);
});

test("proof requirement or type changes while editing block stale status saves", () => {
  for (const patch of [{ proofRequired: false }, { proofType: "form_confirmation" }, { type: "Session" }]) {
    const app = setup();
    app.open();
    app.change("status-value", "done");
    app.window.YLYData.updateActivity("first", patch);
    const before = app.stored.get("activities");
    app.save();
    assert.equal(app.elements["status-dialog"].open, true);
    assert.match(app.elements["status-form-error"].textContent, /changed/);
    assert.equal(app.stored.get("activities"), before);
  }
});

test("archived activities are hidden and archived members retain history without status editing", () => {
  const hidden = setup({ activity: fixtureActivity("Task", { archived: true }) });
  assert.equal(hidden.rows().length, 0);
  assert.equal(hidden.elements["total-pending"].textContent, "0");
  const archived = setup({ member: { ...fixtureMember, status: "Archived" } });
  assert.equal(archived.elements["profile-status"].textContent, "Archived");
  assert.match(archived.elements["member-tasks-list"].textContent, /Task activity/);
  assert.equal(archived.rows().length, 0);
  const button = archived.elements["member-tasks-list"].querySelector(".profile-update-button");
  assert.equal(button.disabled, true);
  archived.elements["member-details-content"].fire("click", { target: button });
  assert.equal(archived.elements["status-dialog"].open, false);
  archived.elements["edit-member-button"].fire("click");
  archived.elements["member-status"].value = "Up to date";
  archived.elements["member-form"].fire("submit");
  assert.equal(archived.elements["member-dialog"].open, false);
  assert.ok(archived.rows().length > 0);
});

test("archiving a member or activity while status editing blocks the save", () => {
  for (const target of ["member", "activity"]) {
    const app = setup();
    app.open();
    app.change("status-value", "done");
    if (target === "member") app.window.YLYData.archiveMember(1);
    else app.window.YLYData.archiveActivity("first");
    const before = app.stored.get("activities");
    app.save();
    assert.equal(app.elements["status-dialog"].open, true);
    assert.match(app.elements["status-form-error"].textContent, /archived/);
    assert.equal(app.stored.get("activities"), before);
  }
});

test("missing URL IDs redirect and unknown members show a useful error", () => {
  const missing = setup({ search: "" });
  assert.equal(missing.window.location.redirect, "members.html");
  const unknown = setup({ search: "?id=missing" });
  assert.equal(unknown.elements["member-details-content"].hidden, true);
  assert.match(unknown.elements["member-details-error"].textContent, /Member not found/);
});

test("profile name edits preserve a membership archive made after the dialog opened", () => {
  const app = setup();
  app.elements["edit-member-button"].fire("click");
  app.window.YLYData.archiveMember(1);
  app.elements["member-name"].value = "Habiba Updated";
  app.elements["member-form"].fire("submit");
  assert.equal(app.elements["member-dialog"].open, false);
  assert.equal(app.window.YLYData.getMembers()[0].status, "Archived");
  assert.equal(app.elements["profile-name"].textContent, "Habiba Updated");
  assert.equal(app.elements["profile-status"].textContent, "Archived");
  assert.equal(app.rows().length, 0);
});
