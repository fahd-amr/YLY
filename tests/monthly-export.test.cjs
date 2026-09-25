const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

// Exercise the real summary renderer and export listener against isolated
// storage. SheetJS is mocked here; workbook download is checked separately.
class Element {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.value = "";
    this.hidden = false;
    this.disabled = false;
    this.listeners = {};
    this.children = [];
    this.dataset = {};
    this.classList = { toggle() {} };
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text || ""; }
  setAttribute(name, value) { this[name] = value; }
  removeAttribute(name) { delete this[name]; }
  addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
  fire(name, event = {}) {
    for (const listener of this.listeners[name] || []) listener({ target: this, preventDefault() {}, ...event });
  }
  focus() { this.focused = true; }
}

const root = path.join(__dirname, "..");
const plain = (value) => JSON.parse(JSON.stringify(value));
const columns = [
  "Name", "Technical Evaluation /50", "Field Visits Entered", "Meetings Entered",
  "Interaction /10", "Respect Hierarchy /10", "Bonus /10", "Tasks Done Late",
];
const manualColumns = ["Technical Evaluation /50", "Respect Hierarchy /10", "Bonus /10"];
const expectedRow = (name, visits, meetings, interaction = "", lateTasks = 0) => ({
  "Name": name, "Technical Evaluation /50": "", "Field Visits Entered": visits,
  "Meetings Entered": meetings, "Interaction /10": interaction, "Respect Hierarchy /10": "", "Bonus /10": "",
  "Tasks Done Late": lateTasks,
});

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function monthRange(month) {
  const [year, number] = month.split("-").map(Number);
  return [`${month}-01`, `${month}-${new Date(year, number, 0).getDate()}`];
}

function fixtures() {
  const now = new Date();
  const month = monthKey(now);
  const previousMonth = monthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const members = [
    { id: 1, name: "Habiba & Team", committee: "SM", status: "Needs Follow-up" },
    { id: 2, name: "Maha", committee: "General", status: "Up to date" },
    { id: 3, name: "Archived Person", committee: "SM", status: "Archived" },
  ];
  const assignment = (memberId, status, extra = {}) => ({ memberId, status, ...extra });
  const activity = (id, type, records, extra = {}) => ({
    id, type, name: id, date: `${month}-10`, source: "SM",
    proofRequired: false, proofType: "screenshot",
    targetMembers: records.map((record) => record.memberId), memberStatuses: records,
    ...extra,
  });
  const activities = [
    activity("session-attendance", "Session", [assignment(1, "attended"), assignment(2, "excused")]),
    activity("session-excuse", "Session", [assignment(1, "excused"), assignment(2, "absent")]),
    activity("session-pending", "Session", [assignment(1, "pending")]),
    activity("event", "Event", [
      assignment(1, "attended", { applied: true, selection: "selected", finalStatus: "attended", applicationProofReceived: true, attendanceProofReceived: false }),
      assignment(2, "applied", { applied: true, selection: "", finalStatus: "", applicationProofReceived: true }),
    ], { source: "General", proofRequired: true }),
    // Cycle reports use the activity date, even when a task's deadline differs.
    activity("task", "Task", [assignment(1, "done", { proofReceived: true }), assignment(2, "pending")], {
      proofRequired: true, date: `${previousMonth}-20`, deadline: `${month}-15`,
    }),
    activity("task-awaiting-proof", "Task", [assignment(1, "done", { proofReceived: false })], { proofRequired: true }),
    activity("archived-task", "Task", [assignment(1, "pending"), assignment(2, "pending")], { archived: true }),
    activity("retained-inactive-history", "Task", [assignment(1, "pending")], { targetMembers: [] }),
    activity("invalid-date", "Task", [assignment(1, "pending")], { date: "invalid" }),
    activity("previous-task", "Task", [assignment(1, "done"), assignment(2, "done")], { date: `${previousMonth}-12` }),
    activity("previous-session", "Session", [assignment(1, "attended"), assignment(2, "attended")], { date: `${previousMonth}-12` }),
    activity("archived-member-task", "Task", [assignment(3, "pending")]),
  ];
  return { members, activities, month, previousMonth };
}

