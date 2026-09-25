const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Run the real page and storage helpers against a small, dependency-free DOM.
class Element {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.value = "";
    this.className = "";
    this.checked = this.disabled = this.hidden = this.required = this.open = false;
    this.classList = {
      add: (...values) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...values])].join(" "); },
      remove: (...values) => { this.className = this.className.split(/\s+/).filter((value) => !values.includes(value)).join(" "); },
      contains: (value) => this.className.split(/\s+/).includes(value),
      toggle: (value, force) => {
        const enabled = force ?? !this.classList.contains(value);
        if (enabled) this.classList.add(value); else this.classList.remove(value);
        return enabled;
      },
    };
  }
  set textContent(value) { this.children = []; this.text = String(value); }
  get textContent() { return (this.text || "") + this.children.map((child) => child.textContent).join(""); }
  get options() { return this.querySelectorAll("option"); }
  append(...children) {
    for (let child of children) {
      if (typeof child !== "object") { const text = new Element("text"); text.textContent = child; child = text; }
      if (child.tagName === "FRAGMENT") { this.append(...child.children); continue; }
      child.parent = this;
      this.children.push(child);
    }
  }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) { this.children = []; this.text = ""; this.append(...children); }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
    else if (name === "class") this.className = String(value);
    else this[name] = String(value);
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  fire(type, overrides = {}) {
    const event = { type, target: this, currentTarget: this, defaultPrevented: false, bubbles: ["click", "change", "input", "submit"].includes(type), preventDefault() { this.defaultPrevented = true; }, ...overrides };
    let node = this;
    do {
      event.currentTarget = node;
      for (const listener of node.listeners[type] || []) listener(event);
      node = event.bubbles ? node.parent : null;
    } while (node);
    return event;
  }
  matches(selector) {
    return selector.split(",").some((raw) => {
      const part = raw.trim();
      const tag = part.match(/^[a-z]+/i)?.[0];
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      const id = part.match(/#([\w-]+)/)?.[1];
      if (id && this.id !== id) return false;
      for (const match of part.matchAll(/\.([\w-]+)/g)) if (!this.classList.contains(match[1])) return false;
      for (const match of part.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
        const name = match[1];
        const value = name.startsWith("data-") ? this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] : (this.attributes[name] ?? (this[name] === true ? "" : undefined));
        if (value === undefined || match[2] !== undefined && value !== match[2]) return false;
      }
      if (part.includes(":checked") && !this.checked) return false;
      return true;
    });
  }
  querySelectorAll(selector) { return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector) || null; }
  contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  close() { this.open = false; this.fire("close"); }
  setCustomValidity(value) { this.validationMessage = value; }
  reportValidity() { this.reported = true; return this.checkValidity(); }
  checkValidity() {
    if (!this.disabled && (this.validationMessage || this.required && !this.value && ["INPUT", "SELECT", "TEXTAREA"].includes(this.tagName))) return false;
    return this.children.every((child) => child.checkValidity());
  }
  reset() {
    this.querySelectorAll("input, select, textarea").forEach((input) => {
      input.value = input.defaultValue || "";
      input.checked = Boolean(input.defaultChecked);
      input.validationMessage = "";
    });
  }
}

const root = path.join(__dirname, "..");
const clone = (value) => JSON.parse(JSON.stringify(value));
const fixtures = {
  members: [
    { id: 1, name: "Habiba", committee: "SM", status: "Up to date" },
    { id: 2, name: "Maha", committee: "SM", status: "Needs Follow-up" },
    { id: 3, name: "Archived", committee: "SM", status: "Archived" },
  ],
  activities: [{ id: "task", type: "Task", name: "Existing task", date: "2026-09-24", source: "SM", targetMembers: [1, 2], memberStatuses: [{ memberId: 1, status: "done" }, { memberId: 2, status: "pending" }] }],
  interactionSettings: { fb: 2, general: 2, sm: 3, hr: 3 },
  checkpoints: [
    { id: "fb", month: "2026-09", type: "Facebook", title: "Facebook checkpoint", date: "2026-09-23", interactionExpected: "Yes" },
    { id: "general", month: "2026-09", type: "General", title: "General checkpoint", date: "2026-09-24", interactionExpected: "Yes" },
    { id: "sm", month: "2026-09", type: "SM", title: "SM checkpoint", date: "2026-09-24", interactionExpected: "Yes" },
  ],
  checkpointInteractions: { fb: { 1: "Reacted", 2: "None" }, general: { 1: "None" }, sm: { 1: "Participated" } },
  hrEvaluations: {},
  finalEvaluations: {},
};

