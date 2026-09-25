const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const root = path.join(__dirname, "..");
const pages = ["index.html", "members.html", "activities.html", "member-details.html", "monthly-summary.html", "interaction.html"];

function setup(width = 375) {
  const document = { readyState: "complete", activeElement: null, listeners: {} };
  class Element {
    constructor(tag = "div") {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.listeners = {};
      this.attributes = {};
      this.inert = false;
      this.hidden = false;
      this.disabled = false;
      this.isConnected = true;
      const names = new Set();
      this.classList = {
        toggle(name, enabled) { if (enabled) names.add(name); else names.delete(name); },
        contains(name) { return names.has(name); },
      };
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    removeAttribute(name) { delete this.attributes[name]; }
    addEventListener(name, handler) { (this.listeners[name] ||= []).push(handler); }
    fire(name, event = {}) {
      const dispatched = { target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...event };
      for (const handler of this.listeners[name] || []) handler(dispatched);
      return dispatched;
    }
    contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
    focus() { document.activeElement = this; }
    closest(selector) { return selector === "a[href]" && this.tagName === "A" ? this : null; }
    querySelectorAll() { return this.children; }
    querySelector(selector) {
      return this.children.find((child) => child.tagName === "A" && (selector !== "a[aria-current]" || child.attributes["aria-current"])) || null;
    }
  }
  const elements = {
    "app-sidebar": new Element("aside"),
    "menu-toggle": new Element("button"),
    "sidebar-close": new Element("button"),
    "sidebar-backdrop": new Element(),
    "main-content": new Element("main"),
  };
  const currentLink = new Element("a");
  currentLink.setAttribute("aria-current", "page");
  const lastLink = new Element("a");
  elements["app-sidebar"].children = [elements["sidebar-close"], currentLink, lastLink];
  const mainInput = new Element("input");
  elements["main-content"].children = [elements["menu-toggle"], mainInput];
  document.body = new Element("body");
  document.activeElement = document.body;
  document.getElementById = (id) => elements[id];
  document.addEventListener = Element.prototype.addEventListener;
  document.fire = Element.prototype.fire;
  const media = new Element();
  media.matches = width <= 768;
  const window = { matchMedia(query) { assert.equal(query, "(max-width: 768px)"); return media; } };
  vm.runInNewContext(fs.readFileSync(path.join(root, "js/layout.js"), "utf8"), { document, window });
  const open = () => { elements["menu-toggle"].focus(); elements["menu-toggle"].fire("click"); };
  const resize = (nextWidth) => { media.matches = nextWidth <= 768; media.fire("change"); };
  return { document, elements, currentLink, lastLink, mainInput, open, resize };
}

test("Every page wires the same accessible drawer and loads layout independently of data", () => {
  for (const page of pages) {
    const html = fs.readFileSync(path.join(root, page), "utf8");
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(new Set(ids).size, ids.length, `Duplicate ID in ${page}`);
    for (const id of ["app-sidebar", "menu-toggle", "sidebar-close", "sidebar-backdrop", "main-content"]) assert.ok(ids.includes(id), `${page} missing ${id}`);
    assert.match(html, /<button[^>]+id="menu-toggle"[^>]+aria-controls="app-sidebar"[^>]+aria-expanded="false"/);
    assert.match(html, /<div[^>]+id="sidebar-backdrop"[^>]+hidden/);
    const scripts = [...html.matchAll(/<script\b[^>]*src="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(scripts.filter((source) => source === "js/layout.js").length, 1);
    assert.ok(scripts.indexOf("js/layout.js") < scripts.indexOf("js/data.js"));
    assert.match(html, /assets\/images\/logo\.png/);
    assert.match(html, /assets\/images\/bello\.png/);
    assert.match(html, /<a\b[^>]+href="interaction\.html"[^>]*>[\s\S]*?Interaction[\s\S]*?<\/a>/, `${page} missing Interaction navigation`);
  }
});

test("Interaction page loads its isolated store before UI and exposes a scrollable evaluation table", () => {
  const html = fs.readFileSync(path.join(root, "interaction.html"), "utf8");
  const scripts = [...html.matchAll(/<script\b[^>]*src="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(scripts.indexOf("js/data.js") < scripts.indexOf("js/interaction-data.js"));
  assert.ok(scripts.indexOf("js/interaction-data.js") < scripts.indexOf("js/interaction.js"));
  assert.match(html, /<a\b(?=[^>]*href="interaction\.html")(?=[^>]*aria-current="page")[^>]*>/);
  for (const label of ["Member Name", "Facebook", "General", "SM", "HR", "Suggested", "Final"]) {
    assert.match(html, new RegExp(`<th\\b[^>]*>\\s*${label}\\s*</th>`));
  }
});

test("Dashboard backup and restore controls expose file input, replacement note, and feedback", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  for (const id of ["backup-data-btn", "restore-data-btn", "restore-file", "backup-status", "backup-error"]) assert.ok(html.includes(`id="${id}"`));
  assert.match(html, /<input[^>]+id="restore-file"[^>]+type="file"[^>]+accept="\.json"[^>]+hidden/);
  assert.match(html, /Restore replaces saved members and activities\./);
  assert.match(html, /id="backup-status"[^>]+role="status"/);
  assert.match(html, /id="backup-error"[^>]+role="alert"[^>]+hidden/);
  assert.ok(html.indexOf('src="js/data.js"') > html.indexOf("</main>"));
});

test("Mobile drawer starts inaccessible, opens with focus, and Escape restores the opener", () => {
  const { elements, document, open } = setup();
  const sidebar = elements["app-sidebar"];
  const toggle = elements["menu-toggle"];
  assert.equal(sidebar.inert, true);
  assert.equal(sidebar.getAttribute("aria-hidden"), "true");
  assert.equal(elements["sidebar-backdrop"].hidden, true);
  assert.equal(elements["main-content"].inert, false);
  open();
  assert.equal(sidebar.classList.contains("sidebar-active"), true);
  assert.equal(sidebar.inert, false);
  assert.equal(sidebar.getAttribute("aria-hidden"), null);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(elements["main-content"].inert, true);
  assert.equal(elements["sidebar-backdrop"].hidden, false);
  assert.equal(document.activeElement, elements["sidebar-close"]);
  const escape = document.fire("keydown", { key: "Escape" });
  assert.equal(escape.defaultPrevented, true);
  assert.equal(sidebar.classList.contains("sidebar-active"), false);
  assert.equal(elements["main-content"].inert, false);
  assert.equal(elements["sidebar-backdrop"].hidden, true);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(document.body.classList.contains("sidebar-open"), false);
  assert.equal(document.activeElement, toggle);
});

test("Close button, backdrop, and current navigation link all release the page and restore focus", () => {
  for (const method of ["close", "backdrop", "link"]) {
    const { elements, document, currentLink, open } = setup();
    open();
    if (method === "close") elements["sidebar-close"].fire("click");
    else if (method === "backdrop") elements["sidebar-backdrop"].fire("click");
    else elements["app-sidebar"].fire("click", { target: currentLink });
    assert.equal(elements["main-content"].inert, false, method);
    assert.equal(elements["app-sidebar"].inert, true, method);
    assert.equal(document.activeElement, elements["menu-toggle"], method);
  }
});

test("Keyboard navigation cycles within an open drawer", () => {
  const { elements, document, lastLink, open } = setup();
  open();
  const reverse = document.fire("keydown", { key: "Tab", shiftKey: true });
  assert.equal(reverse.defaultPrevented, true);
  assert.equal(document.activeElement, lastLink);
  const forward = document.fire("keydown", { key: "Tab", shiftKey: false });
  assert.equal(forward.defaultPrevented, true);
  assert.equal(document.activeElement, elements["sidebar-close"]);
});

test("Pointer opening still returns focus to the hamburger when the browser leaves body focused", () => {
  const { elements, document } = setup();
  assert.equal(document.activeElement, document.body);
  elements["menu-toggle"].fire("click");
  elements["sidebar-close"].fire("click");
  assert.equal(document.activeElement, elements["menu-toggle"]);
});

test("Crossing the 768px boundary resets drawer state and keeps focus on visible controls", () => {
  const { elements, document, currentLink, open, resize } = setup(768);
  open();
  resize(769);
  assert.equal(elements["main-content"].inert, false);
  assert.equal(elements["app-sidebar"].inert, false);
  assert.equal(elements["sidebar-backdrop"].hidden, true);
  assert.equal(elements["app-sidebar"].classList.contains("sidebar-active"), false);
  assert.equal(document.activeElement, currentLink);
  resize(768);
  assert.equal(elements["app-sidebar"].inert, true);
  assert.equal(elements["main-content"].inert, false);
  assert.equal(document.activeElement, elements["menu-toggle"]);
});

test("Desktop sidebar stays available and a viewport change preserves unrelated input focus", () => {
  const { elements, document, mainInput, resize } = setup(1440);
  assert.equal(elements["app-sidebar"].inert, false);
  elements["menu-toggle"].fire("click");
  assert.equal(elements["main-content"].inert, false);
  mainInput.focus();
  resize(761);
  assert.equal(elements["app-sidebar"].inert, true);
  assert.equal(document.activeElement, mainInput);
  resize(900);
  assert.equal(elements["app-sidebar"].inert, false);
  assert.equal(document.activeElement, mainInput);
});