function setup(options = {}) {
  const fixture = fixtures();
  const initialMembers = options.members ?? fixture.members;
  const initialActivities = options.activities ?? fixture.activities;
  const elements = {};
  const html = fs.readFileSync(path.join(root, "monthly-summary.html"), "utf8");
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    elements[match[2]] = new Element(match[1]);
    elements[match[2]].value = match[0].match(/\bvalue="([^"]*)"/)?.[1] || "";
  }
  assert.ok(elements["export-excel-btn"], "Monthly Summary must provide the export button");
  assert.ok(elements["summary-start"], "Monthly Summary must provide the cycle start date");
  assert.ok(elements["summary-end"], "Monthly Summary must provide the cycle end date");
  assert.ok(elements["generate-summary-btn"], "Monthly Summary must provide Generate Summary");
  assert.ok(elements["summary-interaction-month"], "Monthly Summary must label its Interaction evaluation month");
  if (!options.useMarkupDefaults) {
    const [start, end] = options.range ?? monthRange(fixture.month);
    elements["summary-start"].value = start;
    elements["summary-end"].value = end;
  }
  const storage = new Map([["members", JSON.stringify(initialMembers)], ["activities", JSON.stringify(initialActivities)]]);
  Object.entries(options.interaction ?? {}).forEach(([key, value]) => storage.set(key, JSON.stringify(value)));
  const controls = { failRead: false, failStage: "" };
  const calls = [];
  const downloads = [];
  function stage(name, result, args) {
    calls.push({ name, args });
    if (controls.failStage === name) throw new Error(`${name} failed`);
    return result;
  }
  const xlsx = {
    utils: {
      json_to_sheet(rows) { return stage("json_to_sheet", { rows: plain(rows) }, [plain(rows)]); },
      book_new() { return stage("book_new", { sheets: [] }, []); },
      book_append_sheet(book, sheet, name) {
        stage("book_append_sheet", undefined, [book, sheet, name]);
        book.sheets.push({ name, sheet });
      },
    },
    writeFile(book, filename) {
      stage("writeFile", undefined, [book, filename]);
      downloads.push({ book: plain(book), filename });
    },
  };
  const window = new Element("window");
  window.localStorage = {
    getItem(key) {
      if (controls.failRead) throw new Error("Storage denied");
      return storage.get(key) ?? null;
    },
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  };
  window.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
  window.dispatchEvent = (event) => window.fire(event.type, event);
  if (options.library !== false) window.XLSX = xlsx;
  const document = new Element("document");
  Object.assign(document, { readyState: "complete", getElementById: (id) => elements[id], createElement: (tag) => new Element(tag) });
  const context = vm.createContext({ window, document, console });
  for (const filename of ["data.js", "interaction-data.js", "monthly-summary.js"]) {
    vm.runInContext(fs.readFileSync(path.join(root, "js", filename), "utf8"), context, { filename });
  }
  const exportRows = () => plain(vm.runInContext("exportData", context));
  const clickExport = () => elements["export-excel-btn"].fire("click");
  const editRange = (start, end) => {
    elements["summary-start"].value = start;
    elements["summary-end"].value = end;
    elements["summary-start"].fire("input");
    elements["summary-end"].fire("input");
  };
  const changeRange = (start, end) => {
    editRange(start, end);
    elements["generate-summary-btn"].fire("click");
  };
  const metric = (memberIndex, category, label) => {
    const section = elements["summary-container"].innerHTML.match(new RegExp(`<h3 id="summary-${memberIndex}-${category}"[^>]*>[\\s\\S]*?</section>`));
    assert.ok(section, `Expected summary ${memberIndex} ${category}`);
    return Number(section[0].match(new RegExp(`>${label}</dt>\\s*<dd[^>]*>(\\d+)</dd>`))[1]);
  };
  return { ...fixture, context, window, elements, storage, controls, calls, downloads, xlsx, exportRows, clickExport, editRange, changeRange, metric, data: window.YLYData };
}