function setup(overrides = {}, search = "") {
  const html = fs.readFileSync(path.join(root, "interaction.html"), "utf8");
  const document = new Element("document");
  const elements = {};
  const stack = [document];
  for (const token of html.matchAll(/<!--[\s\S]*?-->|<![^>]*>|<\/?[a-z][^>]*>|[^<]+/gi)) {
    const text = token[0];
    if (/^<!/.test(text)) continue;
    if (/^<\//.test(text)) { if (stack.length > 1) stack.pop(); continue; }
    if (!text.startsWith("<")) { if (text.trim()) stack.at(-1).append(text); continue; }
    const tag = text.match(/^<([a-z][a-z0-9]*)/i)[1].toLowerCase();
    const element = new Element(tag);
    for (const attr of text.slice(tag.length + 1, -1).matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
      element.setAttribute(attr[1], attr[2] ?? "");
      if (["hidden", "disabled", "required", "checked"].includes(attr[1])) element[attr[1]] = true;
    }
    element.defaultValue = element.value;
    element.defaultChecked = element.checked;
    if (element.id) elements[element.id] = element;
    stack.at(-1).append(element);
    if (!["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"].includes(tag)) stack.push(element);
  }
  document.querySelectorAll("select").forEach((select) => { select.defaultValue = select.value = select.options.find((option) => option.selected)?.value ?? select.options[0]?.value ?? ""; });
  document.readyState = "complete";
  document.getElementById = (id) => elements[id] || null;
  document.createElement = (tag) => new Element(tag);
  document.createDocumentFragment = () => new Element("fragment");
  document.body = document.querySelector("body");
  const stored = new Map(Object.entries({ ...clone(fixtures), ...clone(overrides) }).map(([key, value]) => [key, JSON.stringify(value)]));
  const writes = [];
  const window = new Element("window");
  window.location = { search };
  window.localStorage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => { writes.push(key); stored.set(key, value); },
    removeItem: (key) => stored.delete(key),
  };
  window.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options?.detail; } };
  window.dispatchEvent = (event) => window.fire(event.type, event);
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : ["2026-09-24T12:00:00Z"])); } static now() { return Date.parse("2026-09-24T12:00:00Z"); } }
  const context = vm.createContext({ window, document, console, Date: FixedDate, CustomEvent: window.CustomEvent, URLSearchParams });
  for (const file of ["data.js", "interaction-data.js", "interaction.js"]) vm.runInContext(fs.readFileSync(path.join(root, "js", file), "utf8"), context, { filename: file });
  const click = (id) => { assert.ok(elements[id], `Missing #${id}`); elements[id].fire("click"); };
  const change = (id, value, type = "change") => { const input = elements[id]; if (typeof value === "boolean") input.checked = value; else input.value = String(value); input.fire(type); };
  const openEvaluation = (id = 1) => {
    const button = elements["interaction-members-body"].querySelectorAll("button[data-evaluate-member]").find((node) => node.dataset.evaluateMember === String(id));
    assert.ok(button, `Missing evaluation action for member ${id}`);
    button.fire("click");
    assert.equal(elements["evaluation-dialog"].open, true, elements["interaction-error"].textContent);
  };
  const openCheckpoint = (id = "fb") => {
    const button = elements["checkpoint-list"].querySelectorAll("button[data-log-checkpoint]").find((node) => node.dataset.logCheckpoint === String(id));
    assert.ok(button, `Missing checkpoint action for ${id}`);
    button.fire("click");
    assert.equal(elements["interaction-log-dialog"].open, true, elements["interaction-error"].textContent);
  };
  const read = (key) => JSON.parse(stored.get(key));
  const cancel = (id) => {
    const button = elements[id].querySelector(`button[data-close-dialog="${id}"]`);
    assert.ok(button, `Missing close/cancel action for ${id}`);
    button.fire("click");
    assert.equal(elements[id].open, false);
  };
  return { elements, document, window, stored, writes, read, click, change, openEvaluation, openCheckpoint, cancel };
}

