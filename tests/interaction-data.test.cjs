const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../js/interaction-data.js"), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));
const defaultMembers = [{ id: 1, name: "Habiba", status: "Up to date" }, { id: 2, name: "Maha", status: "Up to date" }, { id: 3, name: "Jihad", status: "Archived" }];
const evaluation = (overrides = {}) => ({ responds: true, proofs: false, properComm: true, finalScore: 7, note: "Reviewed carefully", ...overrides });
const defaults = () => ({ interactionSettings: { fb: 2, general: 2, sm: 3, hr: 3 }, checkpoints: [], checkpointInteractions: {}, hrEvaluations: {}, finalEvaluations: {} });
const checkpoint = (id, type = "Facebook", date = "2026-09-23", interactionExpected = "Yes") => ({ id, type, date, month: date.slice(0, 7), interactionExpected, title: "Checkpoint " + id });

function setup(initial = {}, members = defaultMembers) {
  const stored = new Map(Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]));
  const writes = [];
  const events = [];
  const controls = { failRead: false, failWriteKey: "", notifyFails: false };
  const window = {
    localStorage: {
      getItem(key) {
        if (controls.failRead) throw new Error("Storage is unavailable");
        return stored.has(key) ? stored.get(key) : null;
      },
      setItem(key, value) {
        if (controls.failWriteKey === key) {
          controls.failWriteKey = "";
          throw new Error("Quota exceeded");
        }
        stored.set(key, value);
        writes.push(key);
      },
      removeItem(key) { stored.delete(key); },
    },
    YLYData: { getMembers: () => members, isMemberArchived: (member) => member.status === "Archived" },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    dispatchEvent(event) { if (controls.notifyFails) throw new Error("Listener error"); events.push(event); },
  };
  vm.runInNewContext(source, { window });
  return { api: window.YLYInteraction, stored, writes, events, controls, window };
}

test("initialization seeds the five missing keys once without touching members or activities", () => {
  const { api, stored, writes } = setup({ members: defaultMembers, activities: [{ id: 10, memberStatuses: [{ memberId: 1, status: "done" }] }] });
  const original = new Map(stored);
  assert.deepEqual(plain(api.initialize()), defaults());
  assert.equal(writes.length, 5);
  api.initialize();
  assert.equal(writes.length, 5);
  assert.equal(stored.get("members"), original.get("members"));
  assert.equal(stored.get("activities"), original.get("activities"));
});

test("corrupt or invalid saved values are never overwritten and no missing defaults are partially seeded", () => {
  for (const initial of [
    { interactionSettings: { fb: 2, general: 2, sm: 3, hr: 2 } },
    { checkpoints: {} },
    { checkpointInteractions: [] },
    { hrEvaluations: { "2026-09_1": { responds: "yes", proofs: false, properComm: false } } },
    { finalEvaluations: { "2026-09_1": { finalScore: 1.5, suggestedScore: 3, note: "" } } },
  ]) {
    const { api, stored, writes } = setup(initial);
    const before = [...stored];
    assert.throws(() => api.initialize());
    assert.deepEqual([...stored], before);
    assert.deepEqual(writes, []);
  }
  const { api, stored, writes } = setup();
  stored.set("hrEvaluations", "{broken");
  assert.throws(() => api.initialize(), /invalid JSON/);
  assert.equal(stored.get("hrEvaluations"), "{broken");
  assert.equal(writes.length, 0);
});

test("failed default initialization rolls all newly created keys back", () => {
  const { api, stored, controls, events } = setup();
  controls.failWriteKey = "hrEvaluations";
  assert.throws(() => api.initialize(), /Previous data was kept/);
  assert.equal(stored.size, 0);
  assert.equal(events.length, 0);
});

test("weights require explicit whole numbers in range and an exact total of ten", () => {
  const { api, stored } = setup(defaults());
  const before = stored.get("interactionSettings");
  for (const bad of [
    { fb: 2, general: 2, sm: 3, hr: 2 },
    { fb: "2", general: 2, sm: 3, hr: 3 },
    { fb: 1.5, general: 2.5, sm: 3, hr: 3 },
    { fb: -1, general: 5, sm: 3, hr: 3 },
    { fb: 2, general: 2, sm: 6 },
    { fb: 0, general: 0, sm: 0, hr: 11 },
  ]) assert.throws(() => api.saveSettings(bad), /Weights must total 10/);
  assert.equal(stored.get("interactionSettings"), before);
  api.saveSettings({ fb: 10, general: 0, sm: 0, hr: 0 });
  assert.deepEqual(plain(api.read().interactionSettings), { fb: 10, general: 0, sm: 0, hr: 0 });
});