test("Excel rows match the exact HR column order, blank manual scores and rendered monthly attendance", () => {
  const { exportRows, metric, elements } = setup();
  const rows = exportRows();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows, [
    expectedRow("Habiba & Team", 1, 1),
    expectedRow("Maha", 0, 0),
  ]);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row), columns);
    for (const column of manualColumns) assert.equal(row[column], "");
    assert.equal(typeof row["Field Visits Entered"], "number");
    assert.equal(typeof row["Meetings Entered"], "number");
  }
  assert.equal(rows[0]["Meetings Entered"], metric(0, "sessions", "Attended"));
  assert.equal(rows[0]["Field Visits Entered"], metric(0, "events", "Attended"));
  assert.match(elements["summary-container"].innerHTML, /Habiba &amp; Team/);
  assert.equal(elements["summary-error"].hidden, true);
});

test("Export builds one named SheetJS worksheet and downloads the requested filename", () => {
  const { clickExport, calls, downloads, exportRows, storage } = setup();
  const before = Object.fromEntries(storage);
  clickExport();
  assert.deepEqual(calls.map((call) => call.name), ["json_to_sheet", "book_new", "book_append_sheet", "writeFile"]);
  assert.deepEqual(calls[0].args[0], exportRows());
  assert.equal(calls[2].args[2], "Monthly Summary");
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].filename, "YLY_Monthly_Summary.xlsx");
  assert.equal(downloads[0].book.sheets.length, 1);
  assert.deepEqual(downloads[0].book.sheets[0].sheet.rows, exportRows());
  assert.deepEqual(Object.fromEntries(storage), before, "export must not modify saved data");
});

test("Renders, data notifications and repeated exports replace rows without duplication", () => {
  const { window, clickExport, exportRows, downloads, data } = setup();
  const original = exportRows();
  window.fire("storage", { key: "activities" });
  window.fire("yly:data-changed", { detail: { key: "members" } });
  clickExport();
  clickExport();
  assert.deepEqual(exportRows(), original);
  assert.equal(downloads.length, 2);
  data.updateMemberActivityStatus("session-pending", 1, { status: "attended" });
  assert.equal(exportRows().length, 2);
  assert.equal(exportRows()[0]["Meetings Entered"], 2);
  clickExport();
  assert.equal(downloads[2].book.sheets[0].sheet.rows[0]["Meetings Entered"], 2);
});

test("Generate Summary recalculates the selected range and edits invalidate stale export rows", () => {
  const { previousMonth, changeRange, editRange, exportRows, clickExport, downloads, elements } = setup();
  editRange(...monthRange(previousMonth));
  assert.deepEqual(exportRows(), []);
  assert.equal(elements["export-excel-btn"].disabled, true);
  changeRange(...monthRange(previousMonth));
  assert.deepEqual(exportRows(), [
    expectedRow("Habiba & Team", 0, 1),
    expectedRow("Maha", 0, 1),
  ]);
  assert.equal(elements["export-excel-btn"].disabled, false);
  clickExport();
  assert.deepEqual(downloads[0].book.sheets[0].sheet.rows, exportRows());
});

test("The initial HTML cycle includes both endpoints across months and excludes adjacent dates", () => {
  const dates = ["2026-09-22", "2026-09-23", "2026-10-10", "2026-10-25", "2026-10-26"];
  const activities = dates.map((date, index) => ({
    id: index + 1, name: `Session ${date}`, type: "Session", date,
    targetMembers: [1], memberStatuses: [{ memberId: 1, status: "attended" }],
    proofRequired: false, archived: index === 1,
  }));
  const { elements, exportRows, metric, clickExport, downloads } = setup({ activities, useMarkupDefaults: true });
  assert.equal(elements["summary-start"].value, "2026-09-23");
  assert.equal(elements["summary-end"].value, "2026-10-25");
  assert.equal(metric(0, "sessions", "Attended"), 3);
  assert.equal(exportRows()[0]["Meetings Entered"], 3);
  clickExport();
  assert.equal(downloads[0].book.sheets[0].sheet.rows[0]["Meetings Entered"], 3);
});

