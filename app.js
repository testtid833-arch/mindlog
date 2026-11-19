/* Mind Log — offline logger. Plain JS, no dependencies. Schema: meta/LOG_SCHEMA.md */
"use strict";

/* ------------------------------------------------------------------ schema */

// Canonical column order. Must match tools/mmschema.py COLUMNS.
const COLUMNS = [
  "id", "type", "created_at", "chapter", "tags", "note",
  "statement", "probability", "domain", "subject", "resolve_by", "outcome", "resolved_at",
  "kind", "trigger", "who", "state_tired", "state_hungry", "state_stressed", "state_interrupted",
  "intensity", "body_signal", "repair",
  "context", "cue", "inference", "model_part", "checked",
  "mission_id", "status", "debrief",
  "game", "result", "insight",
  "drill_id", "done", "quality",
];

const TYPES = ["prediction", "incident", "observation", "mission", "game", "drill"];
const TYPE_LABEL = {
  prediction: "Prediction", incident: "Incident", observation: "Observation",
  mission: "Mission", game: "Game", drill: "Drill",
};

const CHAPTERS = [
  ["00", "Baseline: Your Source Code"],
  ["01", "The Observing Mind"], ["02", "The 2-Second Gap"], ["03", "Speaking Up"],
  ["04", "Need & Independence"], ["05", "Biases & Motivated Reasoning"], ["06", "Bayes & Calibration"],
  ["07", "Causality & Systems"], ["08", "The Person Model"], ["09", "Reading People"],
  ["10", "Status, Power & Politics"], ["11", "Honest Influence"], ["12", "Attraction & Choosing Well"],
  ["13", "Dark-Triad Personalities"], ["14", "Cons & Social Engineering"], ["15", "Coercive Control"],
  ["16", "Propaganda & Interrogation"], ["17", "Game Theory"], ["18", "Decisions Under Uncertainty"],
  ["19", "Long Games in History"], ["20", "Your Life Strategy"], ["21", "Listening & Socratic Style"],
  ["22", "Warmth & First Impressions"], ["23", "Unreadable Composure"], ["24", "Capstone: The Doctrine"],
];

/* ------------------------------------------------------------------ pure helpers (also used by tests) */

const pad = (n, w = 2) => String(n).padStart(w, "0");