test("Interaction initializes the current month and lists only active members without changing activities", () => {
  const app = setup();
  assert.equal(app.elements["interaction-month"].value, "2026-09");
  assert.equal(app.elements["interaction-members-total"].textContent, "2");
  assert.equal(app.elements["interaction-evaluated-total"].textContent, "0");
  assert.equal(app.elements["interaction-review-total"].textContent, "2");
  assert.equal(app.elements["interaction-members-body"].querySelectorAll("button[data-evaluate-member]").length, 2);
  assert.match(app.elements["interaction-members-body"].textContent, /Pending/);
  assert.deepEqual(app.read("members"), fixtures.members);
  assert.deepEqual(app.read("activities")[0].memberStatuses, fixtures.activities[0].memberStatuses);
});

test("Settings validates the exact total, persists valid weights, and uses a separate dialog", () => {
  const app = setup();
  const before = app.stored.get("interactionSettings");
  app.click("interaction-settings-btn");
  assert.equal(app.elements["interaction-settings-dialog"].open, true);
  assert.equal(app.elements["evaluation-dialog"].open, false);
  app.change("weight-fb", 4, "input");
  app.elements["interaction-settings-form"].fire("submit");
  assert.equal(app.stored.get("interactionSettings"), before);
  assert.equal(app.elements["interaction-settings-dialog"].open, true);
  assert.match(app.elements["settings-error"].textContent, /total 10/i);
  app.change("weight-general", 0, "input");
  app.elements["interaction-settings-form"].fire("submit");
  assert.equal(app.elements["interaction-settings-dialog"].open, false, app.elements["settings-error"].textContent);
  assert.deepEqual(app.read("interactionSettings"), { fb: 4, general: 0, sm: 3, hr: 3 });
  app.openEvaluation();
  assert.equal(app.elements["interaction-settings-dialog"].open, false);
});

test("Checkpoint creation takes its month from the date and preserves literal titles", () => {
  const app = setup();
  app.click("add-checkpoint-btn");
  app.change("checkpoint-type", "Facebook");
  app.change("checkpoint-title", '<img src=x onerror="bad()"> New checkpoint');
  app.change("checkpoint-date", "2026-10-05");
  app.change("checkpoint-expected", "No");
  app.elements["checkpoint-form"].fire("submit");
  assert.equal(app.elements["checkpoint-dialog"].open, false, app.elements["checkpoint-error"].textContent);
  const checkpoint = app.read("checkpoints").at(-1);
  assert.equal(checkpoint.month, "2026-10");
  assert.equal(checkpoint.interactionExpected, "No");
  assert.equal(app.elements["interaction-month"].value, "2026-10");
  assert.match(app.elements["checkpoint-list"].textContent, /<img src=x onerror="bad\(\)"> New checkpoint/);
  assert.equal(app.elements["checkpoint-list"].querySelectorAll("img").length, 0);
});

test("Checkpoint logging uses type-specific choices and saves only edited active member records", () => {
  const app = setup();
  const memberSnapshot = app.stored.get("members");
  const activitySnapshot = app.stored.get("activities");
  app.openCheckpoint("fb");
  let selects = app.elements["interaction-log-members"].querySelectorAll("select[data-interaction-member]");
  assert.equal(selects.length, 2);
  assert.deepEqual(selects[0].options.map((option) => option.value).filter(Boolean), ["Reacted", "Commented", "Shared", "None"]);
  const first = selects.find((select) => select.dataset.interactionMember === "1");
  first.value = "Shared";
  first.fire("change");
  const concurrent = app.read("checkpointInteractions");
  concurrent.fb[2] = "Commented";
  app.stored.set("checkpointInteractions", JSON.stringify(concurrent));
  app.elements["interaction-log-form"].fire("submit");
  assert.equal(app.elements["interaction-log-dialog"].open, false, app.elements["interaction-log-error"].textContent);
  assert.deepEqual(app.read("checkpointInteractions").fb, { 1: "Shared", 2: "Commented" });
  assert.equal(app.stored.get("members"), memberSnapshot);
  assert.equal(app.stored.get("activities"), activitySnapshot);
  app.openCheckpoint("general");
  selects = app.elements["interaction-log-members"].querySelectorAll("select[data-interaction-member]");
  assert.deepEqual(selects[0].options.map((option) => option.value).filter(Boolean), ["Reacted", "Replied", "Participated", "None"]);
  app.elements["interaction-log-form"].fire("submit");
  assert.equal(app.read("checkpointInteractions").general[2], undefined, "Unchecked member must remain unrecorded");
});

