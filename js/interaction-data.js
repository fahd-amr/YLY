(function () {
  "use strict";

  const KEYS = ["interactionSettings", "checkpoints", "checkpointInteractions", "hrEvaluations", "finalEvaluations"];
  const DEFAULT_SETTINGS = { fb: 2, general: 2, sm: 3, hr: 3 };
  const WEIGHTS = Object.keys(DEFAULT_SETTINGS);
  const TYPES = { Facebook: "fb", General: "general", SM: "sm" };
  const STATUSES = {
    Facebook: ["Reacted", "Commented", "Shared", "None"],
    General: ["Reacted", "Replied", "Participated", "None"],
    SM: ["Reacted", "Replied", "Participated", "None"],
  };
  const HR_FIELDS = ["responds", "proofs", "properComm"];
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const round = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

  // Defining map entries avoids special handling of member IDs such as __proto__.
  function put(map, key, value) {
    Object.defineProperty(map, key, { value, enumerable: true, configurable: true, writable: true });
  }

  function identifier(value) {
    if (!((typeof value === "string" && value.trim()) || (typeof value === "number" && Number.isFinite(value)))) {
      throw new Error("A valid record ID is required.");
    }
    return String(value);
  }

  function validateMonth(month) {
    if (typeof month !== "string" || !/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      throw new Error("Choose a valid month.");
    }
    return month;
  }

  // Evaluations use local calendar months; activity cycles remain date ranges.
  function currentMonth(date = new Date()) {
    return validateMonth(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`);
  }

  function validateDate(date) {
    if (typeof date !== "string" || !/^(?!0000)\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(date)) {
      throw new Error("Choose a valid checkpoint date.");
    }
    const [year, month, day] = date.split("-").map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (day > days[month - 1]) throw new Error("Choose a valid checkpoint date.");
    return date;
  }

  function validateSettings(settings) {
    if (!object(settings) || WEIGHTS.some((key) => !own(settings, key) || !Number.isInteger(settings[key]) || settings[key] < 0 || settings[key] > 10)) {
      throw new Error("Weights must be whole numbers from 0 to 10. Weights must total 10.");
    }
    if (WEIGHTS.reduce((sum, key) => sum + settings[key], 0) !== 10) throw new Error("Weights must total 10.");
    return settings;
  }

  function validateHR(value) {
    if (!object(value) || HR_FIELDS.some((key) => !own(value, key) || typeof value[key] !== "boolean")) {
      throw new Error("HR evaluation must contain three checkbox values.");
    }
  }

  function validateEvaluationKey(key) {
    validateMonth(key.slice(0, 7));
    if (key[7] !== "_" || !key.slice(8).trim()) throw new Error("An evaluation has an invalid member ID.");
  }

  function validateState(state) {
    validateSettings(state.interactionSettings);
    if (!Array.isArray(state.checkpoints)) throw new Error("Saved checkpoints must be an array.");
    const checkpointsById = Object.create(null);
    state.checkpoints.forEach((checkpoint) => {
      if (!object(checkpoint)) throw new Error("A saved checkpoint is invalid.");
      const id = identifier(checkpoint.id);
      if (own(checkpointsById, id)) throw new Error("Saved checkpoints contain a duplicate ID.");
      if (!own(TYPES, checkpoint.type)) throw new Error("Choose Facebook, General, or SM for the checkpoint type.");
      validateDate(checkpoint.date);
      validateMonth(checkpoint.month);
      if (checkpoint.month !== checkpoint.date.slice(0, 7)) throw new Error("The checkpoint month must match its date.");
      if (typeof checkpoint.title !== "string" || !checkpoint.title.trim()) throw new Error("A checkpoint title is required.");
      if (!["Yes", "No"].includes(checkpoint.interactionExpected)) throw new Error("Choose whether interaction is expected.");
      put(checkpointsById, id, checkpoint);
    });
    KEYS.slice(2).forEach((key) => {
      if (!object(state[key])) throw new Error("Saved " + key + " must be an object.");
    });
    Object.entries(state.checkpointInteractions).forEach(([checkpointId, memberMap]) => {
      identifier(checkpointId);
      if (!object(memberMap)) throw new Error("Saved checkpoint interactions must map members to statuses.");
      const allowed = own(checkpointsById, checkpointId)
        ? STATUSES[checkpointsById[checkpointId].type]
        : ["Reacted", "Commented", "Shared", "Replied", "Participated", "None"];
      Object.entries(memberMap).forEach(([memberId, status]) => {
        identifier(memberId);
        if (!allowed.includes(status)) throw new Error("A saved checkpoint interaction status is invalid.");
      });
    });
    Object.entries(state.hrEvaluations).forEach(([key, value]) => {
      validateEvaluationKey(key);
      validateHR(value);
    });
    Object.entries(state.finalEvaluations).forEach(([key, value]) => {
      validateEvaluationKey(key);
      if (!object(value) || !Number.isInteger(value.finalScore) || value.finalScore < 0 || value.finalScore > 10
        || typeof value.suggestedScore !== "number" || !Number.isFinite(value.suggestedScore)
        || value.suggestedScore < 0 || value.suggestedScore > 10 || typeof value.note !== "string") {
        throw new Error("A saved final evaluation is invalid. Final scores must be whole numbers from 0 to 10.");
      }
    });
    return state;
  }

  function notify(keys) {
    // A failed listener must never make a successful storage write appear to fail.
    try {
      if (typeof window.CustomEvent === "function" && typeof window.dispatchEvent === "function") {
        window.dispatchEvent(new window.CustomEvent("yly:interaction-changed", { detail: { keys } }));
      }
    } catch (_) { /* Data is already saved. */ }
  }

  function commit(changes) {
    const entries = Object.entries(changes).map(([key, value]) => [key, JSON.stringify(value)]);
    const before = entries.map(([key]) => [key, window.localStorage.getItem(key)]);
    const written = [];
    try {
      entries.forEach(([key, serialized]) => {
        window.localStorage.setItem(key, serialized);
        written.push(key);
      });
    } catch (error) {
      let rollbackFailed = false;
      before.forEach(([key, previous]) => {
        if (!written.includes(key)) return;
        try {
          if (previous === null) window.localStorage.removeItem(key);
          else window.localStorage.setItem(key, previous);
        } catch (_) { rollbackFailed = true; }
      });
      if (rollbackFailed) throw new Error("Saving failed and some previous values could not be restored. Check saved data before continuing.");
      throw new Error("Interaction data could not be saved. Previous data was kept. " + (error.message || ""));
    }
    if (entries.length) notify(entries.map(([key]) => key));
  }

  function initialize() {
    const defaults = { interactionSettings: { ...DEFAULT_SETTINGS }, checkpoints: [], checkpointInteractions: {}, hrEvaluations: {}, finalEvaluations: {} };
    const state = {};
    const missing = {};
    KEYS.forEach((key) => {
      const raw = window.localStorage.getItem(key);
      if (raw === null) {
        state[key] = defaults[key];
        missing[key] = defaults[key];
      } else {
        try { state[key] = JSON.parse(raw); }
        catch (_) { throw new Error("Saved " + key + " contains invalid JSON. Existing data has not been changed."); }
      }
    });
    // Validate every stored key before writing even a missing default.
    validateState(state);
    commit(missing);
    return state;
  }

  function read() { return initialize(); }

  function activeMember(memberId) {
    const id = identifier(memberId);
    if (!window.YLYData || typeof window.YLYData.getMembers !== "function") throw new Error("Member data is unavailable.");
    const member = window.YLYData.getMembers().find((entry) => entry && String(entry.id) === id);
    if (!member || window.YLYData.isMemberArchived(member)) throw new Error("Choose an active member.");
    return member;
  }

  function saveSettings(settings) {
    validateSettings(settings);
    read();
    const next = Object.fromEntries(WEIGHTS.map((key) => [key, settings[key]]));
    commit({ interactionSettings: next });
    return next;
  }

  function addCheckpoint(details) {
    if (!object(details)) throw new Error("Checkpoint details are required.");
    if (!own(TYPES, details.type)) throw new Error("Choose Facebook, General, or SM for the checkpoint type.");
    validateDate(details.date);
    if (typeof details.title !== "string" || !details.title.trim()) throw new Error("A checkpoint title is required.");
    const expected = details.interactionExpected === undefined ? "Yes" : details.interactionExpected;
    if (!["Yes", "No"].includes(expected)) throw new Error("Choose whether interaction is expected.");
    const state = read();
    const base = "cp-" + Date.now().toString(36);
    let id = base;
    let suffix = 1;
    while (state.checkpoints.some((checkpoint) => String(checkpoint.id) === id)) id = base + "-" + suffix++;
    const checkpoint = { id, month: details.date.slice(0, 7), type: details.type, title: details.title.trim(), date: details.date, interactionExpected: expected };
    state.checkpoints.push(checkpoint);
    commit({ checkpoints: state.checkpoints });
    return checkpoint;
  }

  function saveCheckpointInteractions(checkpointId, updates) {
    const id = identifier(checkpointId);
    if (!object(updates)) throw new Error("Choose member interaction statuses.");
    const state = read();
    const checkpoint = state.checkpoints.find((entry) => String(entry.id) === id);
    if (!checkpoint) throw new Error("This checkpoint no longer exists.");
    Object.entries(updates).forEach(([memberId, status]) => {
      activeMember(memberId);
      if (!STATUSES[checkpoint.type].includes(status)) throw new Error("Choose an interaction status for this checkpoint type.");
    });
    const memberMap = own(state.checkpointInteractions, id) ? state.checkpointInteractions[id] : {};
    Object.entries(updates).forEach(([memberId, status]) => put(memberMap, memberId, status));
    put(state.checkpointInteractions, id, memberMap);
    if (Object.keys(updates).length) commit({ checkpointInteractions: state.checkpointInteractions });
    return memberMap;
  }

  function calculateMember(month, memberId, providedState, hrOverride) {
    validateMonth(month);
    const id = identifier(memberId);
    const state = providedState ? validateState(providedState) : read();
    const key = month + "_" + id;
    const settings = state.interactionSettings;
    const categories = {};
    ["fb", "general", "sm"].forEach((category) => {
      categories[category] = { interacted: 0, checked: 0, total: 0, score: 0, weight: settings[category] };
    });
    state.checkpoints.forEach((checkpoint) => {
      if (checkpoint.month !== month || checkpoint.interactionExpected !== "Yes") return;
      const category = categories[TYPES[checkpoint.type]];
      category.total += 1;
      const checkpointId = String(checkpoint.id);
      const interactions = own(state.checkpointInteractions, checkpointId) ? state.checkpointInteractions[checkpointId] : null;
      if (interactions && own(interactions, id)) {
        category.checked += 1;
        if (interactions[id] !== "None") category.interacted += 1;
      }
    });
    let suggested = 0;
    let missingLogs = 0;
    Object.values(categories).forEach((category) => {
      const score = category.checked ? (category.interacted / category.checked) * category.weight : category.weight;
      category.score = round(score);
      suggested += score;
      missingLogs += category.total - category.checked;
    });
    const checklist = hrOverride === undefined
      ? (own(state.hrEvaluations, key) ? state.hrEvaluations[key] : { responds: false, proofs: false, properComm: false })
      : hrOverride;
    validateHR(checklist);
    const checked = HR_FIELDS.filter((field) => checklist[field]).length;
    const hrScore = checked / 3 * settings.hr;
    const hr = { responds: checklist.responds, proofs: checklist.proofs, properComm: checklist.properComm, checked, score: round(hrScore), weight: settings.hr };
    const suggestedScore = round(Math.max(0, Math.min(10, suggested + hrScore)));
    const finalEvaluation = own(state.finalEvaluations, key) ? state.finalEvaluations[key] : null;
    const needsReview = !finalEvaluation || round(finalEvaluation.suggestedScore) !== suggestedScore || missingLogs > 0;
    return { categories, hr, suggestedScore, finalEvaluation, missingLogs, needsReview };
  }

  function saveEvaluation(month, memberId, payload) {
    validateMonth(month);
    const id = identifier(memberId);
    activeMember(id);
    if (!object(payload)) throw new Error("Evaluation details are required.");
    validateHR(payload);
    if (!Number.isInteger(payload.finalScore) || payload.finalScore < 0 || payload.finalScore > 10) {
      throw new Error("Choose a final score from 0 to 10. Decimals are not allowed.");
    }
    if (typeof payload.note !== "string") throw new Error("The evaluation note must be text.");
    const state = read();
    const key = month + "_" + id;
    const checklist = Object.fromEntries(HR_FIELDS.map((field) => [field, payload[field]]));
    const result = calculateMember(month, id, state, checklist);
    const priorHR = own(state.hrEvaluations, key) ? state.hrEvaluations[key] : {};
    const priorFinal = own(state.finalEvaluations, key) ? state.finalEvaluations[key] : {};
    put(state.hrEvaluations, key, { ...priorHR, ...checklist });
    const finalEvaluation = { ...priorFinal, suggestedScore: result.suggestedScore, finalScore: payload.finalScore, note: payload.note };
    put(state.finalEvaluations, key, finalEvaluation);
    commit({ hrEvaluations: state.hrEvaluations, finalEvaluations: state.finalEvaluations });
    return finalEvaluation;
  }

  window.YLYInteraction = Object.freeze({ initialize, read, currentMonth, saveSettings, addCheckpoint, saveCheckpointInteractions, calculateMember, saveEvaluation });
})();
