const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

// Load the real data, member actions, dashboard and summary scripts together.
// This adapter models the DOM operations they use; it does not test layout.
class Element {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.listeners = {};
    this.value = "";
    this.hidden = false;
    this.disabled = false;
    this.classList = { toggle() {} };
  }
  set textContent(value) { this.children = []; this.text = String(value); }
  get textContent() { return (this.text || "") + this.children.map((item) => item.textContent).join(""); }
  append(...items) {
    for (let item of items) {
      if (typeof item === "string") { const node = new Element("text"); node.textContent = item; item = node; }
      if (item.tagName === "FRAGMENT") { this.append(...item.children); continue; }
      item.parent = this;
      this.children.push(item);
    }
  }
  replaceChildren(...items) { this.children = []; this.text = ""; this.append(...items); }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  fire(name, event = {}) {
    for (const callback of this.listeners[name] || []) callback({ target: this, preventDefault() {}, ...event });
  }
  findAll(predicate) { return this.children.flatMap((item) => [...(predicate(item) ? [item] : []), ...item.findAll(predicate)]); }
  querySelectorAll(selector) {
    return this.findAll((item) => selector === ".action-menu[open]" && item.className === "action-menu" && item.open);
  }
  contains(item) { return this === item || this.children.some((child) => child.contains(item)); }
  setCustomValidity(value) { this.validationMessage = value; }
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  close() { this.open = false; this.fire("close"); }
}

const root = path.join(__dirname, "..");
function setup() {
  const elements = {};
  for (const filename of ["index.html", "members.html", "monthly-summary.html"]) {
    const html = fs.readFileSync(path.join(root, filename), "utf8");
    for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
      elements[match[2]] = new Element(match[1]);
    }
  }
  const filters = ["All", "Needs Follow-up", "Up to date", "Archived"].map((status) => {
    const button = new Element("button");
    button.dataset.status = status;
    return button;
  });
  elements["member-form"].reset = () => {};
  elements["member-form"].checkValidity = () => true;
  const date = new Date();
  const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  elements["summary-start"].value = `${month}-01`;
  elements["summary-end"].value = `${month}-${new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()}`;
  const members = [
    { id: 1, name: "Habiba", committee: "SM", status: "Up to date" },
    { id: 2, name: "Maha", committee: "SM", status: "Up to date" },
    { id: 3, name: "Archived Person", committee: "SM", status: "Archived" },
  ];
  const activities = [
    { id: "task", name: "Task", type: "Task", source: "SM", date: `${month}-05`, deadline: `${month}-09`, proofRequired: true, proofType: "screenshot", targetMembers: [1, 2], memberStatuses: [{ memberId: 1, status: "pending" }, { memberId: 2, status: "pending", history: ["pending"], note: "preserve" }] },
    { id: "event", name: "Event", type: "Event", source: "General", date: `${month}-10`, proofRequired: true, proofType: "screenshot", targetMembers: [1], memberStatuses: [{ memberId: 1, status: "attended", applied: true, selection: "selected", finalStatus: "attended", applicationProofReceived: true, attendanceProofReceived: false }] },
    { id: "old", name: "Archived Activity", type: "Task", date: `${month}-06`, archived: true, targetMembers: [1, 2], memberStatuses: [{ memberId: 1, status: "pending", history: ["done", "pending"] }, { memberId: 2, status: "done" }] },
  ];
  const storage = new Map([["members", JSON.stringify(members)], ["activities", JSON.stringify(activities)]]);
  const window = new Element("window");
  window.location = { hash: "", href: "http://localhost/members.html" };
  window.localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  window.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
  window.dispatchEvent = (event) => window.fire(event.type, event);
  const document = new Element("document");
  Object.assign(document, {
    readyState: "complete", createElement: (tag) => new Element(tag),
    createDocumentFragment: () => new Element("fragment"), getElementById: (id) => elements[id],
    querySelectorAll: () => filters,
  });
  const context = vm.createContext({ window, document, console, URL });
  for (const filename of ["data.js", "members.js", "dashboard.js", "monthly-summary.js"]) {
    vm.runInContext(fs.readFileSync(path.join(root, "js", filename), "utf8"), context, { filename });
  }
  const row = (name) => elements["members-table-body"].children.find((item) => item.children[0].textContent === name);
  const action = (name, label) => {
    const button = row(name)?.findAll((item) => item.tagName === "BUTTON" && item.textContent === label)[0];
    assert.ok(button, `Expected ${label} for ${name}`);
    button.fire("click");
  };
  const filter = (status) => filters.find((button) => button.dataset.status === status).fire("click");
  const metric = (memberIndex, category, label) => {
    const card = elements["summary-container"].innerHTML;
    const section = card.match(new RegExp(`<h3 id="summary-${memberIndex}-${category}"[^>]*>[\\s\\S]*?</section>`));
    assert.ok(section, `Expected summary ${memberIndex} ${category}`);
    return Number(section[0].match(new RegExp(`>${label}</dt>\\s*<dd[^>]*>(\\d+)</dd>`))[1]);
  };
  const pending = () => Number(elements["total-pending-items"].textContent);
  return { window, document, elements, storage, row, action, filter, metric, pending, data: window.YLYData };
}

