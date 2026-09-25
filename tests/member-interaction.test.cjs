const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class Element {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.listeners = {};
    this.value = this.className = "";
    this.checked = this.disabled = this.hidden = this.required = this.open = false;
  }
  set textContent(value) { this.children = []; this.text = String(value); }
  get textContent() { return (this.text || "") + this.children.map((child) => child.textContent).join(""); }
  set innerHTML(_) { throw new Error("Saved interaction content must be rendered as text."); }
  append(...children) {
    children.forEach((child) => {
      if (typeof child !== "object") { const node = new Element("text"); node.textContent = child; child = node; }
      if (child.tagName === "FRAGMENT") { this.append(...child.children); return; }
      child.parent = this;
      this.children.push(child);
    });
  }
  replaceChildren(...children) { this.children = []; this.text = ""; this.append(...children); }
  setAttribute(name, value) { this[name] = String(value); }
  addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
  fire(type, event = {}) { (this.listeners[type] || []).forEach((callback) => callback({ target: this, preventDefault() {}, ...event })); }
  matches(selector) {
    if (selector === "[data-status-activity-id]") return this.dataset.statusActivityId !== undefined;
    if (selector.startsWith(".")) return this.className.split(/\s+/).includes(selector.slice(1));
    return this.tagName === selector.toUpperCase();
  }
  querySelectorAll(selector) { return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector) || null; }
  contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  close() { this.open = false; this.fire("close"); }
  setCustomValidity(message) { this.validationMessage = message; }
  reset() { this.children.forEach((child) => { child.value = ""; child.checked = false; child.reset(); }); }
  checkValidity() { return !this.children.some((child) => !child.disabled && (child.validationMessage || child.required && !child.value || !child.checkValidity())); }
  reportValidity() { this.reported = true; }
}

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "member-details.html"), "utf8");
const checkpoint = (id, type, date = "2026-09-20") => ({ id, month: date.slice(0, 7), type, date, title: id, interactionExpected: "Yes" });
function setup({ memberId = "1", overrides = {} } = {}) {
  const elements = {};
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const node = elements[match[2]] = new Element(match[1]);
    for (const attribute of match[0].matchAll(/([\w-]+)="([^"]*)"/g)) node.setAttribute(attribute[1], attribute[2]);
    node.hidden = /\shidden(?:\s|>)/.test(match[0]);
    node.disabled = /\sdisabled(?:\s|>)/.test(match[0]);
    node.required = /\srequired(?:\s|>)/.test(match[0]);
  }
  elements["status-form"].append(...["status-value", "submission-date", "status-proof", "status-application-proof", "status-attendance-proof", "status-applied", "status-selection", "status-final", "status-reason"].map((id) => elements[id]));
  elements["member-form"].append(...["member-name", "member-committee", "member-status", "member-joined-date"].map((id) => elements[id]));
  elements["member-details-content"].append(...["member-pending-list", "member-sessions-list", "member-events-list", "member-tasks-list"].map((id) => elements[id]));
  const state = {
    members: [{ id: 1, name: "Habiba", committee: "SM", status: "Up to date", joinedDate: "2026-09-01" }, { id: 2, name: "Maha", status: "Up to date" }],
    activities: [{ id: "task", type: "Task", name: "Existing task", date: "2026-09-20", deadline: "2026-09-22", targetMembers: [1, 2], proofRequired: false, memberStatuses: [{ memberId: 1, status: "pending" }, { memberId: 2, status: "pending" }] }],
    interactionSettings: { fb: 2, general: 2, sm: 3, hr: 3 },
    checkpoints: [checkpoint("fb-one", "Facebook"), checkpoint("fb-two", "Facebook"), checkpoint("general", "General"), checkpoint("october", "SM", "2026-10-01")],
    checkpointInteractions: { "fb-one": { 1: "Reacted", 2: "None" }, "fb-two": { 1: "None" }, general: { 1: "Participated" }, october: { 1: "None" } },
    hrEvaluations: { "2026-09_1": { responds: true, proofs: true, properComm: false } },
    finalEvaluations: {
      "2026-09_1": { suggestedScore: 8, finalScore: 0, note: '<img src="x" onerror="alert(1)">\nNeeds follow-up.' },
      "2026-09_2": { suggestedScore: 5, finalScore: 9, note: "Other member" },
      "2026-10_1": { suggestedScore: 4, finalScore: 5, note: "October evaluation" },
    },
    ...overrides,
  };
  const stored = new Map(Object.entries(state).map(([key, value]) => [key, JSON.stringify(value)]));
  const writes = [];
  const window = new Element("window");
  window.location = { search: `?id=${memberId}`, replace(url) { this.redirect = url; } };
  window.localStorage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => { stored.set(key, value); writes.push(key); },
    removeItem: (key) => stored.delete(key),
  };
  window.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
  window.dispatchEvent = (event) => window.fire(event.type, event);
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : ["2026-09-24T12:00:00"])); } }
  const document = { readyState: "complete", getElementById: (id) => elements[id], createElement: (tag) => new Element(tag), createDocumentFragment: () => new Element("fragment") };
  const context = vm.createContext({ window, document, URLSearchParams, Date: Clock, console });
  for (const file of ["data.js", "interaction-data.js", "member-details.js"]) vm.runInContext(fs.readFileSync(path.join(root, "js", file), "utf8"), context, { filename: file });
  const month = (value) => { elements["member-interaction-month"].value = value; elements["member-interaction-month"].fire("change"); };
  return { elements, stored, writes, window, month };
}

