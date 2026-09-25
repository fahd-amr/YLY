const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

class Element {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.listeners = {};
    this.disabled = false;
    this.hidden = false;
    this.value = "";
    this.files = [];
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || "") + this.children.map((child) => child.textContent).join(""); }
  append(...children) {
    children.forEach((child) => { child.parent = this; this.children.push(child); });
  }
  replaceChildren(...children) { this.children = []; this.text = ""; this.append(...children); }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  fire(name, event = {}) {
    return Promise.all((this.listeners[name] || []).map((callback) => callback({ target: this, preventDefault() {}, ...event })));
  }
  click() { this.clickCount = (this.clickCount || 0) + 1; return this.fire("click"); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
}

const root = path.join(__dirname, "..");
const plain = (value) => JSON.parse(JSON.stringify(value));

function fixture() {
  return {
    members: [
      { id: 1, name: "Habiba", committee: "SM", status: "Needs Follow-up", joinedDate: "2026-08-01", preferences: { custom: ["Keep", 42] } },
      { id: 2, name: "Maha", committee: "SM", status: "Archived", privateNote: "Retain archive" },
    ],
    activities: [
      {
        id: 10, name: "Content", type: "Task", date: "2026-09-20", dueDate: "2026-09-22", deadline: "2026-09-22",
        proofRequired: true, proofType: "screenshot", targetMembers: [1],
        memberStatuses: [
          { memberId: 1, status: "pending", history: [{ status: "excused", reason: "Family", date: "2026-09-19", extension: { safe: true } }] },
          { memberId: 2, status: "done", proofReceived: true, proofType: "screenshot", history: ["pending", "done"], note: "Inactive history" },
          { memberId: 999, status: "excused", excuseReason: "Preserved missing member" },
        ],
        extension: { deep: [1, "unchanged", { value: false }] },
      },
      {
        id: "archived", name: "Archived Event", type: "Event", date: "2026-08-20", archived: true,
        proofRequired: false, proofType: "screenshot", targetMembers: [2, 999],
        memberStatuses: [{ memberId: 2, status: "attended" }, { memberId: 999, status: "absent" }],
      },
    ],
  };
}

function restoredFixture() {
  const data = fixture();
  data.members[0].name = "Restored Habiba";
  data.activities[0].name = "Restored Content";
  data.activities[0].memberStatuses[0].status = "done";
  return data;
}

function setup({ rawStorage, initial = fixture() } = {}) {
  const elements = {};
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)) elements[match[2]] = new Element(match[1]);
  // Required controls come from the real dashboard HTML.
  for (const id of ["backup-data-btn", "restore-data-btn", "restore-file", "backup-status", "backup-error"]) assert.ok(elements[id], `Expected #${id}`);
  const storage = new Map(Object.entries(rawStorage || Object.fromEntries(Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]))));
  const controls = { failWriteKey: "", failRead: false, failDownload: false, failURL: false, failReload: false };
  const writes = [];
  const notifications = [];
  const downloads = [];
  const objectURLs = new Map();
  const revoked = [];
  const timers = [];
  let reloads = 0;
  const window = new Element("window");
  window.localStorage = {
    getItem(key) {
      if (controls.failRead) throw new Error("Storage unavailable");
      return storage.get(key) ?? null;
    },
    setItem(key, value) {
      if (controls.failWriteKey === key) throw new Error(`Storage full: ${key}`);
      storage.set(key, value);
      writes.push({ key, value });
    },
    removeItem(key) { storage.delete(key); writes.push({ key, removed: true }); },
  };
  window.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
  window.dispatchEvent = (event) => {
    notifications.push({ key: event.detail?.key, snapshot: Object.fromEntries(storage) });
    window.fire(event.type, event);
  };
  window.Blob = Blob;
  window.URL = {
    createObjectURL(blob) {
      if (controls.failURL) throw new Error("Blob URL unavailable");
      const url = `blob:backup-${objectURLs.size + 1}`;
      objectURLs.set(url, blob);
      return url;
    },
    revokeObjectURL(url) { revoked.push(url); objectURLs.delete(url); },
  };
  window.setTimeout = (callback) => { timers.push(callback); return timers.length; };
  window.location = { reload() {
    if (controls.failReload) throw new Error("Reload blocked");
    reloads += 1;
  } };
  const document = new Element("document");
  Object.assign(document, {
    readyState: "complete", body: new Element("body"), getElementById: (id) => elements[id],
    createElement(tag) {
      const element = new Element(tag);
      if (tag === "a") element.click = () => {
        if (controls.failDownload) throw new Error("Download failed");
        downloads.push({ filename: element.download, href: element.href, blob: objectURLs.get(element.href) });
      };
      return element;
    },
  });
  const context = vm.createContext({ window, document, console });
  let initializationError;
  try {
    vm.runInContext(fs.readFileSync(path.join(root, "js/data.js"), "utf8"), context, { filename: "data.js" });
  } catch (error) {
    initializationError = error;
  }
  vm.runInContext(fs.readFileSync(path.join(root, "js/dashboard.js"), "utf8"), context, { filename: "dashboard.js" });
  writes.length = 0;
  notifications.length = 0;
  const backup = () => elements["backup-data-btn"].fire("click");
  const restore = async (payload) => {
    const content = typeof payload === "string" ? payload : JSON.stringify(payload);
    elements["restore-file"].files = [{ name: "YLY_Backup.json", text: async () => content }];
    elements["restore-file"].value = "C:/fakepath/YLY_Backup.json";
    await elements["restore-file"].fire("change");
  };
  const flushTimers = () => { while (timers.length) timers.shift()(); };
  return { window, document, elements, storage, controls, writes, notifications, downloads, revoked, objectURLs, initializationError, backup, restore, flushTimers, data: window.YLYData, reloads: () => reloads };
}

