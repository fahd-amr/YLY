const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

class Element {
  constructor() {
    this.children = [];
    this.listeners = {};
    this.disabled = false;
    this.hidden = false;
    this.value = "";
    this.files = [];
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || "") + this.children.map((child) => child.textContent).join(""); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = []; this.text = ""; this.append(...children); }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  fire(name, event = {}) {
    return Promise.all((this.listeners[name] || []).map((callback) => callback({ target: this, ...event })));
  }
}

const root = path.join(__dirname, "..");
const confirmation = "Start a new cycle? This will archive all active items to clear the board, but keep past data saved in history.";

function initialData() {
  return {
    members: [
      { id: 1, name: "Habiba", committee: "SM", status: "Needs Follow-up", extra: { keep: true } },
      { id: 2, name: "Maha", committee: "SM", status: "Up to date" },
      { id: 3, name: "Jihad", committee: "SM", status: "Archived" },
    ],
    activities: [
      {
        id: 10, name: "Current task", type: "Task", date: "2026-09-24", deadline: "2099-10-25",
        proofRequired: true, proofType: "screenshot", targetMembers: [1, 2],
        memberStatuses: [
          { memberId: 1, status: "pending", history: [{ status: "excused", reason: "Family", date: "2026-09-23" }] },
          { memberId: 2, status: "done", proofReceived: true, proofType: "screenshot" },
          { memberId: 999, status: "excused", note: "Inactive history stays saved" },
        ],
        extra: { custom: ["keep", { nested: true }] },
      },
      {
        id: 20, name: "Earlier session", type: "Session", date: "2026-08-24", archived: true,
        proofRequired: false, proofType: "screenshot", targetMembers: [2],
        memberStatuses: [{ memberId: 2, status: "attended", history: ["pending", "attended"] }],
      },
    ],
  };
}

function setup({ initial = initialData(), rawStorage } = {}) {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const elements = {};
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)) elements[match[2]] = new Element();
  assert.ok(elements["start-cycle-btn"], "Dashboard must provide the cycle action");
  const storage = new Map(Object.entries(rawStorage || Object.fromEntries(Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]))));
  const controls = { confirmed: true, failRead: false, failWrite: false, failReload: false };
  const reads = [];
  const writes = [];
  const confirmations = [];
  const reloadSnapshots = [];
  const window = new Element();
  window.localStorage = {
    getItem(key) {
      reads.push(key);
      if (controls.failRead) throw new Error("Storage unavailable");
      return storage.get(key) ?? null;
    },
    setItem(key, value) {
      if (controls.failWrite) throw new Error("Storage quota exceeded");
      writes.push(key);
      storage.set(key, value);
    },
  };
  window.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
  window.dispatchEvent = (event) => window.fire(event.type, event);
  window.confirm = (message) => { confirmations.push(message); return controls.confirmed; };
  window.location = { reload() {
    if (controls.failReload) throw new Error("Reload unavailable");
    reloadSnapshots.push(Object.fromEntries(storage));
  } };
  const document = new Element();
  Object.assign(document, {
    readyState: "complete", getElementById: (id) => elements[id], createElement: () => new Element(),
  });
  const context = vm.createContext({ window, document, console });
  try {
    vm.runInContext(fs.readFileSync(path.join(root, "js/data.js"), "utf8"), context, { filename: "data.js" });
  } catch (error) {
    // Corrupt localStorage must not stop dashboard controls from reporting it.
    if (!rawStorage) throw error;
  }
  vm.runInContext(fs.readFileSync(path.join(root, "js/dashboard.js"), "utf8"), context, { filename: "dashboard.js" });
  reads.length = 0;
  writes.length = 0;
  return {
    elements, storage, controls, reads, writes, confirmations, reloadSnapshots,
    data: window.YLYData, start: () => elements["start-cycle-btn"].fire("click"),
  };
}

test("Cancel leaves storage untouched without reading or reloading", async () => {
  const fixture = setup();
  const before = Object.fromEntries(fixture.storage);
  fixture.controls.confirmed = false;
  await fixture.start();
  assert.deepEqual(fixture.confirmations, [confirmation]);
  assert.deepEqual(fixture.reads, []);
  assert.deepEqual(fixture.writes, []);
  assert.deepEqual(Object.fromEntries(fixture.storage), before);
  assert.equal(fixture.reloadSnapshots.length, 0);
  assert.equal(fixture.elements["start-cycle-btn"].disabled, false);
});

test("Confirm archives every activity once while preserving all member and historical data", async () => {
  const fixture = setup();
  const before = JSON.parse(fixture.storage.get("activities"));
  const membersBefore = fixture.storage.get("members");
  assert.equal(fixture.elements["total-pending-items"].textContent, "1");
  await fixture.start();
  assert.deepEqual(fixture.confirmations, [confirmation]);
  assert.deepEqual(fixture.writes, ["activities"]);
  assert.deepEqual(JSON.parse(fixture.storage.get("activities")), before.map((activity) => ({ ...activity, archived: true })));
  assert.equal(fixture.storage.get("members"), membersBefore);
  assert.equal(fixture.reloadSnapshots.length, 1);
  assert.deepEqual(fixture.reloadSnapshots[0], Object.fromEntries(fixture.storage));
  assert.equal(fixture.elements["total-members"].textContent, "2");
  assert.equal(fixture.elements["total-pending-items"].textContent, "0");
  assert.equal(fixture.elements["upcoming-deadlines-count"].textContent, "0");
  assert.equal(fixture.elements["dashboard-error"].hidden, true);
});