test("Ranges crossing a year, one-day ranges and leap-day dates are supported", () => {
  const activities = ["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03", "2028-02-29"]
    .map((date, index) => ({
      id: index + 1, name: date, type: "Event", date, proofRequired: false,
      targetMembers: [1], memberStatuses: [{ memberId: 1, applied: true, selection: "selected", finalStatus: "attended", status: "attended" }],
    }));
  const { changeRange, exportRows, metric, elements } = setup({ activities, range: ["2026-12-31", "2027-01-02"] });
  assert.equal(exportRows()[0]["Field Visits Entered"], 3);
  changeRange("2027-01-01", "2027-01-01");
  assert.equal(exportRows()[0]["Field Visits Entered"], 1);
  assert.equal(metric(0, "events", "Attended"), 1);
  changeRange("2028-02-29", "2028-02-29");
  assert.equal(exportRows()[0]["Field Visits Entered"], 1);
  assert.equal(elements["summary-error"].hidden, true);
});

test("Empty, reversed and invalid calendar ranges clear cards and exports without downloading", () => {
  const invalidRanges = [
    ["", "2026-10-25"], ["2026-09-23", ""],
    ["2026-10-25", "2026-09-23"], ["2026-02-30", "2026-03-01"],
    ["2027-02-29", "2027-03-01"], ["2026-09-23", "not-a-date"],
  ];
  for (const range of invalidRanges) {
    const { changeRange, exportRows, elements, clickExport, downloads } = setup();
    assert.equal(exportRows().length, 2);
    changeRange(...range);
    assert.deepEqual(exportRows(), [], `Invalid range ${range} cannot reuse old export rows`);
    assert.equal(elements["summary-container"].innerHTML, "");
    assert.equal(elements["export-excel-btn"].disabled, true);
    assert.equal(elements["summary-error"].hidden, false);
    assert.match(elements["summary-error"].textContent, /date|range|start|end/i);
    clickExport();
    assert.equal(downloads.length, 0);
    assert.deepEqual(exportRows(), []);
    changeRange("2026-09-23", "2026-10-25");
    assert.equal(elements["summary-error"].hidden, true);
    assert.equal(exportRows().length, 2);
  }
});

test("All activity types use their activity date and never fall back to a deadline", () => {
  const task = (id, date, deadline) => ({
    id, name: id, type: "Task", date, deadline, source: "SM", proofRequired: false,
    targetMembers: [1], memberStatuses: [{ memberId: 1, status: "done" }],
  });
  const activities = [
    task("date-in-range", "2026-09-23", "2026-12-01"),
    task("deadline-in-range", "2026-08-23", "2026-09-23"),
    task("missing-date", "", "2026-09-23"),
    task("invalid-date", "2026-09-31", "2026-09-23"),
    { ...task("event-without-date", "", "2026-09-23"), type: "Event", memberStatuses: [{ memberId: 1, status: "attended" }] },
  ];
  const { metric, exportRows, elements } = setup({ activities, range: ["2026-09-23", "2026-10-25"] });
  assert.equal(metric(0, "tasks", "Done"), 1);
  assert.equal(metric(0, "sm", "Completed"), 1);
  assert.equal(exportRows()[0]["Field Visits Entered"], 0);
  assert.match(elements["summary-status"].textContent, /3 activities excluded/);
});

test("Storage refresh and export use the current date inputs instead of the previous generated range", () => {
  const { previousMonth, editRange, exportRows, window, clickExport, downloads, elements } = setup();
  editRange(...monthRange(previousMonth));
  assert.deepEqual(exportRows(), []);
  window.fire("storage", { key: "activities" });
  assert.equal(exportRows()[0]["Field Visits Entered"], 0);
  assert.equal(exportRows()[1]["Meetings Entered"], 1);
  // Programmatic changes can occur without input notifications; export still re-reads them.
  elements["summary-start"].value = "2027-01-01";
  elements["summary-end"].value = "2027-01-01";
  clickExport();
  assert.equal(exportRows()[0]["Field Visits Entered"], 0);
  assert.equal(exportRows()[1]["Meetings Entered"], 0);
  assert.deepEqual(downloads[0].book.sheets[0].sheet.rows, exportRows());
});