test("Evaluation live score uses checkpoint engagement plus HR, and zero is a valid final score", () => {
  const app = setup();
  app.openEvaluation();
  assert.equal(Number(app.elements["evaluation-suggested"].textContent), 5);
  for (const field of ["hr-responds", "hr-proofs", "hr-proper-comm"]) app.change(field, true);
  assert.equal(Number(app.elements["evaluation-suggested"].textContent), 8);
  app.change("evaluation-final", "0");
  app.change("evaluation-note", "Manual evaluation; preserve a zero.");
  app.elements["evaluation-form"].fire("submit");
  assert.equal(app.elements["evaluation-dialog"].open, false, app.elements["evaluation-error"].textContent);
  assert.deepEqual(app.read("hrEvaluations")["2026-09_1"], { responds: true, proofs: true, properComm: true });
  assert.deepEqual(app.read("finalEvaluations")["2026-09_1"], { suggestedScore: 8, finalScore: 0, note: "Manual evaluation; preserve a zero." });
  assert.equal(app.elements["interaction-evaluated-total"].textContent, "1");
  assert.equal(app.elements["interaction-review-total"].textContent, "1");
  app.openEvaluation();
  assert.equal(app.elements["evaluation-final"].value, "0");
  assert.equal(app.elements["hr-responds"].checked, true);
});

test("Expected No checkpoints do not contribute, and month changes keep evaluations isolated", () => {
  const app = setup({
    checkpoints: [...fixtures.checkpoints, { id: "optional", month: "2026-09", type: "Facebook", title: "Optional", date: "2026-09-24", interactionExpected: "No" }],
    checkpointInteractions: { ...fixtures.checkpointInteractions, optional: { 1: "None" } },
    finalEvaluations: { "2026-09_1": { suggestedScore: 5, finalScore: 7, note: "September" } },
  });
  app.openEvaluation();
  assert.equal(Number(app.elements["evaluation-suggested"].textContent), 5);
  app.cancel("evaluation-dialog");
  app.change("interaction-month", "2026-10");
  assert.equal(app.elements["interaction-evaluated-total"].textContent, "0");
  app.openEvaluation();
  assert.equal(app.elements["evaluation-final"].value, "");
  app.change("evaluation-final", "2");
  app.elements["evaluation-form"].fire("submit");
  assert.equal(app.read("finalEvaluations")["2026-09_1"].finalScore, 7);
  assert.equal(app.read("finalEvaluations")["2026-10_1"].finalScore, 2);
});

test("Fractional and missing final scores do not persist an evaluation", () => {
  for (const value of ["", "2.5", "11", "-1"]) {
    const app = setup();
    app.openEvaluation();
    app.change("evaluation-final", value);
    app.elements["evaluation-form"].fire("submit");
    assert.equal(app.elements["evaluation-dialog"].open, true, `Rejected final ${value}`);
    assert.deepEqual(app.read("finalEvaluations"), {});
    assert.deepEqual(app.read("hrEvaluations"), {});
  }
});

test("Failed evaluation persistence keeps the dialog editable and restores both saved maps", () => {
  const app = setup();
  app.openEvaluation();
  app.change("hr-responds", true);
  app.change("evaluation-final", "4");
  const before = new Map(app.stored);
  const original = app.window.localStorage.setItem;
  let failed = false;
  app.window.localStorage.setItem = (key, value) => {
    if (key === "finalEvaluations" && !failed) { failed = true; throw new Error("Storage quota exceeded"); }
    original(key, value);
  };
  app.elements["evaluation-form"].fire("submit");
  assert.equal(failed, true);
  assert.equal(app.elements["evaluation-dialog"].open, true);
  assert.equal(app.elements["evaluation-error"].hidden, false);
  assert.equal(app.elements["evaluation-save"].disabled, false);
  assert.deepEqual(app.stored, before);
});