test("Backup downloads complete archived data, inactive history and extensions without writes", async () => {
  const { backup, storage, downloads, writes, notifications, document, elements, flushTimers, revoked } = setup();
  const before = Object.fromEntries(storage);
  await backup();
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].filename, "YLY_Backup.json");
  assert.equal(downloads[0].blob.type, "application/json");
  const saved = JSON.parse(await downloads[0].blob.text());
  assert.deepEqual(saved, fixture());
  assert.equal(saved.members[1].status, "Archived");
  assert.equal(saved.activities[0].memberStatuses[1].note, "Inactive history");
  assert.equal(saved.activities[0].memberStatuses[2].memberId, 999);
  assert.deepEqual(Object.fromEntries(storage), before);
  assert.equal(writes.length, 0);
  assert.equal(notifications.length, 0);
  assert.equal(elements["backup-error"].hidden, true);
  assert.equal(document.body.children.length, 0);
  assert.equal(revoked.length, 0);
  flushTimers();
  assert.deepEqual(revoked, [downloads[0].href]);
});

test("A downloaded backup can be restored with no loss of archive or historical metadata", async () => {
  const { backup, restore, storage, downloads, data, notifications, elements, reloads } = setup();
  await backup();
  const text = await downloads[0].blob.text();
  storage.set("members", "[]");
  storage.set("activities", "[]");
  await restore(text);
  assert.deepEqual(plain(data.getBackupData()), fixture());
  assert.equal(reloads(), 1);
  assert.equal(notifications.length, 2);
  assert.equal(elements["restore-file"].value, "");
  assert.equal(elements["backup-error"].hidden, true);
});

test("Restore commits both collections before notifying or reloading", async () => {
  const { restore, storage, writes, notifications, reloads, elements } = setup();
  const replacement = restoredFixture();
  await restore(replacement);
  assert.equal(reloads(), 1);
  assert.deepEqual(writes.map((write) => write.key), ["members", "activities"]);
  assert.deepEqual(JSON.parse(storage.get("members")), replacement.members);
  assert.deepEqual(JSON.parse(storage.get("activities")), replacement.activities);
  assert.deepEqual(notifications.map((notification) => notification.key), ["members", "activities"]);
  for (const notification of notifications) assert.deepEqual(notification.snapshot, Object.fromEntries(storage));
  assert.match(elements["backup-status"].textContent, /restored/i);
  assert.equal(elements["backup-data-btn"].disabled, false);
  assert.equal(elements["restore-data-btn"].disabled, false);
});

test("Legacy target records and status-only activities restore canonically while retaining missing members", async () => {
  const { restore, data, reloads } = setup();
  const legacy = {
    members: [{ id: "person", name: "Legacy Person", extra: { custom: true } }],
    activities: [
      { id: "legacy", type: "Task", screenshotRequired: true, targetMembers: [
        { memberId: "person", status: "done", proofReceived: true, history: ["pending", { status: "done", date: "2026-09-12", extension: [1] }] },
        { memberId: 999, status: "excused", reason: "Historical member" },
      ], other: "preserved" },
      { id: "canonical-only", type: "Session", memberStatuses: [{ memberId: "person", status: "attended" }], archived: true },
    ],
  };
  await restore(legacy);
  const activities = data.getActivities();
  assert.deepEqual(plain(activities[0].targetMembers), ["person", 999]);
  assert.equal(activities[0].memberStatuses[0].proofType, "screenshot");
  assert.deepEqual(plain(activities[0].memberStatuses[0].history), legacy.activities[0].targetMembers[0].history);
  assert.equal(activities[0].memberStatuses[1].reason, "Historical member");
  assert.equal(activities[0].other, "preserved");
  assert.deepEqual(plain(activities[1].targetMembers), ["person"]);
  assert.equal(activities[1].archived, true);
  assert.equal(reloads(), 1);
});