test("checkpoint dates use actual calendar days and derive their own month", () => {
  const { api } = setup(defaults());
  for (const date of ["2026-02-29", "2026-04-31", "2026-13-01", "2026-09-00", "0000-01-01", "2026-09-23T00:00:00Z"]) {
    assert.throws(() => api.addCheckpoint({ type: "SM", title: "Review", date }), /valid checkpoint date/);
  }
  assert.throws(() => api.addCheckpoint({ type: "Task", title: "Review", date: "2026-09-23" }), /Facebook/);
  assert.throws(() => api.addCheckpoint({ type: "SM", title: " ", date: "2026-09-23" }), /title/);
  const cp = api.addCheckpoint({ type: "General", title: "  Leap review  ", date: "2028-02-29", month: "1999-01", interactionExpected: "No" });
  assert.equal(cp.month, "2028-02");
  assert.equal(cp.title, "Leap review");
  assert.equal(cp.interactionExpected, "No");
  const other = api.addCheckpoint({ type: "SM", title: "Review", date: "2026-09-23" });
  assert.notEqual(cp.id, other.id);
  assert.equal(other.interactionExpected, "Yes");
});

test("duplicate stored checkpoint IDs and mismatched months are rejected", () => {
  const duplicate = setup({ ...defaults(), checkpoints: [checkpoint(1), checkpoint("1")] });
  assert.throws(() => duplicate.api.read(), /duplicate ID/);
  const wrongMonth = setup({ ...defaults(), checkpoints: [{ ...checkpoint(1), month: "2026-10" }] });
  assert.throws(() => wrongMonth.api.read(), /must match/);
});

test("interaction writes validate type-specific choices and active members before any mutation", () => {
  const { api, stored, writes } = setup({ ...defaults(), checkpoints: [checkpoint("fb"), checkpoint("sm", "SM")] });
  for (const [id, update] of [["fb", { 1: "Participated" }], ["sm", { 1: "Shared" }], ["fb", { 3: "Reacted" }], ["fb", { 99: "None" }], ["missing", { 1: "Reacted" }]]) {
    assert.throws(() => api.saveCheckpointInteractions(id, update));
  }
  assert.equal(writes.length, 0);
  assert.equal(stored.get("checkpointInteractions"), "{}");
  api.saveCheckpointInteractions("fb", { 1: "Commented", 2: "Shared" });
  api.saveCheckpointInteractions("sm", { 1: "Replied", 2: "None" });
  assert.equal(api.read().checkpointInteractions.fb[2], "Shared");
});

test("updates preserve other members, archived member history, and other checkpoints using the freshest data", () => {
  const initial = { ...defaults(), checkpoints: [checkpoint("fb"), checkpoint("sm", "SM")], checkpointInteractions: { fb: { 1: "None", 3: "Commented" }, sm: { 2: "Participated" }, historic: { 90: "Shared" } } };
  const { api, stored } = setup(initial);
  api.read();
  initial.checkpointInteractions.fb[2] = "Reacted";
  stored.set("checkpointInteractions", JSON.stringify(initial.checkpointInteractions));
  api.saveCheckpointInteractions("fb", { 1: "Shared" });
  assert.deepEqual(plain(api.read().checkpointInteractions), { fb: { 1: "Shared", 2: "Reacted", 3: "Commented" }, sm: { 2: "Participated" }, historic: { 90: "Shared" } });
});

test("hostile member and checkpoint property names behave as ordinary IDs", () => {
  const members = [{ id: "__proto__", status: "Up to date" }, { id: "constructor", status: "Up to date" }];
  const { api } = setup({ ...defaults(), checkpoints: [checkpoint("__proto__"), checkpoint("constructor", "SM")] }, members);
  const updates = JSON.parse('{"__proto__":"Shared","constructor":"None"}');
  api.saveCheckpointInteractions("__proto__", updates);
  api.saveCheckpointInteractions("constructor", JSON.parse('{"__proto__":"Participated"}'));
  const stats = api.calculateMember("2026-09", "__proto__");
  assert.equal(stats.categories.fb.interacted, 1);
  assert.equal(stats.categories.sm.interacted, 1);
  assert.equal(stats.suggestedScore, 7);
  api.saveEvaluation("2026-09", "__proto__", evaluation({ finalScore: 0 }));
  assert.equal(api.read().finalEvaluations["2026-09___proto__"].finalScore, 0);
  assert.equal({}.polluted, undefined);
});