test("profile tabs have keyboard navigation and preserve the activity editor", () => {
  const app = setup();
  const { elements } = app;
  assert.equal(elements["profile-panel-overview"].hidden, false);
  assert.equal(elements["profile-panel-activities"].hidden, true);
  elements["profile-tab-overview"].fire("keydown", { key: "ArrowRight" });
  assert.equal(elements["profile-tab-activities"]["aria-selected"], "true");
  assert.equal(elements["profile-tab-activities"].tabIndex, 0);
  assert.equal(elements["profile-tab-activities"].focused, true);
  assert.equal(elements["profile-panel-overview"].hidden, true);
  assert.equal(elements["profile-panel-activities"].hidden, false);
  const row = elements["member-tasks-list"].querySelector("[data-status-activity-id]");
  elements["member-details-content"].fire("click", { target: row.querySelector(".profile-activity-title") });
  assert.equal(elements["status-dialog"].open, true);
  assert.equal(elements["member-dialog"].open, false);
  elements["status-value"].value = "done";
  elements["status-form"].fire("change");
  elements["status-form"].fire("submit");
  assert.equal(elements["status-dialog"].open, false);
  assert.equal(elements["tasks-done"].textContent, "1");
  assert.equal(elements["profile-panel-activities"].hidden, false, "Activity updates must not reset the active tab");
  elements["profile-tab-activities"].fire("keydown", { key: "End" });
  assert.equal(elements["profile-panel-interaction"].hidden, false);
  elements["profile-tab-interaction"].fire("keydown", { key: "ArrowRight" });
  assert.equal(elements["profile-panel-overview"].hidden, false);
});

test("member Interaction displays saved zero, safe notes, and scores from the shared engine", () => {
  const { elements, writes, stored } = setup();
  assert.equal(elements["member-interaction-month"].value, "2026-09");
  assert.equal(elements["member-interaction-error"].hidden, true);
  const cards = elements["member-interaction-stats"].children;
  assert.equal(cards.length, 4);
  assert.equal(cards[0].querySelector(".stat-number").textContent, "1 / 2");
  assert.match(cards[0].textContent, /1 interacted \/ 2 checked/);
  assert.equal(cards[1].querySelector(".stat-number").textContent, "2 / 2");
  assert.equal(cards[2].querySelector(".stat-number").textContent, "3 / 3");
  assert.match(cards[2].textContent, /full category weight/);
  assert.equal(cards[3].querySelector(".stat-number").textContent, "2 / 3");
  assert.equal(elements["member-interaction-suggested"].textContent, "8 / 10");
  assert.equal(elements["member-interaction-final"].textContent, "0 / 10");
  assert.equal(elements["member-interaction-note"].textContent, JSON.parse(stored.get("finalEvaluations"))["2026-09_1"].note);
  assert.equal(elements["member-interaction-note"].children.length, 0);
  assert.equal(writes.filter((key) => !["members", "activities"].includes(key)).length, 0);
});

