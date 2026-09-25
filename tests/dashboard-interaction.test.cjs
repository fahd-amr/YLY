const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");

class Element {
  constructor(tag = "div") {
    this.tagName = tag;
    this.children = [];
    this.listeners = {};
    this.hidden = false;
    this.disabled = false;
    this.value = "";
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || "") + this.children.map((child) => child.textContent).join(""); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = []; this.text = ""; this.append(...children); }
  addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
  fire(type, event = {}) { return Promise.all((this.listeners[type] || []).map((callback) => callback({ target: this, ...event }))); }
}

function evaluation(finalScore, suggestedScore = 7) { return { finalScore, suggestedScore, note: "Saved review" }; }

function initialData() {
  return {
    members: [
      { id: 1, name: "Habiba", committee: "SM", status: "Needs Follow-up" },
      { id: 2, name: "Maha", committee: "SM", status: "Up to date" },
      { id: 3, name: "Archived Member", committee: "SM", status: "Archived" },
      { id: 4, name: "Jihad", committee: "SM", status: "Up to date" },
    ],
    activities: [{
      id: 10, name: "Existing task", type: "Task", date: "2026-09-24", deadline: "2099-09-24",
      proofRequired: false, targetMembers: [1], memberStatuses: [{ memberId: 1, status: "pending" }],
    }],
    interactionSettings: { fb: 2, general: 2, sm: 3, hr: 3 },
    checkpoints: [{ id: 20, month: "2026-09", type: "Facebook", title: "Post", date: "2026-09-24", interactionExpected: "Yes" }],
    checkpointInteractions: {},
    hrEvaluations: {},
    finalEvaluations: {
      "2026-09_1": evaluation(0, 0),
      "2026-09_3": evaluation(10),
      "2026-08_2": evaluation(9),
      "2026-10_2": evaluation(8),
      "2026-09_999": evaluation(10),
    },
  };
}

function setup({ initial = initialData(), corrupt = {}, loadInteraction = true } = {}) {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const elements = {};
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)) elements[match[2]] = new Element(match[1]);
  const storage = new Map(Object.entries({
    ...Object.fromEntries(Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)])),
    ...corrupt,
  }));
  const writes = [];
  const controls = { now: new Date(2026, 8, 24, 12, 0, 0) };
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [controls.now.getTime()])); }
    static now() { return controls.now.getTime(); }
  }
  const window = new Element();
  window.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem(key, value) { writes.push(key); storage.set(key, String(value)); },
    removeItem: (key) => storage.delete(key),
  };
  window.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
  window.dispatchEvent = (event) => window.fire(event.type, event);
  const document = {
    readyState: "complete", getElementById: (id) => elements[id], createElement: (tag) => new Element(tag),
  };
  const context = vm.createContext({ window, document, console, Date: ClockDate });
  const scripts = ["data.js", ...(loadInteraction ? ["interaction-data.js"] : []), "dashboard.js"];
  scripts.forEach((file) => vm.runInContext(fs.readFileSync(path.join(root, "js", file), "utf8"), context, { filename: file }));
  writes.length = 0;
  return { elements, storage, writes, window, controls, api: window.YLYInteraction, data: window.YLYData };
}

function assertCounts(fixture, completed, pending) {
  assert.equal(fixture.elements["interaction-completed-count"].textContent, String(completed));
  assert.equal(fixture.elements["interaction-pending-count"].textContent, String(pending));
}

function descendants(element) { return element.children.flatMap((child) => [child, ...descendants(child)]); }

test("Dashboard counts current-month final scores including zero and excludes archived or unknown members", () => {
  const fixture = setup();
  assertCounts(fixture, 1, 2);
  assert.equal(fixture.elements["interaction-review-month"].textContent, "September 2026");
  const list = fixture.elements["interaction-follow-up-list"];
  assert.equal(list.children.length, 2);
  assert.match(list.textContent, /Maha.*Interaction Evaluation Pending/);
  assert.match(list.textContent, /Jihad.*Interaction Evaluation Pending/);
  assert.doesNotMatch(list.textContent, /Habiba|Archived Member/);
  const links = descendants(list).filter((element) => element.tagName === "a");
  assert.deepEqual(links.map((link) => link.href), [
    "interaction.html?month=2026-09&member=2", "interaction.html?month=2026-09&member=4",
  ]);
  // Habiba has both a stale suggestion and an unchecked checkpoint, but has a final score.
  assert.equal(fixture.api.calculateMember("2026-09", 1).needsReview, true);
  assert.equal(fixture.elements["total-pending-items"].textContent, "1");
  assert.equal(fixture.elements["dashboard-error"].hidden, true);
});

test("New interaction storage defaults make every active member pending without changing activity data", () => {
  const initial = initialData();
  const fixture = setup({ initial: { members: initial.members, activities: initial.activities } });
  assertCounts(fixture, 0, 3);
  assert.deepEqual(JSON.parse(fixture.storage.get("finalEvaluations")), {});
  assert.equal(fixture.elements["total-pending-items"].textContent, "1");
  assert.equal(fixture.elements["interaction-follow-up-list"].children.length, 3);
});

test("Saving an evaluation refreshes the dashboard immediately without writing members or activities", () => {
  const fixture = setup();
  const before = [fixture.storage.get("members"), fixture.storage.get("activities")];
  fixture.api.saveEvaluation("2026-09", 2, { responds: true, proofs: false, properComm: false, finalScore: 0, note: "Override" });
  assertCounts(fixture, 2, 1);
  assert.doesNotMatch(fixture.elements["interaction-follow-up-list"].textContent, /Maha/);
  assert.deepEqual([fixture.storage.get("members"), fixture.storage.get("activities")], before);
  assert.deepEqual(fixture.writes, ["hrEvaluations", "finalEvaluations"]);
  assert.equal(fixture.elements["total-pending-items"].textContent, "1");
});