/** Local ISO-8601 with offset, seconds precision: 2026-11-06T14:30:12+03:30 */
function isoLocal(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:` +
    `${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

function dateLocal(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

/** Timestamp-based id: 20261106-143012-a7k */
function newId(d = new Date()) {
  const r = Math.random().toString(36).slice(2, 5).padEnd(3, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${r}`;
}

/** ISO week of a YYYY-MM-DD... string (uses the date as written, i.e. local date). */
function isoWeek(s) {
  if (!s) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
  if (!m) return "";
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const y = d.getUTCFullYear();
  const wk = Math.ceil(((d - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return `${y}-W${pad(wk)}`;
}

function csvField(v) {
  const s = v === undefined || v === null ? "" : String(v);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** RFC 4180 CSV (CRLF), UTF-8 BOM so Excel opens it correctly. */
function toCSV(entries) {
  const lines = [COLUMNS.join(",")];
  for (const e of entries) lines.push(COLUMNS.map((c) => csvField(e[c])).join(","));
  return "﻿" + lines.join("\r\n") + "\r\n";
}

/** RFC 4180 parser -> array of rows (arrays of strings). Handles quotes, "" escapes, CRLF/LF, BOM. */
function parseCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [], field = "", i = 0, q = false;
  while (i < text.length) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        q = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { q = true; i++; continue; }
    if (ch === ",") { row.push(field); field = ""; i++; continue; }
    if (ch === "\r") { i++; continue; }
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += ch; i++;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

/** CSV text -> entry objects (by header name; unknown columns ignored). */
function csvToEntries(text) {
  const rows = parseCSV(text);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const e = {};
    for (const c of COLUMNS) e[c] = "";
    head.forEach((h, j) => { if (COLUMNS.includes(h)) e[h] = (r[j] ?? "").trim(); });
    return e;
  }).filter((e) => e.id);
}

function tsOf(s) { const t = Date.parse(s); return Number.isNaN(t) ? -Infinity : t; }

/** Merge rule shared with tools/score.py: latest resolved_at wins; tie -> incoming wins. */
function mergeEntry(existing, incoming) {
  if (!existing) return { result: incoming, action: "added" };
  if (tsOf(incoming.resolved_at) < tsOf(existing.resolved_at)) return { result: existing, action: "kept" };
  const same = COLUMNS.every((c) => (existing[c] ?? "") === (incoming[c] ?? ""));
  return same ? { result: existing, action: "unchanged" } : { result: { ...existing, ...incoming }, action: "updated" };
}

/** Entries touched (created, edited or resolved) in an ISO week. */
function entriesForWeek(entries, week) {
  return entries.filter((e) =>
    isoWeek(e.created_at) === week || isoWeek(e._updated) === week || isoWeek(e.resolved_at) === week);
}

function drillStreak(entries, today = new Date()) {
  const days = new Set(entries.filter((e) => e.type === "drill" && String(e.done) === "1")
    .map((e) => String(e.created_at).slice(0, 10)));
  let d = new Date(today);
  if (!days.has(dateLocal(d))) d = addDays(d, -1);
  let n = 0;
  while (days.has(dateLocal(d))) { n++; d = addDays(d, -1); }
  return n;
}

function computeStats(entries, now = new Date()) {
  const wk = isoWeek(dateLocal(now));
  const today = dateLocal(now);
  const preds = entries.filter((e) => e.type === "prediction");
  const open = preds.filter((e) => e.outcome === "");
  const inc = entries.filter((e) => e.type === "incident" && isoWeek(e.created_at) === wk);
  return {
    week: wk,
    predWeek: preds.filter((e) => isoWeek(e.created_at) === wk).length,
    open: open.length,
    overdue: open.filter((e) => e.resolve_by && e.resolve_by < today).length,
    incWeek: inc.length,
    incKinds: { burst: 0, near: 0, gap: 0, ...countBy(inc, "kind") },
    streak: drillStreak(entries, now),
  };
}

function countBy(arr, key) {
  const o = {};
  for (const x of arr) o[x[key]] = (o[x[key]] || 0) + 1;
  return o;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { COLUMNS, TYPES, isoLocal, isoWeek, newId, toCSV, parseCSV, csvToEntries, mergeEntry,
    entriesForWeek, drillStreak, computeStats, csvField };
}

/* ------------------------------------------------------------------ app (browser only) */

if (typeof document !== "undefined") (function app() {
  const $ = (s, el = document) => el.querySelector(s);
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "html") el.innerHTML = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false)
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return el;
  };

  /* ---------- storage (IndexedDB) */
  const DB_NAME = "mindmaster", STORE = "entries";
  let dbPromise = null;
  function openDB() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "id" });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function tx(mode, fn) {
    if (!dbPromise) dbPromise = openDB();
    const db = await dbPromise;
    return new Promise((res, rej) => {
      const t = db.transaction(STORE, mode);
      const out = fn(t.objectStore(STORE));
      t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  }
  const dbAll = () => tx("readonly", (s) => s.getAll());
  const dbPut = (e) => tx("readwrite", (s) => { s.put(e); });
  const dbPutMany = (list) => tx("readwrite", (s) => { list.forEach((e) => s.put(e)); });
  const dbDel = (id) => tx("readwrite", (s) => { s.delete(id); });

  /* ---------- settings (localStorage, tolerant) */
  const LS = {
    get(k, d) { try { const v = localStorage.getItem("mm." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("mm." + k, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  const state = {
    entries: [],
    view: "home",
    type: LS.get("lastType", "prediction"),
    editing: null,          // entry being edited
    form: {},               // current form values
    touched: new Set(),
    filter: "all",
    listLimit: 50,
  };
  const chapter = () => LS.get("chapter", "00");

  /* ---------- recents (quick-picks) */
  function recent(field, n = 8, filter = () => true) {
    const seen = new Set(), out = [];
    const sorted = [...state.entries].sort((a, b) => (b.created_at > a.created_at ? 1 : -1));
    for (const e of sorted) {
      if (!filter(e)) continue;
      for (const f of [].concat(field)) {
        const vals = f === "tags" ? String(e.tags || "").split(";") : [e[f]];
        for (let v of vals) {
          v = (v || "").trim();
          if (v && !seen.has(v)) { seen.add(v); out.push(v); if (out.length >= n) return out; }
        }
      }
    }
    return out;
  }
  const codenames = (extra = []) => {
    const r = recent(["subject", "who"], 10).filter((v) => v !== "stranger");
    return [...new Set([...extra, ...r, ...(r.length < 4 ? ["W-mgr", "F-dad", "F-mom", "P-1"] : [])])].slice(0, 12);
  };

  /* ---------- form specs */
  const BODY = ["heat", "chest", "jaw", "voice", "hands", "face", "stomach"];
  const SPECS = {
    prediction: () => [
      { f: "statement", kind: "textarea", label: "Prediction (yes/no event)", req: true,
        ph: "W-mgr will push back on the deadline in Sunday's meeting" },
      { f: "probability", kind: "prob", label: "Chance it is TRUE", def: "0.7" },
      { f: "subject", kind: "text", label: "Who (codename)", chips: () => codenames(["SELF"]), ph: "W-mgr" },
      { f: "domain", kind: "seg", label: "Domain", opts: ["person", "group", "self", "world", "work"], def: "person" },
      { f: "resolve_by", kind: "date", label: "Known by", def: () => dateLocal(addDays(new Date(), 1)) },
      ...(state.editing ? [
        { f: "outcome", kind: "seg", label: "Outcome", opts: [["", "open"], ["1", "happened"], ["0", "didn't"]], def: "" },
      ] : []),
    ],
    incident: () => [
      { f: "kind", kind: "seg", cls: "kind", label: "What happened",
        opts: [["burst", "Burst (it came out)"], ["near", "Near (held it)"], ["gap", "Gap (chose)"]], def: "near", req: true },
      { f: "trigger", kind: "seg", label: "Trigger", req: true,
        opts: ["control", "disrespect", "unfair", "kid", "meaningless", "interrupted", "other"] },
      { f: "who", kind: "text", label: "Who (codename)", chips: () => codenames(["S"]), ph: "F-dad" },
      { f: "flags", kind: "flags", label: "State (HALT-I)" },
      { f: "intensity", kind: "range", label: "Peak intensity", min: 1, max: 10, def: "5" },
      { f: "body_signal", kind: "text", label: "Body signal", chips: () => [...new Set([...recent("body_signal", 4), ...BODY])],
        multi: true, ph: "heat in face" },
      { f: "repair", kind: "seg", label: "Repair", opts: [["not_needed", "not needed"], "apologized", "explained", "none"],
        def: "not_needed" },
    ],
    observation: () => [
      { f: "subject", kind: "text", label: "Who", chips: () => codenames(["stranger"]), req: true, ph: "stranger" },
      { f: "context", kind: "text", label: "Where", chips: () => recent("context", 6).concat(["metro", "meeting", "family dinner"]).filter((v, i, a) => a.indexOf(v) === i).slice(0, 8), ph: "metro" },
      { f: "cue", kind: "textarea", label: "What I saw / heard", req: true },
      { f: "inference", kind: "textarea", label: "What I think it means" },
      { f: "model_part", kind: "seg", label: "Model part", opts: ["objective", "constraint", "belief", "policy", "state"] },
      { f: "checked", kind: "seg", label: "Checked?", opts: [["", "not yet"], ["1", "confirmed"], ["0", "refuted"]], def: "" },
    ],
    mission: () => [
      { f: "mission_id", kind: "text", label: "Mission id", req: true,
        chips: () => recent("mission_id", 6, (e) => e.chapter === chapter()), def: () => `${chapter()}-M`, ph: `${chapter()}-M1` },
      { f: "status", kind: "seg", label: "Status", opts: ["done", "partial", "failed"], def: "done" },
      { f: "debrief", kind: "textarea", label: "Debrief: what happened, learned, next" },
    ],
    game: () => [
      { f: "game", kind: "text", label: "Game", req: true,
        chips: () => [...new Set(["rps", "ipd", "mafia", "poker", "chess", "diplomacy", ...recent("game", 4)])], ph: "mafia" },
      { f: "result", kind: "text", label: "Result", chips: () => ["win", "loss", "draw"], ph: "win / loss / score" },
      { f: "insight", kind: "textarea", label: "What it showed about me or others" },
    ],
    drill: () => [
      { f: "drill_id", kind: "text", label: "Drill id", req: true,
        chips: () => recent("drill_id", 6), def: () => recent("drill_id", 1, (e) => e.chapter === chapter())[0] || `${chapter()}-D1` },
      { f: "done", kind: "seg", label: "Done today", opts: [["1", "done"], ["0", "skipped"]], def: "1" },
      { f: "quality", kind: "seg", label: "Quality", opts: ["1", "2", "3", "4", "5"], def: "3" },
    ],
  };
  const MORE = () => [
    { f: "chapter", kind: "select", label: "Chapter", opts: CHAPTERS.map(([id, t]) => [id, `${id} ${t}`]), def: chapter },
    { f: "tags", kind: "text", label: "Tags (; separated)", chips: () => recent("tags", 8), multi: true, ph: "family;work" },
    { f: "note", kind: "textarea", label: "Note" },
  ];
  const FLAGS = [["state_tired", "Tired"], ["state_hungry", "Hungry"], ["state_stressed", "Stressed"], ["state_interrupted", "Interrupted"]];

  /* ---------- form rendering */
  function val(f) { return state.form[f] ?? ""; }
  function setVal(f, v, touched = true) {
    state.form[f] = v;
    if (touched) state.touched.add(f);
    // smart defaults
    if (f === "subject" && v === "SELF" && state.type === "prediction" && !state.touched.has("domain")) {
      state.form.domain = "self"; rerenderField("domain");
    }
    if (f === "kind" && state.type === "incident" && !state.touched.has("repair")) {
      state.form.repair = v === "burst" ? "none" : "not_needed"; rerenderField("repair");
    }
  }
  const fieldEls = {};
  function rerenderField(f) {
    const el = fieldEls[f];
    if (el) el.replaceWith(renderField(el._spec));
  }

  function renderField(sp) {
    const lab = h("span", { class: "lab" }, sp.label, sp.req ? h("span", { class: "req" }, " *") : null);
    let body;
    const optPairs = (sp.opts || []).map((o) => (Array.isArray(o) ? o : [o, o]));
    switch (sp.kind) {
      case "textarea":
        body = h("textarea", { rows: 3, placeholder: sp.ph || "", oninput: (e) => setVal(sp.f, e.target.value) });
        body.value = val(sp.f);
        break;
      case "text": {
        const inp = h("input", { type: "text", placeholder: sp.ph || "", autocapitalize: "none",
          oninput: (e) => { setVal(sp.f, e.target.value); markChips(); } });
        inp.value = val(sp.f);
        const chips = h("div", { class: "chips" });
        const markChips = () => {
          const cur = sp.multi ? String(val(sp.f)).split(";").map((s) => s.trim()) : [val(sp.f)];
          chips.querySelectorAll("button").forEach((b) => b.classList.toggle("on", cur.includes(b.dataset.v)));
        };
        for (const c of (sp.chips ? sp.chips() : [])) {
          chips.append(h("button", { type: "button", "data-v": c, onclick: () => {
            if (sp.multi) {
              const parts = String(val(sp.f)).split(";").map((s) => s.trim()).filter(Boolean);
              const i = parts.indexOf(c);
              if (i >= 0) parts.splice(i, 1); else parts.push(c);
              setVal(sp.f, parts.join(";"));
            } else setVal(sp.f, val(sp.f) === c ? "" : c);
            inp.value = val(sp.f); markChips();
          } }, c));
        }
        markChips();
        body = h("div", {}, inp, chips.childElementCount ? chips : null);
        break;
      }
      case "seg": {
        body = h("div", { class: "seg " + (sp.cls || ""), role: "radiogroup" });
        for (const [v, l] of optPairs) {
          body.append(h("button", { type: "button", "data-v": v, class: val(sp.f) === v ? "on" : "",
            role: "radio", "aria-checked": String(val(sp.f) === v),
            onclick: (e) => {
              setVal(sp.f, v);
              body.querySelectorAll("button").forEach((b) => {
                b.classList.toggle("on", b === e.currentTarget);
                b.setAttribute("aria-checked", String(b === e.currentTarget));
              });
              fieldEls[sp.f].classList.remove("invalid");
            } }, l));
        }
        break;
      }
      case "select": {
        body = h("select", { onchange: (e) => setVal(sp.f, e.target.value) },
          optPairs.map(([v, l]) => h("option", { value: v, selected: val(sp.f) === v }, l)));
        break;
      }
      case "prob": {
        const out = h("output", {}, Math.round(+val(sp.f) * 100) + "%");
        const rng = h("input", { type: "range", min: 5, max: 95, step: 5, value: Math.round(+val(sp.f) * 100),
          "aria-label": sp.label, oninput: (e) => upd(+e.target.value) });
        const upd = (pc) => {
          pc = Math.min(95, Math.max(5, pc));
          rng.value = pc; out.textContent = pc + "%"; setVal(sp.f, (pc / 100).toFixed(2));
        };
        body = h("div", { class: "prob" },
          h("button", { type: "button", "aria-label": "minus 5%", onclick: () => upd(+rng.value - 5) }, "−"),
          rng, out,
          h("button", { type: "button", "aria-label": "plus 5%", onclick: () => upd(+rng.value + 5) }, "+"));
        break;
      }
      case "range": {
        const out = h("output", {}, val(sp.f));
        const rng = h("input", { type: "range", min: sp.min, max: sp.max, step: 1, value: val(sp.f),
          "aria-label": sp.label, oninput: (e) => { setVal(sp.f, e.target.value); out.textContent = e.target.value; } });
        body = h("div", { class: "rangeline" }, rng, out);
        break;
      }
      case "date": {
        const inp = h("input", { type: "date", value: val(sp.f), onchange: (e) => setVal(sp.f, e.target.value) });
        const chips = h("div", { class: "chips" });
        for (const [l, n] of [["today", 0], ["tomorrow", 1], ["+3 days", 3], ["+1 week", 7], ["+1 month", 30]]) {
          const v = dateLocal(addDays(new Date(), n));
          chips.append(h("button", { type: "button", class: val(sp.f) === v ? "on" : "", onclick: (e) => {
            setVal(sp.f, v); inp.value = v;
            chips.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === e.currentTarget));
          } }, l));
        }
        body = h("div", {}, inp, chips);
        break;
      }
      case "flags": {
        body = h("div", { class: "flags" });
        for (const [f, l] of FLAGS) {
          body.append(h("button", { type: "button", class: val(f) === "1" ? "on" : "", "aria-pressed": String(val(f) === "1"),
            onclick: (e) => {
              const on = val(f) !== "1";
              setVal(f, on ? "1" : "0");
              e.currentTarget.classList.toggle("on", on);
              e.currentTarget.setAttribute("aria-pressed", String(on));
            } }, l));
        }
        break;
      }
    }
    const wrap = h("div", { class: "field" }, lab, body);
    wrap._spec = sp;
    fieldEls[sp.f] = wrap;
    return wrap;
  }

  function initForm(type, entry) {
    state.type = type;
    state.form = {};
    state.touched = new Set();
    if (entry) {
      state.form = { ...entry };
    } else {
      for (const sp of [...SPECS[type](), ...MORE()]) {
        if (sp.def !== undefined) state.form[sp.f] = typeof sp.def === "function" ? sp.def() : sp.def;
      }
      for (const [f] of FLAGS) if (type === "incident") state.form[f] = "0";
    }
    renderForm();
  }

  function renderForm() {
    const seg = $("#typeSeg");
    seg.replaceChildren(...TYPES.map((t) => h("button", { type: "button", class: t === state.type ? "on" : "",
      role: "tab", "aria-selected": String(t === state.type), disabled: state.editing && t !== state.type,
      onclick: () => { LS.set("lastType", t); initForm(t); } }, TYPE_LABEL[t])));
    $("#formFields").replaceChildren(...SPECS[state.type]().map(renderField));
    $("#moreFields").replaceChildren(...MORE().map(renderField));
    $("#editBanner").hidden = !state.editing;
    $("#saveBtn").textContent = state.editing ? "Save changes" : `Save ${TYPE_LABEL[state.type].toLowerCase()}`;
    $("#moreBox").open = !!(state.editing && (state.form.note || state.form.tags));
  }

  async function saveForm(ev) {
    ev.preventDefault();
    const specs = SPECS[state.type]();
    let bad = null;
    for (const sp of specs) {
      const miss = sp.req && !String(val(sp.f)).trim() ||
        (sp.f === "mission_id" && /-M$/.test(String(val(sp.f)).trim()));
      fieldEls[sp.f].classList.toggle("invalid", !!miss);
      if (miss && !bad) bad = fieldEls[sp.f];
    }
    if (bad) { bad.scrollIntoView({ behavior: "smooth", block: "center" }); toast("Fill in the marked field"); return; }

    const now = new Date();
    const e = {};
    for (const c of COLUMNS) e[c] = "";
    const keep = state.editing ? { ...state.editing } : {};
    Object.assign(e, keep);
    for (const [k, v] of Object.entries(state.form)) if (COLUMNS.includes(k)) e[k] = String(v ?? "").trim();
    e.type = state.type;
    if (!state.editing) { e.id = newId(now); e.created_at = isoLocal(now); }
    if (!e.chapter) e.chapter = chapter();
    if (e.type === "prediction") {
      if (e.outcome !== "" && !e.resolved_at) e.resolved_at = isoLocal(now);
      if (e.outcome === "") e.resolved_at = "";
    }
    e._updated = isoLocal(now);
    await dbPut(e);
    const i = state.entries.findIndex((x) => x.id === e.id);
    if (i >= 0) state.entries[i] = e; else state.entries.push(e);
    const wasEdit = !!state.editing;
    state.editing = null;
    toast(wasEdit ? "Saved changes" : `${TYPE_LABEL[e.type]} saved`, async () => {
      if (wasEdit) return;
      await dbDel(e.id);
      state.entries = state.entries.filter((x) => x.id !== e.id);
      refresh();
    });
    initForm(state.type);
    refresh();
    if (wasEdit) show("list");
    window.scrollTo({ top: 0 });
  }

  /* ---------- views */
  function show(view) {
    state.view = view;
    document.querySelectorAll(".view").forEach((s) => (s.hidden = s.id !== "view-" + view));
    document.querySelectorAll("#tabbar button").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
    if (view === "list") renderList();
    if (view === "open") renderOpen();
    if (view === "data") renderData();
    if (view === "home") renderHome();
    if (view === "add") {
      renderForm();
      if (!state.editing) {
        const first = $("#formFields textarea, #formFields input[type=text]");
        if (first && state.type === "prediction") setTimeout(() => first.focus(), 50);
      }
    }
  }

  function startAdd(type) { state.editing = null; LS.set("lastType", type); initForm(type); show("add"); }
  function startEdit(e) { state.editing = e; initForm(e.type, e); show("add"); }

  function renderHome() {
    const s = computeStats(state.entries);
    const stat = (v, k, extra = "", alert = false) =>
      h("div", { class: "stat" + (alert ? " alert" : "") }, h("div", { class: "v" }, v), h("div", { class: "k" }, k),
        extra ? h("div", { class: "split" }, extra) : null);
    $("#stats").replaceChildren(
      stat(s.predWeek, "predictions this week"),
      stat(s.open, "open predictions", s.overdue ? `${s.overdue} overdue` : "none overdue", s.overdue > 0),
      stat(s.incWeek, "incidents this week", `burst ${s.incKinds.burst} · near ${s.incKinds.near} · gap ${s.incKinds.gap}`),
      stat(s.streak, s.streak === 1 ? "day drill streak" : "days drill streak"),
    );
    $("#quickButtons").replaceChildren(...TYPES.map((t, i) =>
      h("button", { type: "button", class: i < 2 ? "main" : "", onclick: () => startAdd(t) }, TYPE_LABEL[t])));
    const today = dateLocal();
    const due = openPreds().filter((e) => e.resolve_by && e.resolve_by <= today).slice(0, 5);
    $("#dueList").replaceChildren(...(due.length ? due.map(predCard) : [h("p", { class: "empty" }, "Nothing due today.")]));
    const last = LS.get("lastExport", null);
    const days = last ? Math.floor((Date.now() - Date.parse(last)) / 86400000) : null;
    const nag = $("#backupNag");
    nag.hidden = !(state.entries.length && (days === null || days >= 7));
    nag.textContent = days === null ? "No export yet. Export a CSV backup (Data tab)." :
      `Last export ${days} days ago. Export this week's CSV (Data tab).`;
  }

  function openPreds() {
    return state.entries.filter((e) => e.type === "prediction" && e.outcome === "")
      .sort((a, b) => (a.resolve_by || "9999") < (b.resolve_by || "9999") ? -1 :
        (a.resolve_by || "9999") > (b.resolve_by || "9999") ? 1 : (a.created_at < b.created_at ? -1 : 1));
  }

  function daysBetween(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 86400000); }

  function predCard(e) {
    const today = dateLocal();
    const overdue = e.resolve_by && e.resolve_by < today;
    const when = !e.resolve_by ? "no date" : overdue ? `${daysBetween(e.resolve_by, today)} d overdue` :
      e.resolve_by === today ? "due today" : `by ${e.resolve_by}`;
    return h("div", { class: "card" + (overdue ? " overdue" : "") },
      h("div", { class: "meta" }, h("b", {}, Math.round(+e.probability * 100) + "%"), e.subject || "",
        h("span", { class: "badge" + (overdue ? " overdue" : "") }, when), `ch ${e.chapter}`),
      h("div", { class: "title" }, e.statement),
      h("div", { class: "actions" },
        h("button", { type: "button", class: "btn yes", onclick: () => resolve(e, "1") }, "Happened"),
        h("button", { type: "button", class: "btn no", onclick: () => resolve(e, "0") }, "Didn't")));
  }

  async function resolve(e, outcome) {
    const before = { ...e };
    const now = isoLocal();
    Object.assign(e, { outcome, resolved_at: now, _updated: now });
    await dbPut(e);
    toast(outcome === "1" ? "Resolved: happened" : "Resolved: didn't happen", async () => {
      Object.assign(e, before);
      await dbPut(e);
      refresh();
    });
    refresh();
  }

  function renderOpen() {
    const list = openPreds();
    $("#openList").replaceChildren(...(list.length ? list.map(predCard) :
      [h("p", { class: "empty" }, "No open predictions. Make one: what will someone do today?")]));
  }

  function summary(e) {
    switch (e.type) {
      case "prediction": {
        const res = e.outcome === "1" ? " → happened" : e.outcome === "0" ? " → didn't" : "";
        return `${Math.round(+e.probability * 100)}% ${e.statement}${res}`;
      }
      case "incident": return `${e.kind} · ${e.trigger}${e.who ? " · " + e.who : ""} · intensity ${e.intensity}` +
        (e.body_signal ? ` · ${e.body_signal}` : "");
      case "observation": return `${e.subject}${e.context ? " @ " + e.context : ""}: ${e.cue}` + (e.inference ? ` → ${e.inference}` : "");
      case "mission": return `${e.mission_id} ${e.status}${e.debrief ? ": " + e.debrief : ""}`;
      case "game": return `${e.game}: ${e.result}${e.insight ? " — " + e.insight : ""}`;
      case "drill": return `${e.drill_id} ${e.done === "1" ? "done" : "skipped"}${e.quality ? " · quality " + e.quality : ""}`;
      default: return e.note || "";
    }
  }

  function renderList() {
    const chips = $("#filterChips");
    chips.replaceChildren(...["all", ...TYPES].map((t) => h("button", { type: "button", class: state.filter === t ? "on" : "",
      onclick: () => { state.filter = t; state.listLimit = 50; renderList(); } },
      t === "all" ? `All (${state.entries.length})` : `${TYPE_LABEL[t]} (${state.entries.filter((e) => e.type === t).length})`)));
    const list = state.entries.filter((e) => state.filter === "all" || e.type === state.filter)
      .sort((a, b) => (b.created_at > a.created_at ? 1 : -1));
    const cards = list.slice(0, state.listLimit).map((e) => h("div", { class: "card" },
      h("div", { class: "meta" }, h("span", { class: `badge t-${e.type}` }, e.type),
        String(e.created_at).slice(0, 16).replace("T", " "), `ch ${e.chapter}`, e.tags ? `#${e.tags}` : null),
      h("div", { class: "title" }, summary(e)),
      e.note ? h("div", { class: "meta" }, e.note) : null,
      h("div", { class: "actions" },
        h("button", { type: "button", class: "btn", onclick: () => startEdit(e) }, "Edit"),
        h("button", { type: "button", class: "btn danger", onclick: () => removeEntry(e) }, "Delete"))));
    $("#entryList").replaceChildren(...(cards.length ? cards : [h("p", { class: "empty" }, "No entries yet.")]));
    $("#moreEntries").hidden = list.length <= state.listLimit;
  }

  async function removeEntry(e) {
    if (!confirm(`Delete this ${e.type}?\n\n${summary(e).slice(0, 120)}`)) return;
    await dbDel(e.id);
    state.entries = state.entries.filter((x) => x.id !== e.id);
    toast("Deleted", async () => { await dbPut(e); state.entries.push(e); refresh(); });
    refresh();
  }

  /* ---------- export / import */
  function weeksAvailable() {
    const set = new Set([isoWeek(dateLocal())]);
    for (const e of state.entries) for (const k of ["created_at", "_updated", "resolved_at"]) if (e[k]) set.add(isoWeek(e[k]));
    return [...set].filter(Boolean).sort().reverse();
  }

  function renderData() {
    const sel = $("#weekSelect");
    const cur = sel.value;
    sel.replaceChildren(...weeksAvailable().map((w) => h("option", { value: w },
      `${w} (${entriesForWeek(state.entries, w).length} entries)`)));
    if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
    const last = LS.get("lastExport", null);
    $("#lastExport").textContent = last ? `Last export: ${last.slice(0, 16).replace("T", " ")}` : "Never exported.";
    const canShare = !!(navigator.canShare && navigator.canShare({ files: [new File(["x"], "x.csv", { type: "text/csv" })] }));
    $("#shareWeek").hidden = $("#shareAll").hidden = !canShare;
    $("#storageInfo").textContent = `${state.entries.length} entries stored.`;
    if (navigator.storage && navigator.storage.persisted) {
      navigator.storage.persisted().then((p) => {
        $("#storageInfo").textContent = `${state.entries.length} entries stored. ` +
          (p ? "Storage is persistent (the browser will not evict it)." : "Storage is not yet persistent; install the app to the home screen.");
      });
    }
  }

  function csvFile(which) {
    const now = dateLocal();
    if (which === "all") {
      const list = [...state.entries].sort((a, b) => (a.created_at > b.created_at ? 1 : -1));
      return new File([toCSV(list)], `all-entries-${now}.csv`, { type: "text/csv;charset=utf-8" });
    }
    const w = $("#weekSelect").value || isoWeek(now);
    const list = entriesForWeek(state.entries, w).sort((a, b) => (a.created_at > b.created_at ? 1 : -1));
    return new File([toCSV(list)], `${w}.csv`, { type: "text/csv;charset=utf-8" });
  }

  function download(which) {
    const f = csvFile(which);
    const url = URL.createObjectURL(f);
    const a = h("a", { href: url, download: f.name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    LS.set("lastExport", isoLocal());
    toast(`Exported ${f.name}`);
    renderData();
  }

  async function share(which) {
    const f = csvFile(which);
    try {
      await navigator.share({ files: [f], title: f.name });
      LS.set("lastExport", isoLocal());
      renderData();
    } catch (err) { if (err && err.name !== "AbortError") toast("Share failed: " + err.message); }
  }

  async function importCSV(file) {
    const text = await file.text();
    let rows;
    try { rows = csvToEntries(text); } catch (err) { $("#importResult").textContent = "Could not read CSV: " + err.message; return; }
    const byId = new Map(state.entries.map((e) => [e.id, e]));
    const counts = { added: 0, updated: 0, unchanged: 0, kept: 0 };
    const toWrite = [];
    for (const inc of rows) {
      if (!TYPES.includes(inc.type)) continue;
      const { result, action } = mergeEntry(byId.get(inc.id), inc);
      counts[action]++;
      if (action === "added" || action === "updated") {
        result._updated = result._updated || result.resolved_at || result.created_at;
        byId.set(result.id, result); toWrite.push(result);
      }
    }
    await dbPutMany(toWrite);
    state.entries = [...byId.values()];
    $("#importResult").textContent = `${file.name}: ${rows.length} rows. Added ${counts.added}, updated ${counts.updated}, ` +
      `unchanged ${counts.unchanged}, kept newer local ${counts.kept}.`;
    refresh();
  }

  /* ---------- toast */
  let toastTimer;
  function toast(msg, undo) {
    const t = $("#toast");
    $("#toastMsg").textContent = msg;
    const u = $("#toastUndo");
    u.hidden = !undo;
    u.onclick = async () => { t.hidden = true; if (undo) await undo(); };
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), undo ? 5000 : 2500);
  }

  function refresh() {
    const s = computeStats(state.entries);
    const c = $("#openCount");
    c.textContent = s.open || "";
    c.classList.toggle("alert", s.overdue > 0);
    if (state.view === "home") renderHome();
    if (state.view === "open") renderOpen();
    if (state.view === "list") renderList();
    if (state.view === "data") renderData();
  }

  /* ---------- boot */
  async function boot() {
    const sel = $("#chapterSelect");
    sel.replaceChildren(...CHAPTERS.map(([id, t]) => h("option", { value: id }, `Ch ${id} · ${t}`)));
    sel.value = chapter();
    sel.addEventListener("change", () => { LS.set("chapter", sel.value); if (!state.editing) initForm(state.type); toast(`Chapter ${sel.value}`); });

    // switching tabs keeps a half-filled form; it is reset after Save
    document.querySelectorAll("#tabbar button").forEach((b) => b.addEventListener("click", () => show(b.dataset.view)));
    $("#entryForm").addEventListener("submit", saveForm);
    $("#cancelEdit").addEventListener("click", () => { state.editing = null; initForm(state.type); show("list"); });
    $("#moreEntries").addEventListener("click", () => { state.listLimit += 50; renderList(); });
    $("#exportWeek").addEventListener("click", () => download("week"));
    $("#exportAll").addEventListener("click", () => download("all"));
    $("#shareWeek").addEventListener("click", () => share("week"));
    $("#shareAll").addEventListener("click", () => share("all"));
    $("#importFile").addEventListener("change", (e) => { if (e.target.files[0]) importCSV(e.target.files[0]); e.target.value = ""; });

    // render immediately (empty), then fill in once IndexedDB has loaded
    if (!TYPES.includes(state.type)) state.type = "prediction";
    initForm(state.type);
    const hash = location.hash.replace("#", "");
    if (TYPES.includes(hash)) startAdd(hash); else show("home");
    try {
      state.entries = await dbAll();
    } catch (err) {
      document.body.prepend(h("div", { class: "nag" }, "Storage unavailable: " + (err && err.message) +
        ". Private browsing can block IndexedDB; open the app normally."));
    }
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    if (state.view === "add" && !state.editing) renderForm(); // recent codenames/tags chips
    refresh();

    if ("serviceWorker" in navigator && location.protocol !== "file:") {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  }
  boot();
})();
