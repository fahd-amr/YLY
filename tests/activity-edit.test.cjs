const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

// A small DOM adapter exercises the actual page event handlers and storage API.
class Element {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.listeners = {};
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.classList = { toggle() {} };
  }
  set textContent(value) { this.children = []; this.text = String(value); }
  get textContent() { return (this.text || "") + this.children.map((item) => item.textContent).join(""); }
  get options() { return this.children.filter((item) => item.tagName === "OPTION"); }
  append(...items) {
    for (let item of items) {
      if (typeof item === "string") { const text = new Element("text"); text.textContent = item; item = text; }
      if (item.tagName === "FRAGMENT") { this.append(...item.children); continue; }
      item.parent = this;
      this.children.push(item);
    }
  }
  replaceChildren(...items) { this.children = []; this.text = ""; this.append(...items); }
  remove() { this.parent.children = this.parent.children.filter((item) => item !== this); }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  fire(name, event = {}) { for (const callback of this.listeners[name] || []) callback({ target: this, preventDefault() {}, ...event }); }
  querySelectorAll(selector) {
    const result = [];
    function walk(element) {
      for (const child of element.children) {
        const matches = (selector === "input:checked" && child.tagName === "INPUT" && child.checked)
          || (selector === "input" && child.tagName === "INPUT")
          || (selector === "details.action-menu" && child.tagName === "DETAILS" && child.className === "action-menu")
          || (selector === "summary" && child.tagName === "SUMMARY")
          || (selector === "option[data-legacy]" && child.tagName === "OPTION" && child.dataset.legacy)
          || (selector === "button[data-activity-action]" && child.tagName === "BUTTON" && child.dataset.activityAction);
        if (matches) result.push(child);
        walk(child);
      }
    }
    walk(this);
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  contains(item) { return item === this || this.children.some((child) => child.contains(item)); }
  closest(selector) {
    if (selector === "button[data-activity-action]" && this.dataset.activityAction) return this;
    return this.parent ? this.parent.closest(selector) : null;
  }
  setCustomValidity(value) { this.validationMessage = value; }
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
}

const root = path.join(__dirname, "..");

function setup() {
  const elements = {};
  const html = fs.readFileSync(path.join(root, "activities.html"), "utf8");
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    elements[match[2]] = new Element(match[1]);
  }
  const filters = ["All", "Events", "Sessions", "Tasks", "General", "SM", "Pending", "Archived"].map((filter) => {
    const element = new Element("button");
    element.dataset.filter = filter;
    return element;
  });
  for (const [id, values] of [
    ["activity-type", ["Event", "Session", "Task"]],
    ["activity-source", ["General", "SM"]],
    ["activity-proof-type", ["screenshot", "form_confirmation"]],
  ]) {
    for (const value of values) {
      const option = new Element("option");
      option.value = value;
      elements[id].append(option);
    }
  }
  elements["activity-form"].reset = () => {
    for (const element of Object.values(elements)) { element.checked = false; element.value = ""; }
  };
  elements["activity-form"].checkValidity = () => !Object.values(elements).some((element) => element.validationMessage);
  elements["activity-form"].reportValidity = () => {};
  const members = [
    { id: 1, name: "Habiba", committee: "SM", status: "Needs Follow-up" },
    { id: 2, name: "Maha", committee: "SM", status: "Up to date" },
    { id: 3, name: "Jihad", committee: "SM", status: "Up to date" },
    { id: 4, name: "Archived member", committee: "SM", status: "Archived" },
  ];
  const activities = [{
    id: "first", name: "Original task", type: "Task", source: "Legacy source", date: "2026-09-05", deadline: "2026-09-08",
    screenshotRequired: true, formRequired: true, targetMembers: [1, 2, 4, "missing"],
    memberStatuses: [
      { memberId: 1, status: "pending" },
      { memberId: 2, status: "done", proofReceived: true, customNote: "Keep me" },
      { memberId: 4, status: "done" },
      { memberId: "missing", status: "pending" },
    ],
  }];
  const storage = new Map([["members", JSON.stringify(members)], ["activities", JSON.stringify(activities)]]);
  const window = new Element("window");
  window.location = { hash: "", href: "http://localhost/activities.html" };
  window.localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  window.dispatchEvent = (event) => window.fire(event.type, event);
  window.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
  const document = {
    readyState: "complete",
    createElement: (tag) => new Element(tag),
    createDocumentFragment: () => new Element("fragment"),
    getElementById: (id) => elements[id],
    querySelectorAll: () => filters,
    addEventListener() {},
  };
  const context = vm.createContext({ window, document, console, URL, CustomEvent: window.CustomEvent });
  for (const filename of ["data.js", "activities.js"]) {
    vm.runInContext(fs.readFileSync(path.join(root, "js", filename), "utf8"), context, { filename });
  }
  const clickAction = (action, activityId = "first") => {
    const button = elements["activities-list"].querySelectorAll("button[data-activity-action]")
      .find((item) => item.dataset.activityAction === action && item.dataset.activityId === activityId);
    assert.ok(button, `Expected ${action} action on the activity card`);
    elements["activities-list"].fire("click", { target: button });
  };
  const target = (id) => elements["activity-target-members"].querySelectorAll("input").find((item) => item.value === String(id));
  const current = () => window.YLYData.getActivities()[0];
  return { elements, filters, window, storage, clickAction, target, current };
}