test("Cycle action reads fresh activities and new activities can populate the next cycle", async () => {
  const fixture = setup();
  const current = JSON.parse(fixture.storage.get("activities"));
  const added = {
    id: "other-tab", name: "Created in another tab", type: "Session", date: "2026-09-25",
    proofRequired: false, proofType: "screenshot", targetMembers: [1], memberStatuses: [{ memberId: 1, status: "pending" }],
  };
  fixture.storage.set("activities", JSON.stringify([...current, added]));
  await fixture.start();
  const archived = JSON.parse(fixture.storage.get("activities"));
  assert.equal(archived.length, 3);
  assert.equal(archived.find((activity) => activity.id === "other-tab").archived, true);
  fixture.data.saveActivities([...archived, { ...added, id: "next-cycle" }]);
  assert.equal(fixture.elements["total-pending-items"].textContent, "1");
  assert.equal(fixture.elements["total-members"].textContent, "2");
  assert.equal(JSON.parse(fixture.storage.get("activities")).filter((activity) => activity.archived).length, 3);
});

test("Read and write failures preserve saved data, display an alert and allow retry", async () => {
  for (const failure of ["failRead", "failWrite"]) {
    const fixture = setup();
    const before = Object.fromEntries(fixture.storage);
    fixture.controls[failure] = true;
    await fixture.start();
    assert.deepEqual(Object.fromEntries(fixture.storage), before);
    assert.deepEqual(fixture.writes, []);
    assert.equal(fixture.reloadSnapshots.length, 0);
    assert.equal(fixture.elements["dashboard-error"].hidden, false);
    assert.match(fixture.elements["dashboard-error"].textContent, /new cycle could not be started/i);
    assert.equal(fixture.elements["start-cycle-btn"].disabled, false);
    fixture.controls[failure] = false;
    await fixture.start();
    assert.equal(fixture.reloadSnapshots.length, 1);
    assert.equal(fixture.elements["dashboard-error"].hidden, true);
  }
});

test("Malformed activity storage is reported without replacing historical data", async () => {
  const fixture = setup({ rawStorage: { members: "[]", activities: "{broken" } });
  const before = Object.fromEntries(fixture.storage);
  await fixture.start();
  assert.deepEqual(Object.fromEntries(fixture.storage), before);
  assert.deepEqual(fixture.writes, []);
  assert.equal(fixture.reloadSnapshots.length, 0);
  assert.equal(fixture.elements["dashboard-error"].hidden, false);
  assert.equal(fixture.elements["start-cycle-btn"].disabled, false);
});

test("A reload failure reports the saved cycle accurately and retains the archive", async () => {
  const fixture = setup();
  fixture.controls.failReload = true;
  await fixture.start();
  assert.equal(fixture.reloadSnapshots.length, 0);
  assert.deepEqual(fixture.writes, ["activities"]);
  assert.ok(JSON.parse(fixture.storage.get("activities")).every((activity) => activity.archived));
  assert.match(fixture.elements["dashboard-error"].textContent, /cycle was started.*Reload this page/);
  assert.equal(fixture.elements["dashboard-error"].hidden, false);
  assert.equal(fixture.elements["start-cycle-btn"].disabled, false);
});

test("Invalid activity entries are never converted into empty archived records", async () => {
  for (const invalid of [null, "broken", 5, false, []]) {
    const fixture = setup();
    const activities = JSON.parse(fixture.storage.get("activities"));
    fixture.storage.set("activities", JSON.stringify([...activities, invalid]));
    const before = Object.fromEntries(fixture.storage);
    await fixture.start();
    assert.deepEqual(Object.fromEntries(fixture.storage), before);
    assert.deepEqual(fixture.writes, []);
    assert.equal(fixture.reloadSnapshots.length, 0);
    assert.match(fixture.elements["dashboard-error"].textContent, /invalid entry/);
    assert.equal(fixture.elements["dashboard-error"].hidden, false);
    assert.equal(fixture.elements["start-cycle-btn"].disabled, false);
  }
});

test("Empty activity collections remain empty when starting a new cycle", async () => {
  const fixture = setup({ initial: { ...initialData(), activities: [] } });
  await fixture.start();
  assert.equal(fixture.storage.get("activities"), "[]");
  assert.equal(JSON.parse(fixture.storage.get("members")).length, 3);
  assert.equal(fixture.reloadSnapshots.length, 1);
});

test("Starting a cycle is disabled during asynchronous restore and enabled afterward", async () => {
  const fixture = setup();
  let finishReading;
  const reading = new Promise((resolve) => { finishReading = resolve; });
  fixture.elements["restore-file"].files = [{ text: () => reading }];
  const restore = fixture.elements["restore-file"].fire("change");
  assert.equal(fixture.elements["start-cycle-btn"].disabled, true);
  await fixture.start();
  assert.deepEqual(fixture.confirmations, []);
  assert.deepEqual(fixture.writes, []);
  finishReading(JSON.stringify(initialData()));
  await restore;
  assert.equal(fixture.elements["start-cycle-btn"].disabled, false);
  assert.equal(fixture.reloadSnapshots.length, 1);
  assert.equal(JSON.parse(fixture.storage.get("activities"))[0].archived, undefined);
  await fixture.start();
  assert.equal(fixture.reloadSnapshots.length, 2);
  assert.ok(JSON.parse(fixture.storage.get("activities")).every((activity) => activity.archived));
});