test("Stale month or archived member prevents evaluation save", () => {
  for (const stale of ["month", "member"]) {
    const app = setup();
    app.openEvaluation();
    app.change("evaluation-final", "6");
    if (stale === "month") app.change("interaction-month", "2026-10");
    else {
      const members = app.read("members");
      members[0].status = "Archived";
      app.stored.set("members", JSON.stringify(members));
    }
    app.elements["evaluation-form"].fire("submit");
    assert.deepEqual(app.read("finalEvaluations"), {});
    assert.deepEqual(app.read("hrEvaluations"), {});
  }
});

test("Saved data events refresh totals and changed evaluation inputs cannot be silently overwritten", () => {
  const app = setup();
  app.openEvaluation();
  app.change("evaluation-final", "6");
  const evaluations = { "2026-09_2": { suggestedScore: 0, finalScore: 0, note: "Another tab" } };
  app.stored.set("finalEvaluations", JSON.stringify(evaluations));
  app.window.fire("storage", { key: "finalEvaluations" });
  assert.equal(app.elements["interaction-evaluated-total"].textContent, "1");
  const interactions = app.read("checkpointInteractions");
  interactions.fb[1] = "None";
  app.stored.set("checkpointInteractions", JSON.stringify(interactions));
  app.window.fire("yly:data-changed", { detail: { key: "checkpointInteractions" } });
  app.elements["evaluation-form"].fire("submit");
  assert.equal(app.read("finalEvaluations")["2026-09_1"], undefined);
  assert.equal(app.read("finalEvaluations")["2026-09_2"].finalScore, 0);
  assert.equal(app.elements["evaluation-dialog"].open, true);
  assert.match(app.elements["evaluation-error"].textContent, /changed|reopen|review/i);
});

test("Checkpoint changed while logging rejects the stale form without replacing saved interactions", () => {
  const app = setup();
  app.openCheckpoint();
  const first = app.elements["interaction-log-members"].querySelectorAll("select[data-interaction-member]").find((node) => node.dataset.interactionMember === "1");
  first.value = "Shared";
  const checkpoints = app.read("checkpoints");
  checkpoints[0].type = "SM";
  app.stored.set("checkpoints", JSON.stringify(checkpoints));
  const before = app.stored.get("checkpointInteractions");
  app.elements["interaction-log-form"].fire("submit");
  assert.equal(app.stored.get("checkpointInteractions"), before);
  assert.equal(app.elements["interaction-log-dialog"].open, true);
  assert.equal(app.elements["interaction-log-error"].hidden, false);
});

test("a review link selects the requested month and opens only that member's evaluation", () => {
  const app = setup({ finalEvaluations: { "2026-08_2": { suggestedScore: 7, finalScore: 0, note: "August review" } } }, "?month=2026-08&member=2");
  assert.equal(app.elements["interaction-month"].value, "2026-08");
  assert.equal(app.elements["evaluation-dialog"].open, true);
  assert.match(app.elements["evaluation-title"].textContent, /Maha/);
  assert.equal(app.elements["evaluation-final"].value, "0");
  assert.equal(app.elements["evaluation-note"].value, "August review");
  assert.equal(app.elements["evaluation-suggested"].textContent, "7");
  assert.match(app.elements["evaluation-breakdown"].textContent, /full category weight/);
  assert.deepEqual(app.read("finalEvaluations"), { "2026-08_2": { suggestedScore: 7, finalScore: 0, note: "August review" } });
});

test("unchecked expected results show a review note without suppressing the full-weight policy", () => {
  const app = setup({ checkpointInteractions: {} });
  app.openEvaluation();
  assert.equal(app.elements["evaluation-suggested"].textContent, "7");
  assert.equal(app.elements["evaluation-review-note"].hidden, false);
  assert.match(app.elements["evaluation-review-note"].textContent, /3 expected checkpoints/);
  assert.match(app.elements["evaluation-breakdown"].textContent, /full category weight/);
});