test("View is read-only; editing preserves latest member progress, source, archived and unavailable targets", () => {
  const { elements, window, storage, clickAction, target, current } = setup();
  clickAction("view");
  assert.equal(elements["activity-dialog-title"].textContent, "View Activity");
  assert.equal(elements["activity-metadata-fieldset"].disabled, true);
  assert.equal(elements["activity-save-button"].hidden, true);
  const before = storage.get("activities");
  elements["activity-form"].fire("submit");
  assert.equal(storage.get("activities"), before);
  elements["activity-cancel-button"].fire("click");

  clickAction("edit");
  assert.equal(elements["activity-dialog-title"].textContent, "Edit Activity");
  assert.equal(elements["activity-name"].value, "Original task");
  assert.equal(elements["activity-source"].value, "Legacy source");
  assert.equal(elements["activity-metadata-fieldset"].disabled, false);
  assert.equal(target(4).checked, true);
  assert.equal(target("missing").checked, true);
  // Progress is updated after the metadata dialog was opened.
  window.YLYData.updateMemberActivityStatus("first", 1, { status: "done", proofReceived: true });
  elements["activity-name"].value = "Edited task";
  elements["activity-form"].fire("submit");
  assert.equal(elements["activity-dialog"].open, false);
  assert.equal(current().name, "Edited task");
  assert.equal(current().source, "Legacy source");
  assert.equal(current().memberStatuses.find((item) => item.memberId === 1).status, "done");
  assert.equal(current().memberStatuses.find((item) => item.memberId === 2).customNote, "Keep me");
  assert.deepEqual(Array.from(current().targetMembers, String), ["1", "2", "4", "missing"]);
});

test("The Deadline field edits canonical dueDate and its legacy alias together", () => {
  const { elements, window, clickAction, current } = setup();
  window.YLYData.updateActivity("first", { dueDate: "2026-09-24" });
  const before = JSON.stringify(current().memberStatuses);
  clickAction("edit");
  assert.equal(elements["activity-deadline"].value, "2026-09-24");
  elements["activity-deadline"].value = "2026-09-28";
  elements["activity-form"].fire("submit");
  assert.equal(elements["activity-dialog"].open, false, elements["activity-form-error"].textContent);
  assert.equal(current().dueDate, "2026-09-28");
  assert.equal(current().deadline, "2026-09-28");
  assert.equal(JSON.stringify(current().memberStatuses), before);
  assert.match(elements["activities-list"].textContent, /Deadline/);
});