test("engagement counts explicitly checked checkpoints only and separates months, members, and No checkpoints", () => {
  const { api } = setup({
    ...defaults(),
    checkpoints: [checkpoint("fb1"), checkpoint("fb2"), checkpoint("unlogged"), checkpoint("ignored", "Facebook", "2026-09-24", "No"), checkpoint("oct", "Facebook", "2026-10-01"), checkpoint("general", "General"), checkpoint("sm", "SM")],
    checkpointInteractions: { fb1: { 1: "Reacted", 2: "None" }, fb2: { 1: "None", 2: "Commented" }, ignored: { 1: "None" }, oct: { 1: "Shared" }, general: { 1: "Participated" }, sm: { 2: "Replied" } },
  });
  const stats = api.calculateMember("2026-09", 1);
  assert.deepEqual(plain(stats.categories.fb), { interacted: 1, checked: 2, total: 3, score: 1, weight: 2 });
  assert.deepEqual(plain(stats.categories.general), { interacted: 1, checked: 1, total: 1, score: 2, weight: 2 });
  assert.deepEqual(plain(stats.categories.sm), { interacted: 0, checked: 0, total: 1, score: 3, weight: 3 });
  assert.equal(stats.suggestedScore, 6);
  assert.equal(stats.missingLogs, 2);
  assert.equal(stats.needsReview, true);
  assert.equal(api.calculateMember("2026-10", 1).suggestedScore, 7);
  assert.equal(api.calculateMember("2026-09", 2).categories.sm.score, 3);
});

test("no checked checkpoints award the full category weights while unchecked HR earns zero", () => {
  const { api } = setup(defaults());
  const stats = api.calculateMember("2026-09", 1);
  assert.equal(stats.suggestedScore, 7);
  assert.deepEqual(Object.values(stats.categories).map((category) => category.score), [2, 2, 3]);
  assert.equal(stats.hr.score, 0);
  assert.equal(stats.missingLogs, 0);
  assert.equal(stats.finalEvaluation, null);
  assert.equal(stats.needsReview, true);
});

test("the default HR checklist gives one point per check and custom HR weights scale to ten", () => {
  const { api } = setup(defaults());
  const checklist = { responds: true, proofs: false, properComm: true };
  assert.equal(api.calculateMember("2026-09", 1, undefined, checklist).hr.score, 2);
  api.saveSettings({ fb: 0, general: 0, sm: 0, hr: 10 });
  assert.equal(api.calculateMember("2026-09", 1, undefined, checklist).suggestedScore, 6.67);
  assert.equal(api.calculateMember("2026-09", 1, undefined, { ...checklist, proofs: true }).suggestedScore, 10);
});

test("suggested score rounds the sum of raw weighted parts rather than each displayed part", () => {
  const data = defaults();
  data.interactionSettings = { fb: 2, general: 2, sm: 2, hr: 4 };
  for (const type of ["Facebook", "General", "SM"]) {
    for (let number = 0; number < 3; number += 1) {
      const cp = checkpoint(type + number, type);
      data.checkpoints.push(cp);
      data.checkpointInteractions[cp.id] = { 1: number === 0 ? "Reacted" : "None" };
    }
  }
  const { api } = setup(data);
  const stats = api.calculateMember("2026-09", 1);
  assert.equal(stats.categories.fb.score, 0.67);
  assert.equal(stats.suggestedScore, 2);
});

test("evaluation save recalculates suggestions and accepts integer zero while isolating member and month", () => {
  const savedOther = { suggestedScore: 3, finalScore: 4, note: "Preserve" };
  const { api, events } = setup({ ...defaults(), finalEvaluations: { "2026-09_2": savedOther, "2026-08_1": savedOther } });
  const saved = api.saveEvaluation("2026-09", 1, evaluation({ finalScore: 0, suggestedScore: 10 }));
  assert.equal(saved.suggestedScore, 9);
  assert.equal(saved.finalScore, 0);
  const state = api.read();
  assert.deepEqual(plain(state.finalEvaluations["2026-09_2"]), savedOther);
  assert.deepEqual(plain(state.finalEvaluations["2026-08_1"]), savedOther);
  assert.deepEqual(plain(state.hrEvaluations["2026-09_1"]), { responds: true, proofs: false, properComm: true });
  assert.equal(api.calculateMember("2026-09", 1).needsReview, false);
  assert.equal(events.length, 1);
  assert.deepEqual(plain(events[0].detail.keys), ["hrEvaluations", "finalEvaluations"]);
});