test("Activity archive retains historical attendance while member archive removes their row", () => {
  const { data, exportRows, clickExport, downloads } = setup();
  data.archiveActivity("event");
  assert.equal(exportRows()[0]["Field Visits Entered"], 1);
  assert.equal(exportRows()[0]["Meetings Entered"], 1);
  data.archiveMember(1);
  assert.deepEqual(exportRows().map((row) => row.Name), ["Maha"]);
  clickExport();
  assert.equal(downloads[0].book.sheets[0].sheet.rows.length, 1);
  data.archiveMember(1, false);
  data.archiveActivity("event", false);
  assert.equal(exportRows().length, 2);
  assert.equal(exportRows()[0]["Field Visits Entered"], 1);
});

test("Export reads fresh storage even when no storage notification has fired", () => {
  const { storage, exportRows, clickExport, downloads } = setup();
  const activities = JSON.parse(storage.get("activities"));
  const record = activities.find((activity) => activity.id === "event").memberStatuses[0];
  record.status = record.finalStatus = "absent";
  const members = JSON.parse(storage.get("members"));
  members[0].name = "Habiba Updated";
  storage.set("members", JSON.stringify(members));
  storage.set("activities", JSON.stringify(activities));
  assert.equal(exportRows()[0].Name, "Habiba & Team");
  clickExport();
  assert.equal(exportRows()[0].Name, "Habiba Updated");
  assert.equal(exportRows()[0]["Field Visits Entered"], 0);
  assert.deepEqual(downloads[0].book.sheets[0].sheet.rows, exportRows());
});

test("Missing SheetJS reports an error without creating a workbook and recovers when available", () => {
  const { window, xlsx, clickExport, calls, downloads, elements } = setup({ library: false });
  assert.doesNotThrow(clickExport);
  assert.equal(elements["summary-error"].hidden, false);
  assert.match(elements["summary-error"].textContent, /Excel|export|library|load/i);
  assert.equal(calls.length, 0);
  assert.equal(downloads.length, 0);
  window.XLSX = xlsx;
  clickExport();
  assert.equal(downloads.length, 1);
  assert.equal(elements["summary-error"].hidden, true);
});

test("No active members exports no workbook, while zero-activity member cards remain exportable", () => {
  const empty = setup({ members: [] });
  assert.deepEqual(empty.exportRows(), []);
  empty.clickExport();
  assert.equal(empty.calls.length, 0);
  assert.equal(empty.downloads.length, 0);
  assert.equal(empty.elements["summary-error"].hidden, false);
  const zero = setup({ activities: [] });
  assert.equal(zero.exportRows().length, 2);
  for (const row of zero.exportRows()) {
    assert.equal(row["Field Visits Entered"], 0);
    assert.equal(row["Meetings Entered"], 0);
    for (const column of manualColumns) assert.equal(row[column], "");
  }
  zero.clickExport();
  assert.equal(zero.downloads.length, 1);
});

test("Corrupt or unreadable storage clears stale export data and never writes a workbook", () => {
  for (const failure of ["activities-json", "members-object", "denied"]) {
    const { storage, controls, exportRows, clickExport, calls, downloads, elements } = setup();
    assert.equal(exportRows().length, 2);
    if (failure === "activities-json") storage.set("activities", "{invalid");
    if (failure === "members-object") storage.set("members", "{}");
    if (failure === "denied") controls.failRead = true;
    assert.doesNotThrow(clickExport);
    assert.deepEqual(exportRows(), []);
    assert.equal(calls.length, 0);
    assert.equal(downloads.length, 0);
    assert.equal(elements["summary-error"].hidden, false);
    assert.equal(elements["summary-container"].innerHTML, "");
  }
});