test("Removing/re-adding targets preserves history and new targets begin pending", () => {
  const { elements, window, clickAction, target, current } = setup();
  clickAction("edit");
  target(2).checked = false;
  target(3).checked = true;
  elements["activity-form"].fire("submit");
  assert.equal(elements["activity-dialog"].open, false);
  assert.ok(!window.YLYData.getActivityMemberStatuses(current()).some((item) => String(item.memberId) === "2"));
  assert.equal(current().memberStatuses.find((item) => String(item.memberId) === "2").status, "done");
  assert.equal(current().memberStatuses.find((item) => String(item.memberId) === "3").status, "pending");
  clickAction("edit");
  target(2).checked = true;
  elements["activity-form"].fire("submit");
  assert.equal(window.YLYData.getActivityMemberStatuses(current()).find((item) => String(item.memberId) === "2").status, "done");
});

test("Missing proof remains visible and Pending filtering uses current member progress", () => {
  const { elements, filters, window } = setup();
  window.YLYData.updateMemberActivityStatus("first", 1, { status: "done", proofReceived: false });
  assert.match(elements["activities-list"].textContent, /Pending Proof/);
  filters.find((item) => item.dataset.filter === "Pending").fire("click");
  assert.match(elements["activity-count"].textContent, /1 of 1 activity/);
});

test("A failed save keeps the edit dialog open and preserves stored data", () => {
  const { elements, window, storage, clickAction } = setup();
  clickAction("edit");
  const before = storage.get("activities");
  window.localStorage.setItem = () => { throw new Error("Storage unavailable"); };
  elements["activity-name"].value = "Cannot save";
  elements["activity-form"].fire("submit");
  assert.equal(elements["activity-dialog"].open, true);
  assert.equal(elements["activity-form-error"].hidden, false);
  assert.equal(storage.get("activities"), before);
});

test("Adding uses separated target IDs and member statuses, and accepts a deadline before the activity", () => {
  const { elements, window, target } = setup();
  elements["add-activity-button"].fire("click");
  assert.equal(elements["activity-dialog-title"].textContent, "Add Activity");
  assert.equal(target(4), undefined);
  elements["activity-name"].value = "Application deadline before event";
  elements["activity-type"].value = "Event";
  elements["activity-date"].value = "2026-09-25";
  elements["activity-deadline"].value = "2026-09-20";
  target(3).checked = true;
  elements["activity-form"].fire("submit");
  assert.equal(elements["activity-dialog"].open, false);
  const created = window.YLYData.getActivities().find((item) => item.name === "Application deadline before event");
  assert.ok(created);
  assert.deepEqual(Array.from(created.targetMembers), [3]);
  assert.equal(created.memberStatuses[0].memberId, 3);
  assert.equal(created.memberStatuses[0].status, "pending");
});

test("A newly selected member archived while editing is rejected without overwriting data", () => {
  const { elements, window, storage, clickAction, target } = setup();
  clickAction("edit");
  target(3).checked = true;
  const members = window.YLYData.getMembers();
  members.find((item) => item.id === 3).status = "Archived";
  window.YLYData.saveMembers(members);
  const before = storage.get("activities");
  elements["activity-form"].fire("submit");
  assert.equal(elements["activity-dialog"].open, true);
  assert.equal(elements["activity-form-error"].hidden, false);
  assert.equal(storage.get("activities"), before);
});

test("Legacy proof settings prefill and explicit No hides proof type and disables proof", () => {
  const { elements, window, clickAction, current } = setup();
  clickAction("edit");
  assert.equal(elements["activity-proof-required"].checked, true);
  assert.equal(elements["activity-proof-not-required"].checked, false);
  assert.equal(elements["activity-proof-type"].value, "screenshot");
  assert.equal(elements["activity-proof-type-field"].hidden, false);
  assert.equal(elements["activity-proof-type"].disabled, false);
  elements["activity-proof-required"].checked = false;
  elements["activity-proof-not-required"].checked = true;
  elements["activity-proof-not-required"].fire("change");
  assert.equal(elements["activity-proof-type-field"].hidden, true);
  assert.equal(elements["activity-proof-type"].disabled, true);
  elements["activity-form"].fire("submit");
  assert.equal(elements["activity-dialog"].open, false);
  assert.equal(current().proofRequired, false);
  assert.equal(window.YLYData.getActivityProofSettings(current()).required, false);
  clickAction("view");
  assert.equal(elements["activity-proof-required"].checked, false);
  assert.equal(elements["activity-proof-not-required"].checked, true);
  assert.equal(elements["activity-proof-type-field"].hidden, true);
});