test("Invalid JSON, collection shapes, duplicate IDs and malformed assignment history never write", async () => {
  const invalid = [
    "{invalid", [], {}, { members: [], activities: {} }, { members: {}, activities: [] },
    { members: [null], activities: [] }, { members: [{ id: " " }], activities: [] },
    { members: [{ id: 1 }, { id: "1" }], activities: [] }, { members: [{ id: true }], activities: [] },
    { members: [], activities: [null] },
    { members: [], activities: [{ id: 1, targetMembers: [] }, { id: "1", targetMembers: [] }] },
    { members: [], activities: [{ id: 1 }] },
    { members: [], activities: [{ id: 1, targetMembers: {} }] },
    { members: [], activities: [{ id: 1, targetMembers: [null] }] },
    { members: [], activities: [{ id: 1, targetMembers: [1, "1"] }] },
    { members: [], activities: [{ id: 1, targetMembers: [{ status: "pending" }] }] },
    { members: [], activities: [{ id: 1, memberStatuses: [1] }] },
    { members: [], activities: [{ id: 1, memberStatuses: [{ memberId: 1, history: {} }] }] },
    { members: [], activities: [{ id: 1, memberStatuses: [{ memberId: 1, history: [null] }] }] },
    { members: [], activities: [{ id: 1, memberStatuses: [{ memberId: 1, history: [{ status: {} }] }] }] },
    { members: [], activities: [{ id: 1, memberStatuses: [{ memberId: 1, applied: "yes" }] }] },
    { members: [], activities: [{ id: 1, proofRequired: "yes", targetMembers: [] }] },
  ];
  for (const payload of invalid) {
    const { restore, storage, writes, notifications, reloads, elements } = setup();
    const before = Object.fromEntries(storage);
    await restore(payload);
    assert.deepEqual(Object.fromEntries(storage), before, JSON.stringify(payload));
    assert.equal(writes.length, 0);
    assert.equal(notifications.length, 0);
    assert.equal(reloads(), 0);
    assert.equal(elements["backup-error"].hidden, false);
    assert.equal(elements["restore-file"].value, "");
    assert.equal(elements["restore-data-btn"].disabled, false);
  }
});

test("A failed second restore write rolls back the first collection and permits retry", async () => {
  const { restore, storage, controls, notifications, reloads, elements } = setup();
  const before = Object.fromEntries(storage);
  controls.failWriteKey = "activities";
  await restore(restoredFixture());
  assert.deepEqual(Object.fromEntries(storage), before);
  assert.equal(notifications.length, 0);
  assert.equal(reloads(), 0);
  assert.equal(elements["backup-error"].hidden, false);
  assert.match(elements["backup-error"].textContent, /restored/i);
  assert.equal(elements["restore-file"].value, "");
  assert.equal(elements["restore-data-btn"].disabled, false);
  controls.failWriteKey = "";
  await restore(restoredFixture());
  assert.equal(reloads(), 1);
  assert.equal(elements["backup-error"].hidden, true);
});

test("First-write and snapshot-read failures leave all saved data unchanged", async () => {
  for (const failure of ["first-write", "snapshot-read"]) {
    const { restore, storage, controls, notifications, reloads, elements } = setup();
    const before = Object.fromEntries(storage);
    if (failure === "first-write") controls.failWriteKey = "members";
    else controls.failRead = true;
    await restore(restoredFixture());
    assert.deepEqual(Object.fromEntries(storage), before);
    assert.equal(notifications.length, 0);
    assert.equal(reloads(), 0);
    assert.equal(elements["backup-error"].hidden, false);
    assert.equal(elements["restore-data-btn"].disabled, false);
  }
});

test("Restore can recover malformed current storage despite initialization and dashboard errors", async () => {
  const { restore, storage, initializationError, elements, reloads } = setup({ rawStorage: { members: "invalid members", activities: "{bad json" } });
  assert.ok(initializationError);
  assert.equal(elements["dashboard-error"].hidden, false);
  await restore(restoredFixture());
  assert.equal(reloads(), 1);
  assert.equal(JSON.parse(storage.get("members"))[0].name, "Restored Habiba");
  assert.equal(elements["dashboard-error"].hidden, true);
});