test("Sheet construction and download failures are reported without changing storage", () => {
  for (const failStage of ["json_to_sheet", "book_new", "book_append_sheet", "writeFile"]) {
    const { controls, storage, clickExport, downloads, exportRows, elements } = setup();
    const before = Object.fromEntries(storage);
    controls.failStage = failStage;
    assert.doesNotThrow(clickExport);
    assert.equal(downloads.length, 0);
    assert.equal(elements["summary-error"].hidden, false);
    assert.match(elements["summary-error"].textContent, /Excel|export|download/i);
    assert.equal(exportRows().length, 2);
    assert.deepEqual(Object.fromEntries(storage), before);
    controls.failStage = "";
    clickExport();
    assert.equal(downloads.length, 1);
    assert.equal(elements["summary-error"].hidden, true);
  }
});

test("Interaction cards and Excel use the saved final score, preserving zero and leaving missing evaluations blank", () => {
  const { month } = fixtures();
  const finalEvaluations = {
    [`${month}_1`]: { suggestedScore: 9, finalScore: 0, note: "Manual HR decision" },
    [`${month}_3`]: { suggestedScore: 10, finalScore: 10, note: "Archived member" },
  };
  const { elements, exportRows, clickExport, downloads } = setup({ interaction: { finalEvaluations } });
  assert.deepEqual(exportRows(), [expectedRow("Habiba & Team", 1, 1, 0), expectedRow("Maha", 0, 0)]);
  assert.match(elements["summary-container"].innerHTML, /id="summary-0-interaction"[\s\S]*?>0\/10<\/dd>/);
  assert.match(elements["summary-container"].innerHTML, /id="summary-1-interaction"[\s\S]*?>Pending<\/dd>/);
  clickExport();
  const rows = downloads[0].book.sheets[0].sheet.rows;
  assert.equal(typeof rows[0]["Interaction /10"], "number");
  assert.equal(rows[0]["Interaction /10"], 0);
  assert.equal(rows[1]["Interaction /10"], "");
  assert.deepEqual(Object.keys(rows[0]), columns);
});

test("Evaluation month defaults to range end, can be overridden, and month edits invalidate old exports", () => {
  const finalEvaluations = {
    "2026-09_1": { suggestedScore: 8, finalScore: 9, note: "September" },
    "2026-10_1": { suggestedScore: 7, finalScore: 6, note: "October" },
  };
  const { elements, exportRows, clickExport, downloads, editRange } = setup({
    useMarkupDefaults: true, interaction: { finalEvaluations },
  });
  const monthInput = elements["summary-interaction-month"];
  assert.equal(monthInput.value, "2026-10");
  assert.equal(exportRows()[0]["Interaction /10"], 6);
  monthInput.value = "2026-09";
  monthInput.fire("input");
  assert.deepEqual(exportRows(), []);
  assert.equal(elements["export-excel-btn"].disabled, true);
  elements["generate-summary-btn"].fire("click");
  assert.equal(exportRows()[0]["Interaction /10"], 9);
  assert.match(elements["summary-status"].textContent, /Interaction evaluations: September 2026/);
  // Export also reads the current month when a programmatic edit emits no event.
  monthInput.value = "2026-10";
  clickExport();
  assert.equal(downloads[0].book.sheets[0].sheet.rows[0]["Interaction /10"], 6);
  editRange("2026-09-01", "2026-09-30");
  assert.equal(monthInput.value, "2026-09");
  assert.deepEqual(exportRows(), []);
});

test("Invalid evaluation month keeps activity cards available and blocks incomplete Excel exports", () => {
  const { elements, exportRows, clickExport, downloads, month, metric } = setup();
  elements["summary-interaction-month"].value = "2026-13";
  clickExport();
  assert.equal(downloads.length, 0);
  assert.deepEqual(exportRows(), []);
  assert.equal(metric(0, "sessions", "Attended"), 1);
  assert.match(elements["summary-container"].innerHTML, /Unavailable/);
  assert.equal(elements["summary-interaction-error"].hidden, false);
  assert.equal(elements["export-excel-btn"].disabled, true);
  elements["summary-interaction-month"].value = month;
  elements["generate-summary-btn"].fire("click");
  assert.equal(elements["summary-interaction-error"].hidden, true);
  assert.equal(exportRows().length, 2);
});