test("Proof changes synchronize the member table, dashboard and monthly totals without reloading", () => {
  const { data, elements, row, metric, pending } = setup();
  assert.equal(elements["dashboard-error"].hidden, true);
  assert.equal(elements["summary-error"].hidden, true);
  assert.equal(pending(), 3);
  assert.equal(row("Habiba").children[3].textContent, "2");
  assert.equal(metric(0, "events", "Attended"), 1, "Attendance is recorded even while its proof is pending");
  assert.equal(metric(0, "general", "Completed"), 0);
  const peerBefore = JSON.stringify(data.getActivities()[0].memberStatuses[1]);
  data.updateMemberActivityStatus("task", 1, { status: "done", proofReceived: false });
  assert.equal(pending(), 3);
  assert.equal(metric(0, "tasks", "Done"), 0);
  assert.equal(metric(0, "tasks", "Pending"), 2, "The date-range report also includes the archived pending task");
  data.updateMemberActivityStatus("task", 1, { status: "done", proofReceived: true });
  assert.equal(pending(), 2);
  assert.equal(row("Habiba").children[3].textContent, "1");
  assert.equal(metric(0, "tasks", "Done"), 1);
  assert.equal(metric(0, "sm", "Completed"), 1);
  data.updateMemberActivityStatus("event", 1, { attendanceProofReceived: true });
  assert.equal(pending(), 1);
  assert.equal(row("Habiba").children[2].textContent, "Up to date");
  assert.equal(metric(0, "general", "Completed"), 1);
  assert.equal(JSON.stringify(data.getActivities()[0].memberStatuses[1]), peerBefore);
});

test("Member archive and restore retain history and only Archived shows archived members", () => {
  const { data, elements, storage, row, action, filter, pending } = setup();
  assert.equal(row("Archived Person"), undefined);
  const before = storage.get("activities");
  action("Habiba", "Archive Member");
  assert.equal(row("Habiba"), undefined);
  assert.equal(storage.get("activities"), before);
  assert.equal(elements["total-members"].textContent, "1");
  assert.equal(pending(), 1);
  assert.doesNotMatch(elements["summary-container"].innerHTML, /Habiba/);
  filter("Needs Follow-up");
  assert.equal(row("Habiba"), undefined);
  filter("Archived");
  assert.ok(row("Habiba"));
  assert.ok(row("Archived Person"));
  assert.equal(row("Maha"), undefined);
  action("Habiba", "Restore Member");
  assert.equal(row("Habiba"), undefined);
  filter("All");
  assert.equal(row("Habiba").children[2].textContent, "Needs Follow-up");
  assert.equal(data.getMembers().length, 3);
  assert.equal(storage.get("activities"), before);
  assert.equal(pending(), 3);
});

test("Delete confirmation Cancel preserves all data; confirmation cleans only the chosen member's history", () => {
  const { data, elements, storage, action, row } = setup();
  const before = Object.fromEntries(storage);
  action("Habiba", "Delete Permanently");
  assert.equal(elements["member-delete-dialog"].open, true);
  assert.match(elements["member-delete-message"].textContent, /Delete Habiba permanently/);
  assert.equal(elements["member-delete-cancel"].focused, true);
  assert.deepEqual(Object.fromEntries(storage), before);
  elements["member-delete-cancel"].fire("click");
  assert.equal(elements["member-delete-dialog"].open, false);
  assert.deepEqual(Object.fromEntries(storage), before);
  const otherRecords = JSON.stringify(data.getActivities().flatMap((activity) => activity.memberStatuses.filter((record) => record.memberId !== 1)));
  action("Habiba", "Delete Permanently");
  elements["member-delete-confirm"].fire("click");
  assert.equal(elements["member-delete-dialog"].open, false);
  assert.equal(row("Habiba"), undefined);
  assert.ok(row("Maha"));
  for (const activity of data.getActivities()) {
    assert.ok(!activity.targetMembers.includes(1));
    assert.ok(!activity.memberStatuses.some((record) => record.memberId === 1));
  }
  assert.equal(JSON.stringify(data.getActivities().flatMap((activity) => activity.memberStatuses)), otherRecords);
  assert.doesNotMatch(elements["summary-container"].innerHTML, /Habiba/);
});