test("Both proof types can be saved and prefilled without changing another member's history", () => {
  const { elements, clickAction, current } = setup();
  const statuses = JSON.stringify(current().memberStatuses);
  for (const proofType of ["form_confirmation", "screenshot"]) {
    clickAction("edit");
    elements["activity-proof-required"].checked = true;
    elements["activity-proof-not-required"].checked = false;
    elements["activity-proof-required"].fire("change");
    elements["activity-proof-type"].value = proofType;
    elements["activity-form"].fire("submit");
    assert.equal(elements["activity-dialog"].open, false);
    assert.equal(current().proofRequired, true);
    assert.equal(current().proofType, proofType);
    assert.equal(JSON.stringify(current().memberStatuses), statuses);
    clickAction("view");
    assert.equal(elements["activity-proof-type"].value, proofType);
    assert.equal(elements["activity-proof-type"].disabled, true);
    elements["activity-cancel-button"].fire("click");
  }
});

test("Archive hides a card from active filters, keeps history, and allows restoring from Archived", () => {
  const { elements, filters, window, clickAction, current } = setup();
  const statuses = JSON.stringify(current().memberStatuses);
  clickAction("archive");
  assert.equal(window.YLYData.isActivityArchived(current()), true);
  assert.equal(JSON.stringify(current().memberStatuses), statuses);
  assert.equal(elements["activities-list"].querySelectorAll("button[data-activity-action]").length, 0);
  for (const filter of ["All", "Tasks", "Pending"]) {
    filters.find((item) => item.dataset.filter === filter).fire("click");
    assert.equal(elements["activities-list"].querySelectorAll("button[data-activity-action]").length, 0);
  }
  filters.find((item) => item.dataset.filter === "Archived").fire("click");
  assert.match(elements["activities-list"].textContent, /Archived/);
  clickAction("view");
  assert.equal(elements["activity-metadata-fieldset"].disabled, true);
  elements["activity-cancel-button"].fire("click");
  clickAction("restore");
  assert.equal(window.YLYData.isActivityArchived(current()), false);
  filters.find((item) => item.dataset.filter === "All").fire("click");
  assert.match(elements["activities-list"].textContent, /Original task/);
  assert.equal(JSON.stringify(current().memberStatuses), statuses);
});

test("Deleting records includes inactive history in the warning and Cancel keeps everything", () => {
  const { elements, window, storage, clickAction } = setup();
  window.YLYData.updateActivity("first", { targetMembers: [1] });
  const before = storage.get("activities");
  clickAction("delete");
  assert.equal(elements["activity-delete-dialog"].open, true);
  assert.equal(elements["activity-delete-message"].textContent,
    "This activity has records for 4 members. Deleting it will remove their saved statuses. Consider Archiving instead.");
  assert.equal(elements["activity-delete-confirm"].textContent, "Force Delete");
  assert.equal(elements["activity-delete-archive"].hidden, false);
  elements["activity-delete-cancel"].fire("click");
  assert.equal(elements["activity-delete-dialog"].open, false);
  assert.equal(storage.get("activities"), before);
});

test("The warning's Archive option preserves statuses instead of deleting", () => {
  const { elements, window, clickAction, current } = setup();
  const statuses = JSON.stringify(current().memberStatuses);
  clickAction("delete");
  elements["activity-delete-archive"].fire("click");
  assert.equal(elements["activity-delete-dialog"].open, false);
  assert.equal(window.YLYData.isActivityArchived(current()), true);
  assert.equal(JSON.stringify(current().memberStatuses), statuses);
});