test("Interaction storage updates refresh cards and export re-reads saved evaluations without notifications", () => {
  const { storage, window, month, exportRows, clickExport, downloads, elements } = setup();
  const evaluations = { [`${month}_1`]: { suggestedScore: 7, finalScore: 8, note: "Updated" } };
  storage.set("finalEvaluations", JSON.stringify(evaluations));
  window.fire("storage", { key: "finalEvaluations" });
  assert.equal(exportRows()[0]["Interaction /10"], 8);
  evaluations[`${month}_1`].finalScore = 9;
  storage.set("finalEvaluations", JSON.stringify(evaluations));
  window.fire("yly:interaction-changed", { detail: { keys: ["finalEvaluations"] } });
  assert.equal(exportRows()[0]["Interaction /10"], 9);
  assert.match(elements["summary-container"].innerHTML, />9\/10<\/dd>/);
  evaluations[`${month}_1`].finalScore = 10;
  storage.set("finalEvaluations", JSON.stringify(evaluations));
  clickExport();
  assert.equal(downloads[0].book.sheets[0].sheet.rows[0]["Interaction /10"], 10);
  storage.set("finalEvaluations", "{}");
  window.fire("storage", { key: null });
  assert.equal(exportRows()[0]["Interaction /10"], "");
});

test("Corrupt Interaction storage preserves activity summaries but blocks exports until repaired", () => {
  for (const [key, invalid] of [
    ["finalEvaluations", "{invalid"],
    ["finalEvaluations", JSON.stringify({ "2026-09_1": { suggestedScore: 7, finalScore: 1.5, note: "Invalid" } })],
    ["checkpoints", "{}"],
    ["interactionSettings", JSON.stringify({ fb: 2, general: 2, sm: 3, hr: 8 })],
  ]) {
    const { storage, exportRows, clickExport, downloads, elements, metric } = setup();
    const original = storage.get(key);
    storage.set(key, invalid);
    assert.doesNotThrow(clickExport);
    assert.deepEqual(exportRows(), []);
    assert.equal(downloads.length, 0);
    assert.equal(metric(0, "events", "Attended"), 1);
    assert.equal(elements["summary-error"].hidden, true);
    assert.equal(elements["summary-interaction-error"].hidden, false);
    assert.match(elements["summary-interaction-error"].textContent, /Interaction.*Excel export is disabled/);
    assert.equal(storage.get(key), invalid, "Invalid records must not be reset silently");
    storage.set(key, original);
    clickExport();
    assert.equal(downloads.length, 1);
    assert.equal(elements["summary-interaction-error"].hidden, true);
  }
});

test("Summary HTML loads the shared Interaction engine before the summary renderer", () => {
  const html = fs.readFileSync(path.join(root, "monthly-summary.html"), "utf8");
  assert.ok(html.indexOf('src="js/data.js"') < html.indexOf('src="js/interaction-data.js"'));
  assert.ok(html.indexOf('src="js/interaction-data.js"') < html.indexOf('src="js/monthly-summary.js"'));
  assert.match(html, /label for="summary-interaction-month">Interaction evaluation month/);
});