test("A failed delete stays open and rollback restores both collections", () => {
  const { window, elements, storage, action, row } = setup();
  const before = Object.fromEntries(storage);
  action("Habiba", "Delete Permanently");
  window.localStorage.setItem = (key, value) => {
    if (key === "activities") throw new Error("Storage full");
    storage.set(key, value);
  };
  elements["member-delete-confirm"].fire("click");
  assert.equal(elements["member-delete-dialog"].open, true);
  assert.equal(elements["member-delete-error"].hidden, false);
  assert.equal(elements["member-delete-confirm"].disabled, false);
  assert.deepEqual(Object.fromEntries(storage), before);
  assert.ok(row("Habiba"));
});

test("Activity archive changes active counts while the historical summary keeps its records", () => {
  const { data, storage, row, metric, pending } = setup();
  const before = data.getActivities()[0].memberStatuses;
  data.archiveActivity("task");
  assert.equal(pending(), 1);
  assert.equal(row("Maha").children[3].textContent, "0");
  assert.equal(row("Maha").children[2].textContent, "Up to date");
  assert.equal(metric(0, "tasks", "Pending"), 2);
  assert.equal(JSON.stringify(data.getActivities()[0].memberStatuses), JSON.stringify(before));
  data.archiveActivity("task", false);
  assert.equal(pending(), 3);
  assert.equal(metric(0, "tasks", "Pending"), 2);
  assert.equal(JSON.parse(storage.get("activities")).length, 3);
});

test("Archiving every activity clears the active board while the date-range summary preserves history", () => {
  const { data, storage, row, metric, pending, elements } = setup();
  const before = JSON.parse(storage.get("activities"));
  const summaryBefore = elements["summary-container"].innerHTML;
  data.saveActivities(data.getActivities().map((activity) => ({ ...activity, archived: true })));
  assert.equal(pending(), 0);
  assert.equal(row("Habiba").children[3].textContent, "0");
  assert.equal(row("Maha").children[3].textContent, "0");
  assert.equal(elements["summary-container"].innerHTML, summaryBefore);
  assert.equal(metric(0, "events", "Attended"), 1);
  assert.equal(metric(0, "tasks", "Pending"), 2);
  assert.equal(data.getMembers().length, 3);
  const after = JSON.parse(storage.get("activities"));
  assert.equal(after.length, before.length);
  assert.ok(after.every((activity) => activity.archived === true));
  assert.deepEqual(after.map((activity) => activity.memberStatuses), before.map((activity) => activity.memberStatuses));
});

test("Search and filters still compose, View links use IDs, and storage events refresh open pages", () => {
  const { window, elements, storage, row, filter, pending } = setup();
  assert.equal(row("Habiba").children[0].children[0].href, "member-details.html?id=1");
  elements["member-search"].value = "MAH";
  elements["member-search"].fire("input");
  assert.ok(row("Maha"));
  assert.equal(row("Habiba"), undefined);
  filter("Up to date");
  assert.equal(row("Maha"), undefined);
  const activities = JSON.parse(storage.get("activities"));
  activities[0].memberStatuses[1] = { memberId: 2, status: "done", proofReceived: true };
  storage.set("activities", JSON.stringify(activities));
  window.fire("storage", { key: "activities" });
  assert.ok(row("Maha"));
  assert.equal(row("Maha").children[3].textContent, "0");
  assert.equal(pending(), 2);
});

test("Saving an open member edit cannot silently undo a new archive", () => {
  const { data, elements, action, filter, row } = setup();
  action("Habiba", "Edit");
  data.archiveMember(1);
  elements["member-name"].value = "Habiba Updated";
  elements["member-form"].fire("submit");
  assert.equal(elements["member-dialog"].open, false);
  assert.equal(data.getMembers().find((member) => member.id === 1).status, "Archived");
  assert.equal(row("Habiba Updated"), undefined);
  filter("Archived");
  assert.ok(row("Habiba Updated"));
  action("Habiba Updated", "Edit");
  elements["member-status"].value = "Up to date";
  elements["member-form"].fire("submit");
  assert.equal(data.isMemberArchived(data.getMembers().find((member) => member.id === 1)), false);
});