test("Force Delete removes only the confirmed activity, preserving members and other activity records", () => {
  const { elements, window, storage, clickAction } = setup();
  const other = { id: "other", type: "Session", name: "Other", targetMembers: [2], memberStatuses: [{ memberId: 2, status: "attended" }] };
  window.YLYData.saveActivities([...window.YLYData.getActivities(), other]);
  const membersBefore = storage.get("members");
  const otherBefore = JSON.stringify(window.YLYData.getActivities().find((item) => item.id === "other"));
  clickAction("delete");
  elements["activity-delete-confirm"].fire("click");
  assert.equal(elements["activity-delete-dialog"].open, false);
  assert.equal(window.YLYData.getActivities().length, 1);
  assert.equal(JSON.stringify(window.YLYData.getActivities()[0]), otherBefore);
  assert.equal(storage.get("members"), membersBefore);
});

test("Deleting an empty activity uses a standard confirmation", () => {
  const { elements, window, clickAction } = setup();
  window.YLYData.saveActivities([...window.YLYData.getActivities(), {
    id: "empty", name: "Unassigned session", type: "Session", targetMembers: [], memberStatuses: [],
  }]);
  clickAction("delete", "empty");
  assert.match(elements["activity-delete-message"].textContent, /Delete Unassigned session\?/);
  assert.equal(elements["activity-delete-confirm"].textContent, "Delete");
  assert.equal(elements["activity-delete-archive"].hidden, true);
  elements["activity-delete-confirm"].fire("click");
  assert.equal(elements["activity-delete-dialog"].open, false);
  assert.deepEqual(Array.from(window.YLYData.getActivities(), (item) => item.id), ["first"]);
});

test("Newly added records upgrade a standard confirmation and require another explicit Force Delete click", () => {
  const { elements, window, clickAction } = setup();
  window.YLYData.saveActivities([...window.YLYData.getActivities(), {
    id: "empty", name: "Unassigned session", type: "Session", targetMembers: [], memberStatuses: [],
  }]);
  clickAction("delete", "empty");
  assert.equal(elements["activity-delete-confirm"].textContent, "Delete");
  window.YLYData.updateActivity("empty", { targetMembers: [1] });
  elements["activity-delete-confirm"].fire("click");
  assert.equal(elements["activity-delete-dialog"].open, true);
  assert.equal(window.YLYData.getActivities().length, 2);
  assert.equal(elements["activity-delete-confirm"].textContent, "Force Delete");
  assert.match(elements["activity-delete-message"].textContent, /records for 1 members/);
  elements["activity-delete-confirm"].fire("click");
  assert.equal(elements["activity-delete-dialog"].open, false);
  assert.deepEqual(Array.from(window.YLYData.getActivities(), (item) => item.id), ["first"]);
});

test("Failed delete and archive preserve storage and leave an actionable error", () => {
  const { elements, window, storage, clickAction } = setup();
  const before = storage.get("activities");
  clickAction("delete");
  window.localStorage.setItem = () => { throw new Error("Storage unavailable"); };
  elements["activity-delete-confirm"].fire("click");
  assert.equal(elements["activity-delete-dialog"].open, true);
  assert.equal(elements["activity-delete-error"].hidden, false);
  assert.equal(storage.get("activities"), before);
  elements["activity-delete-archive"].fire("click");
  assert.equal(elements["activity-delete-dialog"].open, true);
  assert.equal(elements["activity-delete-error"].hidden, false);
  assert.equal(storage.get("activities"), before);
  elements["activity-delete-cancel"].fire("click");
  clickAction("archive");
  assert.equal(elements["activities-error"].hidden, false);
  assert.equal(storage.get("activities"), before);
});

test("Editing legacy activity metadata preserves an unknown existing type", () => {
  const { elements, window, clickAction, current } = setup();
  const saved = window.YLYData.getActivities();
  saved[0].type = "Workshop";
  window.YLYData.saveActivities(saved);
  const statuses = JSON.stringify(current().memberStatuses);
  clickAction("edit");
  assert.equal(elements["activity-type"].value, "Workshop");
  elements["activity-name"].value = "Renamed workshop";
  elements["activity-form"].fire("submit");
  assert.equal(elements["activity-dialog"].open, false);
  assert.equal(current().type, "Workshop");
  assert.equal(current().name, "Renamed workshop");
  assert.equal(JSON.stringify(current().memberStatuses), statuses);
});