test("Task summary and Excel count only strict saved late flags on Done task records", () => {
  const task = (id, status, extra = {}, activityExtra = {}) => ({
    id, name: id, type: "Task", date: "2026-09-26", proofRequired: false,
    targetMembers: [1], memberStatuses: [{ memberId: 1, status, ...extra }],
    ...activityExtra,
  });
  const activities = [
    task("late", "done", { isLate: true, submissionDate: "2026-09-26" }),
    task("on-time", "done", { isLate: false }),
    task("string-flag", "done", { isLate: "true" }),
    task("legacy-manual", "done", { timeliness: "late" }),
    task("legacy-done", "done"),
    task("pending-stale", "pending", { isLate: true }),
    task("excused-stale", "excused", { isLate: true }),
    task("session-stale", "attended", { isLate: true }, { type: "Session" }),
    task("event-stale", "attended", { isLate: true }, { type: "Event" }),
  ];
  const { metric, exportRows, clickExport, downloads } = setup({
    activities, range: ["2026-09-01", "2026-09-30"],
  });
  assert.equal(metric(0, "tasks", "Done"), 5);
  assert.equal(metric(0, "tasks", "On Time"), 4);
  assert.equal(metric(0, "tasks", "Late Tasks"), 1);
  assert.equal(metric(0, "tasks", "Pending"), 1);
  assert.equal(exportRows()[0]["Tasks Done Late"], 1);
  assert.equal(exportRows()[1]["Tasks Done Late"], 0);
  clickExport();
  const row = downloads[0].book.sheets[0].sheet.rows[0];
  assert.deepEqual(Object.keys(row), columns);
  assert.equal(typeof row["Tasks Done Late"], "number");
  assert.equal(row["Tasks Done Late"], 1);
});

test("A late Done task awaiting required proof remains late and pending without counting as completed", () => {
  const activities = [{
    id: "late-awaiting-proof", name: "Late task", type: "Task", date: "2026-09-26",
    proofRequired: true, proofType: "screenshot", source: "SM", targetMembers: [1],
    memberStatuses: [{
      memberId: 1, status: "done", isLate: true, submissionDate: "2026-09-26", proofReceived: false,
    }],
  }];
  const { metric, exportRows, clickExport, downloads, storage, window } = setup({
    activities, range: ["2026-09-01", "2026-09-30"],
  });
  assert.equal(metric(0, "tasks", "Done"), 0);
  assert.equal(metric(0, "tasks", "On Time"), 0);
  assert.equal(metric(0, "tasks", "Pending"), 1);
  assert.equal(metric(0, "tasks", "Late Tasks"), 1);
  assert.equal(metric(0, "sm", "Completed"), 0);
  clickExport();
  assert.equal(downloads[0].book.sheets[0].sheet.rows[0]["Tasks Done Late"], 1);
  const saved = JSON.parse(storage.get("activities"));
  saved[0].memberStatuses[0].proofReceived = true;
  storage.set("activities", JSON.stringify(saved));
  window.fire("storage", { key: "activities" });
  assert.equal(metric(0, "tasks", "Done"), 1);
  assert.equal(metric(0, "tasks", "Pending"), 0);
  assert.equal(metric(0, "tasks", "Late Tasks"), 1);
  assert.equal(exportRows()[0]["Tasks Done Late"], 1);
});

test("Late task history respects activity date boundaries, member assignments and archive rules", () => {
  const task = (id, date, extra = {}) => ({
    id, name: id, type: "Task", date, proofRequired: false, targetMembers: [1, 2],
    memberStatuses: [
      { memberId: 1, status: "done", isLate: true, submissionDate: "2026-10-30" },
      { memberId: 2, status: "done", isLate: false, submissionDate: "2026-09-20" },
    ],
    ...extra,
  });
  const activities = [
    task("start", "2026-09-23", { archived: true }),
    task("end", "2026-10-25"),
    task("before", "2026-09-22"),
    task("after", "2026-10-26"),
    task("invalid", "not-a-date"),
    task("removed-assignment", "2026-10-01", { targetMembers: [] }),
  ];
  const { metric, exportRows, data, clickExport, downloads } = setup({
    activities, range: ["2026-09-23", "2026-10-25"],
  });
  assert.equal(metric(0, "tasks", "Late Tasks"), 2);
  assert.equal(metric(1, "tasks", "Late Tasks"), 0);
  assert.equal(metric(1, "tasks", "On Time"), 2);
  assert.equal(exportRows()[0]["Tasks Done Late"], 2);
  data.archiveMember(1);
  assert.deepEqual(exportRows().map((row) => [row.Name, row["Tasks Done Late"]]), [["Maha", 0]]);
  data.archiveMember(1, false);
  clickExport();
  assert.equal(downloads[0].book.sheets[0].sheet.rows[0]["Tasks Done Late"], 2);
});