test("Native storage events reflect new and removed final evaluations from another tab", async () => {
  const fixture = setup();
  const finals = JSON.parse(fixture.storage.get("finalEvaluations"));
  finals["2026-09_4"] = evaluation(10);
  fixture.storage.set("finalEvaluations", JSON.stringify(finals));
  await fixture.window.fire("storage", { key: "finalEvaluations" });
  assertCounts(fixture, 2, 1);
  delete finals["2026-09_1"];
  fixture.storage.set("finalEvaluations", JSON.stringify(finals));
  await fixture.window.fire("storage", { key: null });
  assertCounts(fixture, 1, 2);
  assert.match(fixture.elements["interaction-follow-up-list"].textContent, /Habiba/);
});

test("Archived members disappear from interaction pending totals through existing member events", () => {
  const fixture = setup();
  fixture.data.saveMembers(fixture.data.getMembers().map((member) => member.id === 2 ? { ...member, status: "Archived", archived: true } : member));
  assertCounts(fixture, 1, 1);
  assert.doesNotMatch(fixture.elements["interaction-follow-up-list"].textContent, /Maha/);
  assert.equal(fixture.elements["total-members"].textContent, "2");
});

test("Initializing a removed storage key never duplicates pending members through synchronous change events", async () => {
  const fixture = setup();
  fixture.storage.delete("finalEvaluations");
  await fixture.window.fire("storage", { key: "finalEvaluations" });
  assertCounts(fixture, 0, 3);
  const list = fixture.elements["interaction-follow-up-list"];
  assert.equal(list.children.length, 3);
  assert.deepEqual(descendants(list).filter((node) => node.tagName === "a").map((node) => node.textContent), ["Habiba", "Maha", "Jihad"]);
  assert.deepEqual(fixture.writes, ["finalEvaluations"]);
  assert.equal(fixture.elements["dashboard-interaction-error"].hidden, true);
  fixture.api.saveEvaluation("2026-09", 2, { responds: false, proofs: false, properComm: false, finalScore: 0, note: "Later save" });
  assertCounts(fixture, 1, 2);
  assert.equal(list.children.length, 2);
});

test("Malformed interaction storage stays isolated from activity dashboard and can recover", async () => {
  for (const key of ["interactionSettings", "checkpoints", "checkpointInteractions", "hrEvaluations", "finalEvaluations"]) {
    const fixture = setup({ corrupt: { [key]: "{broken" } });
    assertCounts(fixture, "\u2014", "\u2014");
    assert.equal(fixture.elements["dashboard-interaction-error"].hidden, false);
    assert.match(fixture.elements["dashboard-interaction-error"].textContent, /Interaction reviews could not be loaded/);
    assert.equal(fixture.elements["total-pending-items"].textContent, "1");
    assert.equal(fixture.elements["dashboard-error"].hidden, true);
    assert.deepEqual(fixture.writes, []);
    assert.equal(fixture.storage.get(key), "{broken");
    fixture.storage.set(key, JSON.stringify(initialData()[key]));
    await fixture.window.fire("storage", { key });
    assertCounts(fixture, 1, 2);
    assert.equal(fixture.elements["dashboard-interaction-error"].hidden, true);
  }
});

test("Interaction links and member labels safely handle custom IDs and HTML-like names", () => {
  const initial = initialData();
  initial.members.push({ id: "member/a ?#", name: '<img src=x onerror="alert(1)">', committee: "<b>SM</b>", status: "Up to date" });
  const fixture = setup({ initial });
  const list = fixture.elements["interaction-follow-up-list"];
  assert.match(list.textContent, /<img src=x/);
  const nodes = descendants(list);
  assert.equal(nodes.some((node) => node.tagName === "img" || node.tagName === "b"), false);
  assert.equal(nodes.find((node) => node.tagName === "a" && node.textContent.startsWith("<img")).href,
    "interaction.html?month=2026-09&member=member%2Fa%20%3F%23");
});

test("Returning to the dashboard after a month boundary uses the new local calendar month", async () => {
  const fixture = setup();
  fixture.controls.now = new Date(2026, 9, 1, 0, 1);
  await fixture.window.fire("focus");
  assert.equal(fixture.elements["interaction-review-month"].textContent, "October 2026");
  assertCounts(fixture, 1, 2);
  assert.match(fixture.elements["interaction-follow-up-list"].textContent, /Habiba/);
  assert.doesNotMatch(fixture.elements["interaction-follow-up-list"].textContent, /Maha/);
});

test("Missing interaction script does not prevent existing activity statistics from rendering", () => {
  const fixture = setup({ loadInteraction: false });
  assertCounts(fixture, "\u2014", "\u2014");
  assert.equal(fixture.elements["dashboard-interaction-error"].hidden, false);
  assert.equal(fixture.elements["total-members"].textContent, "3");
  assert.equal(fixture.elements["total-pending-items"].textContent, "1");
});

test("Empty member lists show an empty interaction state with no pending evaluations", () => {
  const fixture = setup({ initial: { ...initialData(), members: [] } });
  assertCounts(fixture, 0, 0);
  assert.equal(fixture.elements["interaction-follow-up-list"].textContent, "No active members to evaluate.");
});
