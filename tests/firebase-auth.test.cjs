const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL, fileURLToPath } = require("node:url");

// Node gates its ESM VM API behind this flag. Keep the ordinary test command usable.
if (!vm.SourceTextModule) {
  test("Firebase authentication integration (isolated ESM runner)", () => {
    const result = require("node:child_process").spawnSync(process.execPath,
      ["--experimental-vm-modules", "--test", __filename], { encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
} else {
  const root = path.join(__dirname, "..");
  const sdk = "https://www.gstatic.com/firebasejs/9.23.0/";
  const expectedConfig = {
    apiKey: "AIzaSyBhXqorMLv79RoGkH1lbjGql1NBolpVLfQ",
    authDomain: "yly-follow-up.firebaseapp.com",
    projectId: "yly-follow-up",
    storageBucket: "yly-follow-up.firebasestorage.app",
    messagingSenderId: "553634863389",
    appId: "1:553634863389:web:613c93ff7d7938c5a43184",
    measurementId: "G-J91EQXSM08",
  };

  class Element {
    constructor() {
      this.listeners = {};
      this.value = "";
      this.textContent = "";
      this.disabled = this.hidden = false;
      this.attributes = {};
      this.valid = true;
    }
    addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
    async fire(type, extras = {}) {
      await Promise.all((this.listeners[type] || []).map((handler) => handler({
        target: this, preventDefault() {}, ...extras,
      })));
    }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    removeAttribute(key) { delete this.attributes[key]; }
    getAttribute(key) { return this.attributes[key] ?? null; }
    checkValidity() { return this.valid; }
    reportValidity() { return this.valid; }
    focus() { this.focused = true; }
  }

  const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise(setImmediate); };
  function deferred() {
    let resolve, reject;
    const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
    return { promise, resolve, reject };
  }

  function harness({ importFailure = false, observerFailure = false } = {}) {
    const ids = ["login-form", "login-fields", "login-email", "login-password", "login-button", "login-error", "login-status"];
    const elements = Object.fromEntries(ids.map((id) => [id, new Element()]));
    elements["login-fields"].disabled = true;
    elements["login-error"].hidden = true;
    const redirects = [], credentials = [], imported = [], configs = [], services = [];
    const app = { name: "fixture-app" }, auth = { currentUser: null }, db = { name: "fixture-db" };
    let observer, observerError, unsubscribeCalls = 0;
    let signIn = () => Promise.resolve({ user: { uid: "member-1" } });
    const storage = new Proxy({}, { get() { throw new Error("Authentication must not read or write application LocalStorage"); } });
    const location = { replace(value) { redirects.push(value); } };
    const document = { readyState: "complete", getElementById: (id) => elements[id], addEventListener() {} };
    const window = { location, localStorage: storage, document };
    const context = vm.createContext({ window, document, location, localStorage: storage, console, setTimeout, clearTimeout });
    const modules = new Map();
    const mocks = {
      [`${sdk}firebase-app.js`]: {
        initializeApp(config) { configs.push(JSON.parse(JSON.stringify(config))); return app; },
      },
      [`${sdk}firebase-auth.js`]: {
        getAuth(value) { services.push(["auth", value]); return auth; },
        onAuthStateChanged(value, onUser, onError) {
          assert.equal(value, auth);
          if (observerFailure) throw new Error("Listener unavailable");
          observer = onUser;
          observerError = onError;
          return () => { unsubscribeCalls += 1; };
        },
        signInWithEmailAndPassword(value, email, password) {
          assert.equal(value, auth);
          credentials.push({ email, password });
          return signIn();
        },
      },
      [`${sdk}firebase-firestore.js`]: {
        getFirestore(value) { services.push(["firestore", value]); return db; },
      },
    };
    async function load(specifier, parent = pathToFileURL(path.join(root, "js", "entry.js")).href) {
      const url = new URL(specifier, parent).href;
      if (modules.has(url)) return modules.get(url);
      imported.push(url);
      if (importFailure && url.startsWith("https:")) throw new Error("CDN fetch failed");
      let module;
      if (url.startsWith("https:")) {
        assert.ok(mocks[url], `Unexpected Firebase CDN dependency: ${url}`);
        const exports = mocks[url];
        module = new vm.SyntheticModule(Object.keys(exports), function () {
          for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
        }, { context, identifier: url });
      } else {
        module = new vm.SourceTextModule(fs.readFileSync(fileURLToPath(url), "utf8"), {
          context, identifier: url,
          importModuleDynamically: async (child, referencingModule) => {
            const dependency = await load(child, referencingModule.identifier);
            if (dependency.status === "unlinked") await dependency.link(linker);
            if (dependency.status === "linked") await dependency.evaluate();
            return dependency;
          },
        });
      }
      modules.set(url, module);
      return module;
    }
    const linker = (specifier, module) => load(specifier, module.identifier);
    async function run(file) {
      const module = await load(`./${file}`);
      await module.link(linker);
      await module.evaluate();
      await settle();
      return module.namespace;
    }
    return {
      elements, redirects, credentials, imported, configs, services, app, auth, db, run,
      setSignIn(callback) { signIn = callback; },
      async emitUser(user) {
        assert.equal(typeof observer, "function", "Auth observer must be installed");
        auth.currentUser = user;
        observer(user);
        await settle();
      },
      async emitObserverError() {
        assert.equal(typeof observerError, "function", "Auth observer must handle failures");
        observerError(new Error("Session storage unavailable"));
        await settle();
      },
      get unsubscribeCalls() { return unsubscribeCalls; },
    };
  }

  async function readyLogin(options) {
    const env = harness(options);
    await env.run("login.js");
    await env.emitUser(null);
    env.elements["login-email"].value = "  hr@yly.example  ";
    env.elements["login-password"].value = "  private password  ";
    return env;
  }

  test("Firebase config uses the supplied project and initializes Auth and Firestore from one app", async () => {
    const env = harness();
    const namespace = await env.run("firebase-config.js");
    assert.deepEqual(env.configs, [expectedConfig]);
    assert.equal(namespace.app, env.app);
    assert.equal(namespace.auth, env.auth);
    assert.equal(namespace.db, env.db);
    assert.deepEqual(env.services, [["auth", env.app], ["firestore", env.app]]);
    assert.equal(env.imported.filter((url) => url.startsWith(sdk)).length, 3);
  });

  test("Login waits for session restoration before enabling credential entry", async () => {
    const env = harness();
    await env.run("login.js");
    assert.equal(env.elements["login-fields"].disabled, true);
    await env.emitUser(null);
    assert.equal(env.elements["login-fields"].disabled, false);
    assert.deepEqual(env.redirects, []);
  });

  test("An existing authenticated session redirects without asking for credentials", async () => {
    const env = harness();
    await env.run("login.js");
    await env.emitUser({ uid: "already-signed-in" });
    assert.deepEqual(env.redirects, ["index.html"]);
    assert.deepEqual(env.credentials, []);
  });

  test("Email is trimmed, password is preserved, and successful login redirects exactly once", async () => {
    const env = await readyLogin();
    await env.elements["login-form"].fire("submit");
    assert.deepEqual(env.credentials, [{ email: "hr@yly.example", password: "  private password  " }]);
    assert.deepEqual(env.redirects, ["index.html"]);
    await env.emitUser({ uid: "member-1" });
    assert.deepEqual(env.redirects, ["index.html"]);
  });

  test("Repeated submits cannot start concurrent login requests; observer-first success redirects once", async () => {
    const env = await readyLogin();
    const pending = deferred();
    env.setSignIn(() => pending.promise);
    const firstSubmit = env.elements["login-form"].fire("submit");
    await settle();
    await env.elements["login-form"].fire("submit");
    assert.equal(env.credentials.length, 1);
    assert.equal(env.elements["login-fields"].disabled, true);
    await env.emitUser({ uid: "member-1" });
    pending.resolve({ user: { uid: "member-1" } });
    await firstSubmit;
    assert.deepEqual(env.redirects, ["index.html"]);
  });

  test("Invalid credentials show a safe message and allow another attempt", async () => {
    const env = await readyLogin();
    env.setSignIn(() => Promise.reject(Object.assign(new Error("Secret server account detail"), { code: "auth/wrong-password" })));
    await env.elements["login-form"].fire("submit");
    assert.equal(env.elements["login-error"].hidden, false);
    assert.equal(env.elements["login-error"].textContent, "Invalid credentials");
    assert.equal(env.elements["login-fields"].disabled, false);
    assert.deepEqual(env.redirects, []);
    env.setSignIn(() => Promise.resolve({ user: { uid: "member-1" } }));
    await env.elements["login-form"].fire("submit");
    assert.equal(env.elements["login-error"].hidden, true);
    assert.deepEqual(env.redirects, ["index.html"]);
  });

  test("A CDN failure is surfaced without enabling a nonfunctional login form", async () => {
    const env = harness({ importFailure: true });
    await env.run("login.js");
    assert.equal(env.elements["login-fields"].disabled, true);
    assert.equal(env.elements["login-error"].hidden, false);
    assert.match(env.elements["login-error"].textContent, /unavailable|unable|could not/i);
    assert.deepEqual(env.redirects, []);
  });

  test("Auth observer failures leave login disabled and explain its unavailable state", async () => {
    const env = harness();
    await env.run("login.js");
    await env.emitObserverError();
    assert.equal(env.elements["login-fields"].disabled, true);
    assert.equal(env.elements["login-error"].hidden, false);
    assert.match(env.elements["login-error"].textContent, /unavailable|unable|could not/i);
    assert.deepEqual(env.redirects, []);
  });

  test("Synchronous auth setup errors are handled without an unhandled rejection", async () => {
    const env = harness({ observerFailure: true });
    await env.run("login.js");
    assert.equal(env.elements["login-fields"].disabled, true);
    assert.equal(env.elements["login-error"].hidden, false);
    assert.deepEqual(env.redirects, []);
  });

  test("Route guard redirects signed-out users and returns the Firebase unsubscribe function", async () => {
    const env = harness();
    const namespace = await env.run("auth-guard.js");
    const called = [];
    const stop = namespace.requireAuth((user) => called.push(user));
    await env.emitUser(null);
    assert.deepEqual(env.redirects, ["login.html"]);
    assert.deepEqual(called, []);
    stop();
    assert.equal(env.unsubscribeCalls, 1);
  });

  test("Route guard waits for authentication before initializing a protected page", async () => {
    const env = harness();
    const namespace = await env.run("auth-guard.js");
    const called = [];
    namespace.requireAuth((user) => called.push(user));
    assert.deepEqual(called, []);
    const user = { uid: "member-2" };
    await env.emitUser(user);
    assert.deepEqual(called, [user]);
    assert.deepEqual(env.redirects, []);
    await env.emitUser(null);
    assert.deepEqual(env.redirects, ["login.html"]);
  });

  test("Route guard fails closed when Firebase cannot resolve the session", async () => {
    const env = harness();
    const namespace = await env.run("auth-guard.js");
    const called = [];
    namespace.requireAuth((user) => called.push(user));
    await env.emitObserverError();
    assert.deepEqual(env.redirects, ["login.html"]);
    assert.deepEqual(called, []);
  });
}