test("invalid final scores, HR checkboxes, months, and archived members do not change storage", () => {
  const { api, stored } = setup(defaults());
  const original = [...stored];
  for (const finalScore of [null, "3", 1.1, -1, 11, NaN]) assert.throws(() => api.saveEvaluation("2026-09", 1, evaluation({ finalScore })), /final score/);
  assert.throws(() => api.saveEvaluation("2026-09", 1, evaluation({ proofs: "true" })), /checkbox/);
  assert.throws(() => api.saveEvaluation("2026-13", 1, evaluation()), /month/);
  assert.throws(() => api.saveEvaluation("2026-09", 3, evaluation()), /active member/);
  assert.throws(() => api.saveEvaluation("2026-09", 1, evaluation({ note: null })), /text/);
  assert.deepEqual([...stored], original);
});

test("a failed second evaluation write rolls back the HR write without emitting a success event", () => {
  const { api, stored, controls, events } = setup(defaults());
  const before = [...stored];
  controls.failWriteKey = "finalEvaluations";
  assert.throws(() => api.saveEvaluation("2026-09", 1, evaluation()), /Previous data was kept/);
  assert.deepEqual([...stored], before);
  assert.equal(events.length, 0);
});

test("a failed notification does not turn a successful write into a save error", () => {
  const { api, controls } = setup(defaults());
  controls.notifyFails = true;
  assert.doesNotThrow(() => api.saveEvaluation("2026-09", 1, evaluation()));
  assert.equal(api.read().finalEvaluations["2026-09_1"].finalScore, 7);
});

test("new logs or changed weights mark old suggestions for review without changing final decisions", () => {
  const { api } = setup({ ...defaults(), checkpoints: [checkpoint(1)] });
  api.saveCheckpointInteractions(1, { 1: "None" });
  api.saveEvaluation("2026-09", 1, evaluation({ responds: false, properComm: false, finalScore: 0 }));
  assert.equal(api.calculateMember("2026-09", 1).needsReview, false);
  api.saveCheckpointInteractions(1, { 1: "Reacted" });
  let stats = api.calculateMember("2026-09", 1);
  assert.equal(stats.suggestedScore, 7);
  assert.equal(stats.needsReview, true);
  assert.equal(stats.finalEvaluation.finalScore, 0);
  api.saveEvaluation("2026-09", 1, evaluation({ responds: false, properComm: false, finalScore: 3 }));
  api.saveSettings({ fb: 4, general: 0, sm: 2, hr: 4 });
  stats = api.calculateMember("2026-09", 1);
  assert.equal(stats.needsReview, true);
  assert.equal(stats.finalEvaluation.finalScore, 3);
});

test("incomplete log coverage remains visible even after an explicit final decision", () => {
  const { api } = setup({ ...defaults(), checkpoints: [checkpoint(1)] });
  api.saveEvaluation("2026-09", 1, evaluation());
  const stats = api.calculateMember("2026-09", 1);
  assert.equal(stats.missingLogs, 1);
  assert.equal(stats.needsReview, true);
  assert.equal(stats.finalEvaluation.finalScore, 7);
});

test("historical extensions and unrelated evaluation entries survive updates", () => {
  const { api } = setup({ ...defaults(), hrEvaluations: { "2026-09_1": { responds: false, proofs: false, properComm: false, custom: "keep" } }, finalEvaluations: { "2026-09_1": { suggestedScore: 0, finalScore: 2, note: "old", audit: "preserve" } } });
  api.saveEvaluation("2026-09", 1, evaluation());
  assert.equal(api.read().hrEvaluations["2026-09_1"].custom, "keep");
  assert.equal(api.read().finalEvaluations["2026-09_1"].audit, "preserve");
});

test("explicit No Interaction earns zero for that category while an unchecked category gets full weight", () => {
  const { api } = setup({ ...defaults(), checkpoints: [checkpoint("fb"), checkpoint("sm", "SM")], checkpointInteractions: { fb: { 1: "None" } } });
  const result = api.calculateMember("2026-09", 1);
  assert.equal(result.categories.fb.score, 0);
  assert.equal(result.categories.sm.score, 3);
  assert.equal(result.categories.general.score, 2);
  assert.equal(result.suggestedScore, 5);
  assert.equal(result.missingLogs, 1);
});

test("the shared current month follows the local calendar at a UTC month boundary", () => {
  const { api } = setup();
  const localDate = { getFullYear: () => 2026, getMonth: () => 8 };
  assert.equal(api.currentMonth(localDate), "2026-09");
  assert.throws(() => api.currentMonth(new Date(NaN)), /valid month/);
});