test("Failed restore preserves even malformed original storage byte for byte", async () => {
  const original = { members: "bad members", activities: "bad activities" };
  const { restore, storage, controls, reloads } = setup({ rawStorage: original });
  controls.failWriteKey = "activities";
  await restore(restoredFixture());
  assert.deepEqual(Object.fromEntries(storage), original);
  assert.equal(reloads(), 0);
});

test("Restore rolls back a newly introduced key when the original collection was missing", async () => {
  const { restore, storage, controls, reloads } = setup({ rawStorage: { activities: "corrupt" } });
  controls.failWriteKey = "activities";
  await restore(restoredFixture());
  assert.equal(storage.has("members"), false);
  assert.equal(storage.get("activities"), "corrupt");
  assert.equal(reloads(), 0);
});

test("Cancelled selection and unreadable files cause no writes or reloads", async () => {
  const { elements, storage, writes, notifications, reloads } = setup();
  const before = Object.fromEntries(storage);
  await elements["restore-data-btn"].fire("click");
  assert.equal(elements["restore-file"].clickCount, 1);
  elements["restore-file"].files = [];
  await elements["restore-file"].fire("change");
  assert.equal(elements["backup-error"].hidden, true);
  elements["restore-file"].files = [{ name: "YLY_Backup.json", text: async () => { throw new Error("File read denied"); } }];
  elements["restore-file"].value = "backup.json";
  await elements["restore-file"].fire("change");
  assert.match(elements["backup-error"].textContent, /File read denied/);
  assert.equal(elements["restore-file"].value, "");
  assert.equal(elements["backup-data-btn"].disabled, false);
  assert.deepEqual(Object.fromEntries(storage), before);
  assert.equal(writes.length, 0);
  assert.equal(notifications.length, 0);
  assert.equal(reloads(), 0);
});

test("Controls remain disabled while a file is being read and ignore duplicate actions", async () => {
  const { elements, writes, downloads, reloads } = setup();
  let finishReading;
  const reading = new Promise((resolve) => { finishReading = resolve; });
  elements["restore-file"].files = [{ name: "YLY_Backup.json", text: () => reading }];
  const pendingRestore = elements["restore-file"].fire("change");
  assert.equal(elements["backup-data-btn"].disabled, true);
  assert.equal(elements["restore-data-btn"].disabled, true);
  await elements["backup-data-btn"].fire("click");
  await elements["restore-file"].fire("change");
  assert.equal(downloads.length, 0);
  assert.equal(writes.length, 0);
  finishReading(JSON.stringify(restoredFixture()));
  await pendingRestore;
  assert.equal(reloads(), 1);
  assert.equal(writes.length, 2);
  assert.equal(elements["restore-file"].disabled, false);
});

test("Backup read and download failures preserve data and clean temporary download resources", async () => {
  for (const failure of ["failRead", "failDownload", "failURL"]) {
    const { backup, storage, controls, downloads, writes, elements, document, flushTimers, objectURLs } = setup();
    const before = Object.fromEntries(storage);
    controls[failure] = true;
    await backup();
    flushTimers();
    assert.deepEqual(Object.fromEntries(storage), before);
    assert.equal(downloads.length, 0);
    assert.equal(writes.length, 0);
    assert.equal(elements["backup-error"].hidden, false);
    assert.equal(elements["backup-data-btn"].disabled, false);
    assert.equal(document.body.children.length, 0);
    assert.equal(objectURLs.size, 0);
  }
});

test("An empty backup is a valid intentional replacement and BOM-prefixed JSON is accepted", async () => {
  const { restore, data, reloads } = setup();
  await restore('\uFEFF{"members":[],"activities":[]}');
  assert.deepEqual(plain(data.getBackupData()), { members: [], activities: [] });
  assert.equal(reloads(), 1);
});

test("If reload is unavailable, successful restore is reported accurately and stays saved", async () => {
  const { restore, controls, storage, elements, reloads } = setup();
  controls.failReload = true;
  await restore(restoredFixture());
  assert.equal(reloads(), 0);
  assert.equal(JSON.parse(storage.get("members"))[0].name, "Restored Habiba");
  assert.equal(elements["backup-error"].hidden, true);
  assert.match(elements["backup-status"].textContent, /restored.*Reload the page/i);
});