test("selected month and member isolate their evaluations; missing records display Pending", () => {
  const app = setup();
  const before = Array.from(app.stored);
  const writesBefore = app.writes.length;
  app.month("2026-10");
  assert.equal(app.elements["member-interaction-final"].textContent, "5 / 10");
  assert.equal(app.elements["member-interaction-note"].textContent, "October evaluation");
  assert.equal(app.elements["member-interaction-suggested"].textContent, "4 / 10");
  app.month("2026-11");
  assert.equal(app.elements["member-interaction-final"].textContent, "Pending");
  assert.equal(app.elements["member-interaction-suggested"].textContent, "7 / 10");
  assert.match(app.elements["member-interaction-note"].textContent, /No evaluation has been saved/);
  assert.deepEqual(Array.from(app.stored), before);
  assert.equal(app.writes.length, writesBefore);
  const other = setup({ memberId: "2" });
  assert.equal(other.elements["member-interaction-final"].textContent, "9 / 10");
  assert.equal(other.elements["member-interaction-note"].textContent, "Other member");
});

test("Interaction refreshes on same-tab saves and cross-tab storage changes", () => {
  const app = setup();
  const activitiesBefore = app.stored.get("activities");
  app.window.YLYInteraction.saveEvaluation("2026-09", 1, { responds: false, proofs: false, properComm: true, finalScore: 6, note: "Updated" });
  assert.equal(app.elements["member-interaction-final"].textContent, "6 / 10");
  assert.equal(app.elements["member-interaction-note"].textContent, "Updated");
  app.stored.set("interactionSettings", JSON.stringify({ fb: 0, general: 0, sm: 4, hr: 6 }));
  app.window.fire("storage", { key: "interactionSettings" });
  assert.equal(app.elements["member-interaction-stats"].children[3].querySelector(".stat-number").textContent, "2 / 6");
  assert.equal(app.elements["member-interaction-suggested"].textContent, "6 / 10");
  assert.equal(app.elements["member-interaction-final"].textContent, "6 / 10", "Weights do not overwrite the saved final score");
  assert.equal(app.stored.get("activities"), activitiesBefore);
});

test("invalid interaction storage and invalid months clear stale scores without blocking activities", () => {
  const app = setup();
  app.month("");
  assert.equal(app.elements["member-interaction-error"].hidden, false);
  assert.equal(app.elements["member-interaction-results"].hidden, true);
  assert.equal(app.elements["member-details-content"].hidden, false);
  app.month("2026-09");
  assert.equal(app.elements["member-interaction-error"].hidden, true);
  app.stored.set("finalEvaluations", "invalid JSON");
  app.window.fire("storage", { key: "finalEvaluations" });
  assert.equal(app.elements["member-interaction-error"].hidden, false);
  assert.equal(app.elements["member-interaction-stats"].children.length, 0);
  assert.equal(app.elements["member-details-content"].hidden, false);
  const row = app.elements["member-tasks-list"].querySelector("[data-status-activity-id]");
  app.elements["member-details-content"].fire("click", { target: row });
  assert.equal(app.elements["status-dialog"].open, true);
  app.elements["status-value"].value = "done";
  app.elements["status-form"].fire("change");
  app.elements["status-form"].fire("submit");
  assert.equal(app.elements["status-dialog"].open, false);
  assert.equal(app.elements["tasks-done"].textContent, "1");
  assert.equal(app.stored.get("finalEvaluations"), "invalid JSON", "Malformed interaction data is never silently replaced");
});

test("archived members retain their read-only interaction history", () => {
  const app = setup({ overrides: { members: [{ id: 1, name: "Habiba", status: "Archived" }] } });
  assert.equal(app.elements["member-interaction-final"].textContent, "0 / 10");
  assert.equal(app.elements["member-tasks-list"].querySelectorAll("[data-status-activity-id]").length, 0);
});

test("page loads the shared scoring engine before the profile script", () => {
  assert.ok(html.indexOf('src="js/interaction-data.js"') < html.indexOf('src="js/member-details.js"'));
  for (const tab of ["overview", "activities", "interaction"]) {
    assert.match(html, new RegExp(`id="profile-tab-${tab}"[^>]+role="tab"[^>]+aria-controls="profile-panel-${tab}"`));
    assert.match(html, new RegExp(`id="profile-panel-${tab}"[^>]+role="tabpanel"[^>]+aria-labelledby="profile-tab-${tab}"`));
  }
});
