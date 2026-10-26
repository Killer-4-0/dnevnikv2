"use strict";


/* ================= ХРАНИЛИЩЕ ================= */
const STORAGE_KEY = "healthDiary.v2";
const OLD_KEY = "healthDiary.v1";
let ACCOUNT_KEY = null; // uid вошедшего пользователя (данные хранятся отдельно)

const DEFAULT_SETTINGS = {
  goalCal: 0, goalP: 0, goalF: 0, goalC: 0, waterGoal: 2000,
  goalWeight: null,
  mealNames: ["Завтрак", "Обед", "Ужин", "Перекус"],
  geminiKey: "", aiModel: "gemini-2.5-flash",
  firebaseConfig: "", autoSync: true,
  restSec: 90,       // отдых между подходами по умолчанию, сек
  restAuto: true     // автозапуск таймера после записи подхода
};

function defaultData() {
  return {
    foods: [], weights: [], workouts: [],
    water: {},           // дата -> мл
    customFoods: [],
    plans: [],
    mealPlan: {},        // дата -> [{id, meal, name, grams, cal, p, f, c}]
    settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
    updatedAt: 0
  };
}

function migrateOld() {
  try {
    const old = JSON.parse(store.getItem(OLD_KEY) || "null");
    if (!old) return null;
    const d = defaultData();
    (old.foods || []).forEach(f => d.foods.push({
      id: f.id || uid(), date: f.date, meal: f.meal || "Обед",
      name: f.name || "Без названия", grams: null,
      cal: num(f.calories), p: num(f.protein), f: num(f.fat), c: num(f.carbs)
    }));
    (old.weights || []).forEach(w => d.weights.push({ id: w.id || uid(), date: w.date, kg: Number(w.kg), createdAt: w.createdAt || Date.now() }));
    (old.workouts || []).forEach(w => d.workouts.push({ id: w.id || uid(), date: w.date, name: w.name, minutes: num(w.minutes), cal: num(w.calories), details: w.details || "" }));
    return d;
  } catch { return null; }
}

function normalizeWater(w) {
  const out = {};
  for (const [d, v] of Object.entries(w || {})) {
    if (v && typeof v === "object") out[d] = { ml: +v.ml || 0, u: +v.u || 0 };
    else if (+v) out[d] = { ml: +v, u: 0 };
  }
  return out;
}
function loadData() {
  try {
    const raw = store.getItem(ACCOUNT_KEY || STORAGE_KEY);
    if (raw) {
      const d = Object.assign(defaultData(), JSON.parse(raw));
      d.settings = Object.assign(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), d.settings || {});
      d.del = d.del || {};
      d.water = normalizeWater(d.water);
      // миграция: старый ключ OpenAI, если это ключ Gemini (AIza...)
      if (!d.settings.geminiKey && d.settings.openaiKey && /^AIza/.test(d.settings.openaiKey)) d.settings.geminiKey = d.settings.openaiKey;
      return d;
    }
    const migrated = migrateOld();
    if (migrated) return migrated;
    return defaultData();
  } catch { return defaultData(); }
}

let data = loadData();
let selectedDate = todayStr();
let currentTab = "diary";
let pendingSaveSync = null;

/* ================= ТАЙМЕР ОТДЫХА ================= */
let rest = { timer: null, endsAt: 0, total: 0, remaining: 0, running: false };

function restFmt(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const m = Math.floor(sec / 60), s = sec % 60;
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}
function restReadSec() {
  const sel = $("#restDur"), custom = $("#restCustom");
  let sec = sel ? +sel.value : 0;
  if (sel && sel.value === "custom" && custom) sec = num(custom.value);
  if (!Number.isFinite(sec) || sec <= 0) sec = num(data.settings.restSec) || 90;
  return Math.min(3600, Math.max(5, Math.round(sec)));
}
function restDraw() {
  const el = $("#restTime");
  if (!el) return;
  const left = rest.running ? Math.max(0, Math.ceil((rest.endsAt - Date.now()) / 1000)) : rest.remaining;
  el.textContent = restFmt(left);
  const b = $("#restToggleBtn");
  if (b) b.textContent = rest.running ? "Пауза" : (rest.remaining > 0 && rest.remaining < rest.total ? "Продолжить" : "Старт");
}
function restDoneNotify() {
  try { navigator.vibrate && navigator.vibrate([180, 80, 180, 80, 260]); } catch {}
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 880;
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0.001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.8);
    o.start(t); o.stop(t + 0.85);
  } catch {}
  toast("Отдых окончен — можно следующий подход");
}
function restTick() {
  const left = Math.ceil((rest.endsAt - Date.now()) / 1000);
  if (left <= 0) {
    clearInterval(rest.timer); rest.timer = null;
    rest.running = false; rest.remaining = 0;
    restDraw(); restDoneNotify();
  } else restDraw();
}
function restStart(sec) {
  clearInterval(rest.timer);
  sec = Math.min(3600, Math.max(5, Math.round(sec || 90)));
  data.settings.restSec = sec;
  rest.total = sec; rest.remaining = sec;
  rest.endsAt = Date.now() + sec * 1000;
  rest.running = true;
  rest.timer = setInterval(restTick, 250);
  persist();
  restDraw();
}
function restToggle() {
  if (rest.running) {
    rest.remaining = Math.max(0, Math.ceil((rest.endsAt - Date.now()) / 1000));
    rest.running = false;
    clearInterval(rest.timer); rest.timer = null;
    restDraw();
    return;
  }
  if (!rest.remaining) rest.remaining = restReadSec();
  if (!rest.total) rest.total = rest.remaining;
  rest.endsAt = Date.now() + rest.remaining * 1000;
  rest.running = true;
  rest.timer = setInterval(restTick, 250);
  restDraw();
}
function restReset() {
  clearInterval(rest.timer); rest.timer = null;
  rest.running = false;
  const sec = $("#restTime") ? restReadSec() : (num(data.settings.restSec) || 90);
  rest.total = sec; rest.remaining = sec;
  restDraw();
}

function persist() {
  data.updatedAt = Date.now();
  try { store.setItem(ACCOUNT_KEY || STORAGE_KEY, JSON.stringify(data)); } catch (e) { toast("Не удалось сохранить данные (память браузера заполнена?)", true); }
  scheduleAutoSync();
}
// пометка записи времени изменения (для корректного слияния устройств)
function touch(rec) { rec.u = Date.now(); return rec; }
// «могильные камни» удалённых записей — чтобы удаления синхронизировались
function tombstone(id) {
  data.del = data.del || {};
  data.del[id] = Date.now();
}
function purgeTombstones() {
  if (!data.del) return;
  const cutoff = Date.now() - 90 * 86400000;
  for (const k of Object.keys(data.del)) if (data.del[k] < cutoff) delete data.del[k];
}

/* ================= ХЕЛПЕРЫ ================= */
function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
}
function num(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; }
function fmtNum(v) {
  const r = Math.round(v * 10) / 10;
  return (Number.isInteger(r) ? String(r) : r.toFixed(1)).replace(".", ",");
}
const ENT_AMP = String.fromCharCode(38);
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, ENT_AMP + "amp;")
    .replace(/</g, ENT_AMP + "lt;")
    .replace(/>/g, ENT_AMP + "gt;")
    .replace(/"/g, ENT_AMP + "quot;")
    .replace(/'/g, String.fromCharCode(39));
}
function todayStr() {
  const d = new Date(), off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}
function shiftDate(iso, days) {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + days);
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}
function fmtDateRu(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"][m - 1]} ${y}`;
}
function fmtDateShort(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}`;
}
function fmtDateFullShort(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}.${y}`;
}
function plural(n, one, few, many) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}
function toast(msg, isErr) {
  const root = $("#toast-root");
  const el = document.createElement("div");
  el.className = "toast" + (isErr ? " err" : "");
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .4s"; }, 2600);
  setTimeout(() => el.remove(), 3100);
}
function sum(arr, key) { return arr.reduce((s, x) => s + num(x[key]), 0); }
function macroCal(p, f, c) { return Math.round(4 * num(p) + 9 * num(f) + 4 * num(c)); }
function round1(v) { return Math.round(v * 10) / 10; }
function normExName(s) { return String(s == null ? "" : s).toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim(); }
function workoutExercises(w) { return Array.isArray(w && w.exercises) ? w.exercises : []; }
function sortedWorkouts() { return [...data.workouts].sort((a, b) => b.date.localeCompare(a.date) || (b.startedAt || 0) - (a.startedAt || 0)); }
function fmtSet(s) {
  const w = s && (s.weight == null || s.weight === "") ? null : num(s.weight);
  let reps = s && s.reps != null ? String(s.reps) : "";
  if (s && s.toFailure) reps = "до отказа";
  return w ? `${fmtNum(w)} кг × ${reps}` : (reps || "—");
}
function setsLine(sets) { return (sets || []).map(fmtSet).join(" · "); }
// последний раз, когда делали это упражнение (до текущей тренировки w) — берём только записи с подходами
function lastSetsFor(exName, w) {
  const n = normExName(exName);
  if (!n) return null;
  const hasSets = x => {
    const ex = workoutExercises(x).find(e => normExName(e.name) === n);
    return ex && ex.sets && ex.sets.length ? ex : null;
  };
  const cands = data.workouts.filter(x =>
    x.id !== w.id && hasSets(x) &&
    (x.date < w.date || (x.date === w.date && (x.startedAt || 0) < (w.startedAt || Date.now())))
  ).sort((a, b) => b.date.localeCompare(a.date) || (b.startedAt || 0) - (a.startedAt || 0));
  const prev = cands[0];
  if (!prev) return null;
  const ex = hasSets(prev);
  return { date: prev.date, sets: ex.sets };
}
function workoutBodyHtml(w) {
  const exs = workoutExercises(w);
  if (exs.length) return exs.map(e => `<div class="item" style="cursor:default"><div class="item-main"><div class="name" style="font-weight:600;font-size:14.5px">${esc(e.name)}</div><small>${esc(setsLine(e.sets)) || "подходы не записаны"}</small></div></div>`).join("");
  if (w.details) return `<div class="workout-details" style="margin-top:8px;padding:10px;background:var(--panel-2);border:1px solid var(--border);border-radius:10px;white-space:pre-line;font-size:14px">${esc(w.details)}</div>`;
  return "";
}

/* ================= МОДАЛКИ ================= */
function openModal(html, opts) {
  opts = opts || {};
  const root = $("#modal-root");
  root.innerHTML = `<div class="modal-overlay${opts.center ? " center" : ""}"><div class="modal">${html}</div></div>`;
  const overlay = $(".modal-overlay", root);
  overlay.addEventListener("click", e => { if (e.target === overlay) closeModal(); });
  document.body.style.overflow = "hidden";
  return root;
}
function closeModal() {
  $("#modal-root").innerHTML = "";
  document.body.style.overflow = "";
  stopBarcodeScan();
}

/* ================= РЕНДЕР ОСНОВНОЙ ================= */
function switchTab(tab) {
  currentTab = tab;
  $$(".view").forEach(v => v.classList.remove("active"));
  $("#view-" + tab).classList.add("active");
  $$(".tabbar button").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  const subs = { diary: "Питание · КБЖУ · Вода", workouts: "Тренировки и планы", progress: "Графики и прогноз", mealplan: "Планирование рациона", settings: "Настройки и синхронизация", api: "Проверка API ключа" };
  $("#headerSub").textContent = subs[tab] || "";
  renderAll();
  window.scrollTo({ top: 0 });
}

function renderAll() {
  renderDiary();
  renderWorkouts();
  renderProgress();
  renderMealPlan();
  renderSettings();
}

function refresh() { persist(); renderAll(); }

/* ================= ДНЕВНИК ================= */
function foodsFor(date) { return data.foods.filter(f => f.date === date); }

function renderDiary() {
  const day = selectedDate;
  const foods = foodsFor(day);
  const cal = sum(foods, "cal"), p = sum(foods, "p"), f = sum(foods, "f"), c = sum(foods, "c");
  const s = data.settings;
  const goalCal = num(s.goalCal);

  // карточки-сводка
  let calSub = "";
  if (goalCal) {
    const pct = Math.min(100, Math.round(cal / goalCal * 100));
    calSub = `${Math.round(cal)} / ${goalCal} ккал · ${pct}%`;
  } else calSub = "задай цель в настройках";
  const pctBar = goalCal ? Math.min(100, Math.round(cal / goalCal * 100)) : 0;
  $("#summaryCards").innerHTML = `
    <div class="card accent"><span>Калории за день</span><strong>${Math.round(cal)} ккал</strong>
      <div class="progress-wrap"><div class="progress-bar${goalCal && cal > goalCal ? " over" : ""}" style="width:${pctBar}%"></div></div>
      <small>${calSub}</small></div>
    <div class="card"><span>Белки</span><strong>${fmtNum(p)} г</strong><small>${s.goalP ? "цель " + fmtNum(s.goalP) + " г" : ""}</small></div>
    <div class="card"><span>Жиры</span><strong>${fmtNum(f)} г</strong><small>${s.goalF ? "цель " + fmtNum(s.goalF) + " г" : ""}</small></div>
    <div class="card"><span>Углеводы</span><strong>${fmtNum(c)} г</strong><small>${s.goalC ? "цель " + fmtNum(s.goalC) + " г" : ""}</small></div>
    <div class="card"><span>Вода</span><strong>${(data.water[day] ? data.water[day].ml : 0)} мл</strong><small>${s.waterGoal ? "цель " + s.waterGoal + " мл" : ""}</small></div>`;

  $("#dateInput").value = day;

  // вода
  const water = (data.water[day] ? data.water[day].ml : 0);
  const waterGoal = num(s.waterGoal) || 2000;
  $("#waterPanel").innerHTML = `
    <div class="water-card">
      <div><div class="water-num">${water} мл</div><div class="water-sub">из ${waterGoal} мл (${Math.round(water / waterGoal * 100)}%)</div></div>
      <div class="water-buttons">
        <button class="small ghost" data-action="waterAdd" data-ml="250">+250</button>
        <button class="small ghost" data-action="waterAdd" data-ml="500">+500</button>
        <button class="small ghost" data-action="waterAdd" data-ml="-250">−250</button>
      </div>
    </div>
    <div class="progress-wrap"><div class="progress-bar" style="width:${Math.min(100, Math.round(water / waterGoal * 100))}%"></div></div>`;

  // приёмы пищи
  const names = s.mealNames.length ? s.mealNames : ["Завтрак", "Обед", "Ужин", "Перекус"];
  $("#mealSections").innerHTML = names.map(meal => {
    const items = foods.filter(x => x.meal === meal);
    const mCal = sum(items, "cal");
    return `<div class="meal-block">
      <div class="meal-head"><b>${esc(meal)}</b><span class="meal-kcal">${Math.round(mCal)} ккал</span></div>
      <div class="meal-body">
        ${items.length ? items.map(item => `
          <div class="item">
            <div class="item-main" data-action="editFood" data-id="${item.id}">
              <div class="name">${esc(item.name)}</div>
              <small>${item.grams ? item.grams + " г · " : ""}Б: ${fmtNum(item.p)} · Ж: ${fmtNum(item.f)} · У: ${fmtNum(item.c)}</small>
            </div>
            <div class="item-right"><span class="kcal">${Math.round(num(item.cal))} ккал</span>
              <button class="icon-btn" data-action="delFood" data-id="${item.id}">✕</button></div>
          </div>`).join("") : `<div class="empty">Пока ничего не записано.</div>`}
        <div class="meal-actions">
          <button class="small primary" data-action="addFood" data-meal="${esc(meal)}">＋ Добавить еду</button>
          ${items.length ? `<button class="small ghost" data-action="saveMealAsDish" data-meal="${esc(meal)}">💾 Сохранить как блюдо</button>` : ""}
        </div>
      </div>
    </div>`;
  }).join("");

  const latest = [...data.weights].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt)[0];
  $("#lastWeightInline").textContent = latest ? latest.kg.toFixed(1) + " кг (" + fmtDateShort(latest.date) + ")" : "нет записей";
}

/* ---------- Поиск еды ---------- */
let foodSearchCtx = { meal: "Обед", target: "diary" }; // target: diary | plan

function openFoodSearch(meal, target) {
  foodSearchCtx = { meal: meal || (data.settings.mealNames[0] || "Обед"), target: target || "diary" };
  renderFoodSearch("search");
}

function renderFoodSearch(tab) {
  const names = data.settings.mealNames.length ? data.settings.mealNames : ["Завтрак", "Обед", "Ужин", "Перекус"];
  const mealSel = names.map(n => `<option${n === foodSearchCtx.meal ? " selected" : ""}>${esc(n)}</option>`).join("");
  const html = `
    <div class="modal-head"><h3>Добавить еду</h3><button class="close-x" data-action="closeModal">✕</button></div>
    <div class="modal-tabs">
      <button data-stab="search" class="${tab === "search" ? "active" : ""}">Поиск</button>
      <button data-stab="custom" class="${tab === "custom" ? "active" : ""}">Мои блюда</button>
      <button data-stab="barcode" class="${tab === "barcode" ? "active" : ""}">Штрихкод</button>
      <button data-stab="photo" class="${tab === "photo" ? "active" : ""}">Фото</button>
    </div>
    <div id="foodSearchBody"></div>`;
  openModal(html);
  $$("#modal-root .modal-tabs button").forEach(b => b.addEventListener("click", () => renderFoodSearch(b.dataset.stab)));

  const body = $("#foodSearchBody");

  if (tab === "search") {
    body.innerHTML = `
      <div class="search-row"><input id="foodQuery" placeholder="Например: гречка, творог, шаурма…" autocomplete="off"><button data-action="manualEntry">Вручную</button></div>
      <div class="hint" id="searchHint">Встроенная база (${FOOD_DB.length} продуктов) + Open Food Facts. Поиск по базе работает даже без интернета. Значения усреднённые, справочные.</div>
      <div id="foodResults"></div>`;
    const input = $("#foodQuery");
    let deb = null;
    input.addEventListener("input", () => {
      clearTimeout(deb);
      deb = setTimeout(() => runFoodSearch(input.value.trim()), 350);
    });
    input.focus();
    runFoodSearch("");
  }

  if (tab === "custom") {
    renderCustomTab(body);
  }

  if (tab === "barcode") {
    body.innerHTML = `
      <label class="field">Штрихкод (введите вручную или отсканируйте)<input id="barcodeInput" inputmode="numeric" placeholder="Например: 4690228013307" autocomplete="off"></label>
      <div class="btn-row">
        <button data-action="lookupBarcode">Найти продукт</button>
        <button class="ghost" data-action="startScan">Сканировать камерой</button>
      </div>
      <div id="scanArea" style="margin-top:12px"></div>
      <div id="barcodeResult"></div>
      <div class="hint">База Open Food Facts: миллионы упакованных продуктов. Если продукт не найден — добавьте его вручную во вкладке «Поиск».</div>`;
    $("#barcodeInput").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); doBarcodeLookup($("#barcodeInput").value.trim()); } });
  }

  if (tab === "photo") {
    body.innerHTML = `
      <p class="hint" style="margin:0 0 10px">Сфотографируйте тарелку — ИИ определит блюда, вес и КБЖУ. Перед сохранением всё можно поправить.</p>
      <input type="file" id="photoFile" accept="image/*" capture="environment" hidden>
      <img id="photoPreview" class="photo-preview" alt="">
      <div class="btn-row" style="margin-top:0">
        <button data-action="pickPhoto">Выбрать / снять фото</button>
        <button class="primary" data-action="recognizePhoto" disabled>Распознать</button>
      </div>
      <div id="photoResult"></div>
      <div class="hint">Требуется ключ OpenAI (Настройки → Распознавание еды по фото). Ключ хранится только на вашем устройстве.</div>`;
    $("#photoFile").addEventListener("change", e => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        $("#photoPreview").src = reader.result;
        $("#photoPreview").style.display = "block";
        $("#photoPreview").dataset.dataurl = reader.result;
        $("[data-action=recognizePhoto]").disabled = false;
      };
      reader.readAsDataURL(file);
    });
  }
}

function localFoodResults(q) {
  const norm = q.toLowerCase().replace(/ё/g, "е");
  if (!norm) return FOOD_DB.slice(0, 30);
  return FOOD_DB.filter(x => {
    const n = x.name.toLowerCase().replace(/ё/g, "е");
    return n.includes(norm) || norm.includes(n);
  }).slice(0, 40);
}

async function runFoodSearch(q) {
  const local = localFoodResults(q);
  const custom = q ? data.customFoods.filter(x => x.name.toLowerCase().includes(q.toLowerCase())) : data.customFoods;
  const res = $("#foodResults");
  const renderRows = (offItems, offlineNote) => `
    ${custom.length ? custom.map(c => resultRow({ name: c.name, cal: c.cal, p: c.p, f: c.f, c: c.c, source: "custom", id: c.id })).join("") : ""}
    ${local.map(x => resultRow({ name: x.name, cal: x.cal, p: x.p, f: x.f, c: x.c, source: "db", piece: x.piece })).join("")}
    ${offItems.map(x => resultRow(x)).join("")}
    ${offlineNote ? `<div class="hint">${offlineNote}</div>` : ""}`;

  if (!q) { res.innerHTML = renderRows([]); return; }

  res.innerHTML = renderRows([], `<div id="offLoading">Ищем в Open Food Facts…</div>`);
  if (!navigator.onLine) {
    res.innerHTML = renderRows([], "Нет интернета — показаны только встроенные продукты.");
    return;
  }
  try {
    const off = await offSearch(q);
    const el = $("#offLoading"); if (el) el.remove();
    res.insertAdjacentHTML("beforeend", off.map(x => resultRow(x)).join(""));
    if (!off.length) res.insertAdjacentHTML("beforeend", `<div class="hint">В Open Food Facts ничего не нашлось.</div>`);
  } catch {
    const el = $("#offLoading"); if (el) el.remove();
    res.insertAdjacentHTML("beforeend", `<div class="hint">Open Food Facts недоступен (нет сети?).</div>`);
  }
}

function resultRow(x) {
  const md = v => v == null ? "н/д" : fmtNum(v);
  const sub = `${Math.round(num(x.cal))} ккал/100г · Б${md(x.p)} Ж${md(x.f)} У${md(x.c)}`;
  const badge = x.source === "off" ? `<span class="badge off">база OFF</span>` : x.source === "custom" ? `<span class="badge custom">моё</span>` : "";
  return `<div class="result-item" data-action="pickFood" data-json="${esc(JSON.stringify({ name: x.name, cal: x.cal, p: x.p, f: x.f, c: x.c, piece: x.piece || null }))}">
    <div class="ri-main"><div class="ri-name">${esc(x.name)}${badge}</div><div class="ri-sub">${sub}</div></div>
    <span class="ri-kcal">→</span></div>`;
}

function openPortionEditor(item) {
  const names = data.settings.mealNames.length ? data.settings.mealNames : ["Завтрак", "Обед", "Ужин", "Перекус"];
  const mealSel = names.map(n => `<option${n === foodSearchCtx.meal ? " selected" : ""}>${esc(n)}</option>`).join("");
  const chips = [50, 100, 150, 200, 300].map(g => `<button data-grams="${g}">${g} г</button>`).join("");
  const pieceChip = item.piece ? `<button data-grams="${item.piece}">1 шт (${item.piece} г)</button>` : "";
  openModal(`
    <div class="modal-head"><h3>${esc(item.name)}</h3><button class="close-x" data-action="backToSearch">✕</button></div>
    <div class="hint" style="margin:0 0 6px">На 100 г: ${Math.round(num(item.cal))} ккал · Б ${item.p == null ? "н/д" : fmtNum(item.p)} · Ж ${item.f == null ? "н/д" : fmtNum(item.f)} · У ${item.c == null ? "н/д" : fmtNum(item.c)}</div>
    <label class="field">Сколько грамм (или порций в граммах)<input type="number" id="portionGrams" value="100" min="1" step="1"></label>
    <div class="chips">${chips}${pieceChip}</div>
    <div class="macro-grid">
      <div class="card"><span>Ккал</span><strong id="pvCal">—</strong></div>
      <div class="card"><span>Белки</span><strong id="pvP">—</strong></div>
      <div class="card"><span>Жиры</span><strong id="pvF">—</strong></div>
      <div class="card"><span>Углеводы</span><strong id="pvC">—</strong></div>
    </div>
    <label class="field">Приём пищи<select id="portionMeal">${mealSel}</select></label>
    <div class="btn-row"><button data-action="confirmPortion" data-item="${esc(JSON.stringify(item))}">Добавить в дневник</button></div>
  `, { center: true });

  const upd = () => {
    const g = num($("#portionGrams").value) || 0;
    const k = g / 100;
    $("#pvCal").textContent = Math.round(num(item.cal) * k);
    $("#pvP").textContent = fmtNum(num(item.p) * k) + " г";
    $("#pvF").textContent = fmtNum(num(item.f) * k) + " г";
    $("#pvC").textContent = fmtNum(num(item.c) * k) + " г";
  };
  $("#portionGrams").addEventListener("input", upd);
  $$(".chips button").forEach(b => b.addEventListener("click", () => { $("#portionGrams").value = b.dataset.grams; upd(); }));
  upd();
}

function confirmPortion(item) {
  const grams = num($("#portionGrams").value);
  if (!grams) { toast("Укажите граммы", true); return; }
  const meal = $("#portionMeal").value;
  const k = grams / 100;
  const entry = touch({
    id: uid(), date: selectedDate, meal, name: item.name,
    grams, cal: Math.round(num(item.cal) * k), p: +num(item.p) * k, f: +num(item.f) * k, c: +num(item.c) * k
  });
  entry.p = Math.round(entry.p * 10) / 10; entry.f = Math.round(entry.f * 10) / 10; entry.c = Math.round(entry.c * 10) / 10;
  if (foodSearchCtx.target === "plan") {
    (data.mealPlan[selectedDate] = data.mealPlan[selectedDate] || []).push(entry);
    toast("Добавлено в план питания");
  } else {
    data.foods.push(entry);
    toast(`Добавлено: ${item.name} (${grams} г)`);
  }
  closeModal();
  refresh();
}

function renderCustomTab(body) {
  body.innerHTML = `
    <p class="hint" style="margin:0 0 10px">Свои блюда и рецепты: сохраните КБЖУ на 100 г один раз — потом ищите и добавляйте в один тап. «Из ингредиентов» собирает блюдо целиком (например, пиццу) и считает КБЖУ всей пиццы и на 100 г.</p>
    <div class="btn-row" style="margin-top:0">
      <button class="ghost" data-action="newCustomFood">＋ Новое блюдо</button>
      <button class="ghost" data-action="newRecipe">Из ингредиентов</button>
    </div>
    <div id="customList"></div>`;
  renderCustomList();
}

function renderCustomList() {
  const el = $("#customList");
  if (!el) return;
  el.innerHTML = data.customFoods.length ? data.customFoods.map(c => `
    <div class="result-item" data-action="pickFood" data-json="${esc(JSON.stringify({ name: c.name, cal: c.cal, p: c.p, f: c.f, c: c.c }))}">
      <div class="ri-main"><div class="ri-name">${esc(c.name)}<span class="badge custom">моё</span>${c.recipe ? `<span class="badge">рецепт</span>` : ""}</div>
      <div class="ri-sub">${Math.round(num(c.cal))} ккал/100г · Б${fmtNum(c.p)} Ж${fmtNum(c.f)} У${fmtNum(c.c)}${c.recipe ? ` · всего ${c.recipe.finishedGrams} г` : ""}</div></div>
      <div class="ri-actions">
        ${c.recipe ? `<button class="small ghost" data-action="editRecipe" data-id="${c.id}">Рецепт</button>` : `<button class="small ghost" data-action="editCustomFood" data-id="${c.id}">КБЖУ</button>`}
        <button class="small danger" data-action="delCustomFood" data-id="${c.id}">Удалить</button>
        <span class="ri-kcal">→</span>
      </div>
    </div>`).join("") : `<div class="empty">Пока нет своих блюд.</div>`;
}

function newCustomFood(existing) {
  openModal(`
    <div class="modal-head"><h3>${existing ? "Изменить блюдо" : "Новое блюдо"}</h3><button class="close-x" data-action="closeModal">✕</button></div>
    <label class="field">Название<input id="cfName" value="${esc(existing ? existing.name : "")}" placeholder="Например: бабушкин борщ"></label>
    <div class="field-grid-3">
      <label class="field">Белки<input id="cfP" type="number" min="0" step="0.1" value="${existing ? existing.p : ""}"></label>
      <label class="field">Жиры<input id="cfF" type="number" min="0" step="0.1" value="${existing ? existing.f : ""}"></label>
      <label class="field">Углеводы<input id="cfC" type="number" min="0" step="0.1" value="${existing ? existing.c : ""}"></label>
      <label class="field">Ккал/100г<input id="cfCal" type="number" min="0" step="1" value="${existing ? existing.cal : ""}"></label>
    </div>
    <label class="autocal-chk"><input type="checkbox" id="cfAutoCal" ${existing && num(existing.cal) && num(existing.cal) !== macroCal(existing.p, existing.f, existing.c) ? "" : "checked"}> Считать калории по БЖУ (4·Б + 4·У + 9·Ж)</label>
    <div class="btn-row"><button data-action="saveCustomFood" data-id="${existing ? existing.id : ""}">Сохранить</button></div>
  `, { center: true });
  bindAutoCal("cfCal", "cfP", "cfF", "cfC", "cfAutoCal");
}

// автоподсчёт калорий по БЖУ в модалке
function bindAutoCal(calId, pId, fId, cId, chkId) {
  const cal = $("#" + calId), chk = $("#" + chkId);
  const recalc = () => { if (!chk || chk.checked) cal.value = macroCal($("#" + pId).value, $("#" + fId).value, $("#" + cId).value); };
  [pId, fId, cId].forEach(id => $("#" + id).addEventListener("input", recalc));
  if (chk) {
    chk.addEventListener("change", () => { cal.readOnly = chk.checked; recalc(); if (!chk.checked) cal.focus(); });
    cal.readOnly = chk.checked;
  }
}

function saveCustomFood(id) {
  const name = $("#cfName").value.trim();
  if (!name) { toast("Укажите название", true); return; }
  const cf = touch({ id: id || uid(), name, cal: num($("#cfCal").value), p: num($("#cfP").value), f: num($("#cfF").value), c: num($("#cfC").value) });
  if (id) data.customFoods = data.customFoods.map(x => x.id === id ? cf : x);
  else data.customFoods.push(cf);
  closeModal();
  refresh();
  renderFoodSearch("custom");
  toast("Блюдо сохранено");
}

function saveMealAsDish(meal) {
  const items = foodsFor(selectedDate).filter(x => x.meal === meal);
  if (!items.length) return;
  const cal = sum(items, "cal"), p = sum(items, "p"), f = sum(items, "f"), c = sum(items, "c");
  const knownGrams = items.reduce((s, x) => s + num(x.grams), 0);
  const name = prompt("Название блюда:", `${meal} (${fmtDateShort(selectedDate)})`);
  if (!name) return;
  const grams = num(prompt("Общий вес готового блюда, г:", knownGrams ? String(Math.round(knownGrams)) : "300"));
  if (!grams) { toast("Без веса блюда нельзя посчитать КБЖУ на 100 г", true); return; }
  const k = 100 / grams;
  data.customFoods.push(touch({ id: uid(), name, cal: Math.round(cal * k), p: Math.round(p * k * 10) / 10, f: Math.round(f * k * 10) / 10, c: Math.round(c * k * 10) / 10 }));
  refresh();
  toast(`«${name}» сохранено в «Мои блюда»`);
}

/* ---------- Open Food Facts ---------- */
async function offSearch(q) {
  const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=20&fields=code,product_name,brands,nutriments`;
  const r = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!r.ok) throw new Error("off");
  const j = await r.json();
  const out = [];
  (j.products || []).forEach(p => {
    const n = p.nutriments || {};
    const kcal = n["energy-kcal_100g"] != null ? n["energy-kcal_100g"] : (n.energy_100g ? n.energy_100g / 4.184 : null);
    if (!p.product_name || kcal == null) return;
    const name = p.brands ? `${p.product_name} (${String(p.brands).split(",")[0].trim()})` : p.product_name;
    const nz = v => v == null ? null : +v; // отсутствие данных — не ноль
    out.push({ name, cal: +kcal, p: nz(n.proteins_100g), f: nz(n.fat_100g), c: nz(n.carbohydrates_100g), source: "off" });
  });
  return out;
}

async function offBarcode(code) {
  const r = await fetch(`https://world.openfoodfacts.org/api/v0/product/${encodeURIComponent(code)}.json`);
  if (!r.ok) throw new Error("off");
  const j = await r.json();
  if (!j.product) return null;
  const p = j.product, n = p.nutriments || {};
  const kcal = n["energy-kcal_100g"] != null ? n["energy-kcal_100g"] : (n.energy_100g ? n.energy_100g / 4.184 : null);
  if (kcal == null) return null;
  const nz = v => v == null ? null : +v;
  return { name: p.product_name || code, cal: +kcal, p: nz(n.proteins_100g), f: nz(n.fat_100g), c: nz(n.carbohydrates_100g), source: "off" };
}

async function doBarcodeLookup(code) {
  if (!code) { toast("Введите штрихкод", true); return; }
  const out = $("#barcodeResult");
  out.innerHTML = `<div class="hint">Ищем ${esc(code)} в Open Food Facts…</div>`;
  try {
    const item = await offBarcode(code);
    if (!item) { out.innerHTML = `<div class="empty">Продукт не найден. Попробуйте найти по названию во вкладке «Поиск» или добавьте вручную.</div>`; return; }
    out.innerHTML = resultRow(item);
  } catch {
    out.innerHTML = `<div class="empty">Нет сети или сервис недоступен. Попробуйте позже или добавьте продукт вручную.</div>`;
  }
}

/* ---------- Сканер штрихкодов ---------- */
let barcodeStream = null, barcodeTimer = null;
function stopBarcodeScan() {
  if (barcodeTimer) { clearInterval(barcodeTimer); barcodeTimer = null; }
  if (barcodeStream) { barcodeStream.getTracks().forEach(t => t.stop()); barcodeStream = null; }
  const v = $("#barcodeVideo");
  if (v) v.srcObject = null;
}
async function startScan() {
  const area = $("#scanArea");
  if (!area) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    area.innerHTML = `<div class="empty">Камера недоступна в этом браузере. Введите штрихкод вручную.</div>`;
    return;
  }
  if (!("BarcodeDetector" in window)) {
    area.innerHTML = `<div class="empty">Автосканер не поддерживается этим браузером — наведите камеру в любом приложении-сканере и введите код вручную. (На Android в Chrome обычно работает.)</div>`;
    return;
  }
  try {
    barcodeStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    area.innerHTML = `<div class="scan-frame"><video id="barcodeVideo" autoplay playsinline muted></video><div class="scan-line"></div></div>`;
    const video = $("#barcodeVideo");
    video.srcObject = barcodeStream;
    const detector = new BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"] });
    barcodeTimer = setInterval(async () => {
      try {
        const codes = await detector.detect(video);
        if (codes.length) {
          stopBarcodeScan();
          area.innerHTML = "";
          $("#barcodeInput").value = codes[0].rawValue;
          doBarcodeLookup(codes[0].rawValue);
        }
      } catch { /* ignore */ }
    }, 700);
  } catch (e) {
    area.innerHTML = `<div class="empty">Не удалось получить доступ к камере. Введите код вручную.</div>`;
  }
}

/* ---------- Фото ---------- */
async function recognizePhoto() {
  const key = data.settings.geminiKey;
  const dataUrl = $("#photoPreview").dataset.dataurl;
  const out = $("#photoResult");
  if (!key) {
    out.innerHTML = `<div class="empty">Сначала укажите ключ Gemini в Настройках → «Распознавание еды по фото» (бесплатно: aistudio.google.com/apikey).</div>`;
    return;
  }
  out.innerHTML = `<div class="hint">Распознаём блюдо на фото…</div>`;
  const btn = $("[data-action=recognizePhoto]"); if (btn) btn.disabled = true;
  try {
    const model = data.settings.aiModel || "gemini-2.5-flash";
    const prompt = "Ты — нутрициолог. Определи все блюда и продукты на фото. Оцени вес каждого в граммах и посчитай КБЖУ (калории, белки, жиры, углеводы). Ответь строго JSON без markdown и без обёртки из тройных кавычек: {\"items\":[{\"name\":\"название блюда\",\"grams\":200,\"cal\":250,\"p\":12,\"f\":8,\"c\":30}]}. Названия на русском.";
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    const mime = dataUrl.slice(5, dataUrl.indexOf(";"));
    const resp = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + encodeURIComponent(key), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: base64 } }] }]
      })
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error((err.error && err.error.message) || "HTTP " + resp.status);
    }
    const j = await resp.json();
    let txt = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts[0].text) || "";
    txt = txt.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(txt);
    const items = parsed.items || [];
    if (!items.length) { out.innerHTML = `<div class="empty">Не удалось распознать еду на фото.</div>`; return; }
    out.innerHTML = `<p class="hint" style="margin:0">Проверьте вес и значения — ИИ оценивает на глаз:</p>` +
      items.map((it, i) => `
        <div class="result-item" style="cursor:default">
          <div class="ri-main">
            <input class="ph-name" data-i="${i}" value="${esc(it.name)}" style="min-height:38px;margin-bottom:6px">
            <div class="field-grid-3" style="gap:6px">
              <input class="ph-g" data-i="${i}" type="number" value="${Math.round(num(it.grams))}" min="1" title="граммы">
              <input class="ph-cal" data-i="${i}" type="number" value="${Math.round(num(it.cal))}" min="0" title="ккал">
              <input class="ph-p" data-i="${i}" type="number" value="${num(it.p)}" min="0" step="0.1" title="белки">
            </div>
            <div class="field-grid-3" style="gap:6px;margin-top:6px">
              <input class="ph-f" data-i="${i}" type="number" value="${num(it.f)}" min="0" step="0.1" title="жиры">
              <input class="ph-c" data-i="${i}" type="number" value="${num(it.c)}" min="0" step="0.1" title="углеводы">
            </div>
          </div>
        </div>`).join("") +
      `<div class="btn-row"><button data-action="addPhotoItems">Добавить всё в дневник</button></div>`;
    photoItems = items;
  } catch (e) {
    out.innerHTML = `<div class="empty">Ошибка: ${esc(e.message)}. Проверьте ключ Gemini (aistudio.google.com/apikey) и имя модели.</div>`;
  } finally {
    if (btn) btn.disabled = false;
  }
}
let photoItems = [];

function addPhotoItems() {
  const items = photoItems.map((_, i) => ({
    name: $(`.ph-name[data-i="${i}"]`).value.trim() || "Блюдо",
    grams: num($(`.ph-g[data-i="${i}"]`).value),
    cal: num($(`.ph-cal[data-i="${i}"]`).value),
    p: num($(`.ph-p[data-i="${i}"]`).value),
    f: num($(`.ph-f[data-i="${i}"]`).value),
    c: num($(`.ph-c[data-i="${i}"]`).value)
  }));
  const meal = foodSearchCtx.meal;
  items.forEach(it => {
    const rec = touch(Object.assign({ id: uid(), date: selectedDate, meal }, it));
    if (foodSearchCtx.target === "plan") (data.mealPlan[selectedDate] = data.mealPlan[selectedDate] || []).push(rec);
    else data.foods.push(rec);
  });
  closeModal();
  refresh();
  toast(`Добавлено позиций: ${items.length}`);
}

/* ---------- Голос ---------- */
let recog = null, voiceItems = [];
function openVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  openModal(`
    <div class="modal-head"><h3>Голосовой ввод</h3><button class="close-x" data-action="closeModal">✕</button></div>
    ${SR ? `<div class="mic-big" data-action="toggleMic">🎤</div>
      <div class="voice-text" id="voiceText">Нажмите на микрофон и скажите, например:<br>«запиши на обед двести граммов гречки и куриную грудку»</div>
      <div id="voiceItems"></div>
      <div class="btn-row"><button data-action="addVoiceItems" disabled>Добавить в дневник</button></div>`
    : `<div class="empty">Голосовой ввод не поддерживается этим браузером. На Android попробуйте Chrome, на компьютере — Chrome или Edge. Можно пользоваться поиском и фото.</div>`}
  `);
  if (!SR) return;
  $("[data-action=toggleMic]").addEventListener("click", startVoiceRec);
}
function startVoiceRec() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (recog) { recog.stop(); recog = null; return; }
  recog = new SR();
  recog.lang = "ru-RU";
  recog.interimResults = true;
  recog.continuous = false;
  const mic = $("[data-action=toggleMic]");
  mic.classList.add("rec");
  $("#voiceText").textContent = "Слушаю…";
  recog.onresult = e => {
    let text = "";
    for (let i = e.resultIndex; i < e.results.length; i++) text += e.results[i][0].transcript;
    $("#voiceText").textContent = text;
    if (e.results[e.results.length - 1].isFinal) processVoice(text);
  };
  recog.onerror = e => {
    mic.classList.remove("rec");
    if (e.error === "not-allowed") $("#voiceText").textContent = "Нет доступа к микрофону. Разрешите его в настройках браузера.";
    else if (e.error !== "aborted") $("#voiceText").textContent = "Ошибка распознавания: " + e.error;
  };
  recog.onend = () => { mic.classList.remove("rec"); };
  recog.start();
}
function processVoice(text) {
  const parsed = parseMealText(text);
  voiceItems = parsed.items;
  renderVoiceItems();
}
function renderVoiceItems() {
  const el = $("#voiceItems");
  const btn = $("[data-action=addVoiceItems]");
  if (!voiceItems.length) { el.innerHTML = `<div class="empty">Ничего не распознано — попробуйте сказать ещё раз.</div>`; btn.disabled = true; return; }
  btn.disabled = false;
  el.innerHTML = voiceItems.map((it, i) => `
    <div class="result-item" style="cursor:default">
      <div class="ri-main">
        <div class="ri-name">${esc(it.name)}${it.matched ? `<span class="badge custom">найдено</span>` : `<span class="badge">не найдено</span>`}</div>
        <div class="field-grid-3" style="gap:6px;margin-top:6px">
          <input class="vi-g" data-i="${i}" type="number" value="${Math.round(it.grams)}" min="1" title="граммы">
          <input class="vi-cal" data-i="${i}" type="number" value="${Math.round(it.cal)}" min="0" title="ккал">
          <input class="vi-p" data-i="${i}" type="number" value="${it.p}" min="0" step="0.1" title="белки">
        </div>
        <div class="field-grid-3" style="gap:6px;margin-top:6px">
          <input class="vi-f" data-i="${i}" type="number" value="${it.f}" min="0" step="0.1" title="жиры">
          <input class="vi-c" data-i="${i}" type="number" value="${it.c}" min="0" step="0.1" title="углеводы">
        </div>
        ${it.matched ? "" : `<button class="small ghost" data-action="searchVoiceItem" data-i="${i}" style="margin-top:6px">Найти в базе по названию</button>`}
      </div>
    </div>`).join("");
}
function searchVoiceItem(i) {
  const it = voiceItems[i];
  foodSearchCtx.meal = it.meal || foodSearchCtx.meal;
  closeModal();
  openFoodSearch(foodSearchCtx.meal);
  setTimeout(() => { const inp = $("#foodQuery"); if (inp) { inp.value = it.name; inp.dispatchEvent(new Event("input")); } }, 60);
}
function addVoiceItems() {
  const parsedMeal = parseMealText($("#voiceText").textContent || "").meal;
  const meal = parsedMeal || foodSearchCtx.meal;
  let added = 0, skipped = 0;
  voiceItems.forEach((it, i) => {
    const cal = num($(`.vi-cal[data-i="${i}"]`).value);
    if (!cal && !it.matched) { skipped++; return; } // нераспознанное без калорий не сохраняем
    const rec = touch({
      id: uid(), date: selectedDate, meal: it.meal || meal,
      name: it.name, grams: num($(`.vi-g[data-i="${i}"]`).value),
      cal, p: num($(`.vi-p[data-i="${i}"]`).value),
      f: num($(`.vi-f[data-i="${i}"]`).value), c: num($(`.vi-c[data-i="${i}"]`).value)
    });
    if (foodSearchCtx.target === "plan") (data.mealPlan[selectedDate] = data.mealPlan[selectedDate] || []).push(rec);
    else data.foods.push(rec);
    added++;
  });
  closeModal();
  refresh();
  if (skipped) toast(`Пропущено ${skipped}: найдите блюдо в базе (кнопка «Найти в базе»)`, true);
  toast(`Добавлено позиций: ${added}`);
}

/* Парсер фразы: «на обед два яйца и 200 грамм гречки» */
function canonicalMeal(word) {
  if (!word) return null;
  const w = word.toLowerCase().replace(/ё/g, "е");
  const names = data.settings.mealNames.length ? data.settings.mealNames : ["Завтрак", "Обед", "Ужин", "Перекус"];
  return names.find(n => n.toLowerCase().replace(/ё/g, "е").includes(w)) || null;
}
function parseMealText(text) {
  const t = " " + text.toLowerCase().replace(/ё/g, "е") + " ";
  const mealMatch = t.match(/второй завтрак|завтрак|обед|ужин|перекус|полдник/);
  const meal = mealMatch ? canonicalMeal(mealMatch[0]) : null;
  const chunks = text.split(/[,;]|\s+и\s+|\s+плюс\s+/).map(s => s.trim()).filter(Boolean);
  const items = chunks.map(chunk => parseChunk(chunk)).filter(Boolean);
  return { meal, items };
}
function parseChunk(chunk) {
  let s = " " + chunk.toLowerCase().replace(/ё/g, "е") + " ";
  s = s.replace(/\s(бро|братан|съел|съела|выпил|выпила|положи|запиши|добавь|мне|было|это|пожалуйста|еще|ещё)\s/g, " ");
  s = s.replace(/\sбез\s+сахара\s/g, " ").replace(/\sбез\s+соли\s/g, " ");
  if (/полкило/.test(s)) { s = s.replace(/полкило/, ""); return parseChunkCore(s, 500, "g"); }
  s = s.replace(/\s*(завтрак\w*|обед\w*|ужин\w*|перекус\w*|полдник\w*)\s*/g, " ");
  // число
  let qty = null;
  const digit = s.match(/(\d+(?:[.,]\d+)?)/);
  if (digit) qty = parseFloat(digit[1].replace(",", "."));
  else {
    for (const [w, v] of Object.entries(NUM_WORDS)) {
      if (new RegExp("\\s" + w + "\\s").test(s)) { qty = v; s = s.replace(new RegExp("\\s" + w + "\\s"), " "); break; }
    }
    if (qty == null && /пара\s/.test(s)) { qty = 2; s = s.replace(/\sпара\s/, " "); }
  }
  return parseChunkCore(s, qty, null);
}
function parseChunkCore(s, qty, unit) {
  // единицы
  let unit_ = unit, mult = 1;
  const unitMap = [
    [/кг|килограмм\w*/, "kg"], [/грамм\w*|гр\b|\sг\s/, "g"], [/мл|миллилитр\w*/, "ml"],
    [/литр\w*|\sл\s/, "l"], [/штук\w*|шт\b|штука|штуки/, "pc"], [/порци\w*/, "portion"],
    [/стакан\w*/, "cup"], [/чашк\w*/, "cup"], [/столов\w*\s*ложк\w*/, "tbsp"], [/чайн\w*\s*ложк\w*/, "tsp"], [/ложк\w*/, "tbsp"],
    [/ломтик\w*|кусоч\w*|кусок/, "slice"]
  ];
  for (const [re, u] of unitMap) {
    const m = s.match(re);
    if (m) { unit_ = u; s = s.replace(m[0], " "); break; }
  }
  // имя
  let name = s.replace(/\d+([.,]\d+)?/g, " ").replace(/\s+/g, " ").trim();
  name = name.replace(/^(на|в|это|было)\s+/, "").trim();
  // поиск в базе
  const matched = findFoodMatch(name);
  let grams = 100, cal = 0, p = 0, f = 0, c = 0;
  if (matched) {
    if (unit_ === "kg") grams = (qty || 0.1) * 1000;
    else if (unit_ === "g" || unit_ === "ml") grams = qty || 100;
    else if (unit_ === "l") grams = (qty || 0.25) * 1000;
    else if (unit_ === "cup") grams = (qty || 1) * 250;
    else if (unit_ === "tbsp") grams = (qty || 1) * 25;
    else if (unit_ === "tsp") grams = (qty || 1) * 10;
    else if (unit_ === "slice") grams = (qty || 1) * 30;
    else if (unit_ === "portion") grams = (qty || 1) * 250;
    else if (unit_ === "pc") grams = matched.piece ? (qty || 1) * matched.piece : (qty || 1) * 100;
    else grams = qty != null && matched.piece ? qty * matched.piece : (qty != null ? qty * 100 : 100);
    const k = grams / 100;
    cal = Math.round(matched.cal * k); p = Math.round(matched.p * k * 10) / 10;
    f = Math.round(matched.f * k * 10) / 10; c = Math.round(matched.c * k * 10) / 10;
    return { name: matched.name, raw: name, grams, cal, p, f, c, matched: true, meal: null };
  }
  if (!name.trim()) return null; // пустой обрывок фразы
  return { name: name || chunk, raw: name, grams: qty ? qty * 100 : 100, cal: 0, p: 0, f: 0, c: 0, matched: false, meal: null };
}
function findFoodMatch(name) {
  if (!name) return null;
  const nq = name.toLowerCase().replace(/ё/g, "е").trim();
  if (!nq) return null;
  let best = null, bestScore = 0;
  const all = FOOD_DB.concat(data.customFoods.map(c => ({ name: c.name, cal: c.cal, p: c.p, f: c.f, c: c.c, piece: null })));
  for (const item of all) {
    const iname = item.name.toLowerCase().replace(/ё/g, "е");
    let score = 0;
    if (iname === nq) score = 100;
    else if (iname.includes(nq) || nq.includes(iname)) score = 80 - Math.abs(iname.length - nq.length) * 0.5;
    else {
      const toks = nq.split(/\s+/).filter(w => w.length > 3);
      const itoks = iname.split(/\s+/);
      const hit = toks.filter(w => itoks.some(iw => {
        const stem = w.slice(0, Math.max(3, w.length - 1));
        return iw.startsWith(w) || iw.startsWith(stem);
      })).length;
      if (toks.length && hit / toks.length >= 0.5) score = 40 * hit / toks.length;
    }
    if (score > bestScore) { bestScore = score; best = item; }
  }
  return bestScore >= 25 ? best : null;
}

/* ---------- Ручное добавление (как в старой версии) ---------- */
function showAddManually() {
  const names = data.settings.mealNames.length ? data.settings.mealNames : ["Завтрак", "Обед", "Ужин", "Перекус"];
  openModal(`
    <div class="modal-head"><h3>Добавить вручную</h3><button class="close-x" data-action="closeModal">✕</button></div>
    <p class="hint" style="margin:0 0 10px">Знаете БЖУ — калории посчитаются сами: 1 г белка = 4 ккал, 1 г углеводов = 4 ккал, 1 г жиров = 9 ккал.</p>
    <label class="field">Название<input id="mfName" placeholder="Например: овсянка"></label>
    <div class="field-grid-3" style="margin-top:8px">
      <label class="field">Белки<input id="mfP" type="number" min="0" step="0.1"></label>
      <label class="field">Жиры<input id="mfF" type="number" min="0" step="0.1"></label>
      <label class="field">Углеводы<input id="mfC" type="number" min="0" step="0.1"></label>
      <label class="field">Ккал<input id="mfCal" type="number" min="0" step="1"></label>
      <label class="field">Граммы<input id="mfG" type="number" min="0" step="1"></label>
      <label class="field">Приём<select id="mfMeal">${names.map(n => `<option>${esc(n)}</option>`).join("")}</select></label>
    </div>
    <label class="autocal-chk"><input type="checkbox" id="mfAutoCal" checked> Считать калории по БЖУ (4·Б + 4·У + 9·Ж)</label>
    <div class="btn-row"><button data-action="saveManualFood">Добавить</button></div>
  `, { center: true });
  bindAutoCal("mfCal", "mfP", "mfF", "mfC", "mfAutoCal");
}
function saveManualFood() {
  const name = $("#mfName").value.trim();
  const cal = num($("#mfCal").value), p = num($("#mfP").value), f = num($("#mfF").value), c = num($("#mfC").value);
  if (!name && !cal && !p && !f && !c) { toast("Заполните хотя бы название или калории", true); return; }
  const rec = touch({ id: uid(), date: selectedDate, meal: $("#mfMeal").value, name: name || "Без названия", grams: num($("#mfG").value) || null, cal, p, f, c });
  if (foodSearchCtx.target === "plan") (data.mealPlan[selectedDate] = data.mealPlan[selectedDate] || []).push(rec);
  else data.foods.push(rec);
  closeModal();
  refresh();
}

function editFood(id) {
  const item = data.foods.find(x => x.id === id);
  if (!item) return;
  const names = data.settings.mealNames.length ? data.settings.mealNames : ["Завтрак", "Обед", "Ужин", "Перекус"];
  const auto = !num(item.cal) || num(item.cal) === macroCal(item.p, item.f, item.c);
  openModal(`
    <div class="modal-head"><h3>Изменить запись</h3><button class="close-x" data-action="closeModal">✕</button></div>
    <label class="field">Название<input id="efName" value="${esc(item.name)}"></label>
    <div class="field-grid-3" style="margin-top:8px">
      <label class="field">Белки<input id="efP" type="number" min="0" step="0.1" value="${item.p}"></label>
      <label class="field">Жиры<input id="efF" type="number" min="0" step="0.1" value="${item.f}"></label>
      <label class="field">Углеводы<input id="efC" type="number" min="0" step="0.1" value="${item.c}"></label>
      <label class="field">Ккал<input id="efCal" type="number" min="0" step="1" value="${item.cal}"></label>
      <label class="field">Граммы<input id="efG" type="number" min="0" step="1" value="${item.grams || ""}"></label>
      <label class="field">Приём<select id="efMeal">${names.map(n => `<option${n === item.meal ? " selected" : ""}>${esc(n)}</option>`).join("")}</select></label>
    </div>
    <label class="autocal-chk"><input type="checkbox" id="efAutoCal" ${auto ? "checked" : ""}> Считать калории по БЖУ (4·Б + 4·У + 9·Ж)</label>
    <div class="btn-row"><button data-action="saveEditFood" data-id="${id}">Сохранить</button></div>
  `, { center: true });
  bindAutoCal("efCal", "efP", "efF", "efC", "efAutoCal");
}
function saveEditFood(id) {
  const item = data.foods.find(x => x.id === id);
  if (!item) return;
  item.name = $("#efName").value.trim() || item.name;
  item.cal = num($("#efCal").value); item.p = num($("#efP").value); item.f = num($("#efF").value); item.c = num($("#efC").value);
  item.grams = num($("#efG").value) || null; item.meal = $("#efMeal").value;
  touch(item);
  closeModal(); refresh();
}

function copyYesterday() {
  const y = shiftDate(selectedDate, -1);
  const items = foodsFor(y);
  if (!items.length) { toast("За вчера ничего не записано", true); return; }
  if (!confirm(`Скопировать ${items.length} ${plural(items.length, "запись", "записи", "записей")} за ${fmtDateShort(y)} в ${fmtDateShort(selectedDate)}?`)) return;
  items.forEach(it => data.foods.push({ ...it, id: uid(), date: selectedDate }));
  refresh();
  toast("Скопировано");
}

/* ================= ТРЕНИРОВКИ ================= */
function renderWorkouts() {
  $("#dateInputW").value = selectedDate;
  const items = data.workouts.filter(w => w.date === selectedDate);
  $("#workoutList").innerHTML = items.length ? items.map(w => {
    const startedAt = w.startedAt ? new Date(w.startedAt) : null;
    const endTime = w.status === "done" && w.startedAt && w.minutes ? new Date(w.startedAt + w.minutes * 60000) : null;
    const startTimeStr = startedAt ? `${String(startedAt.getHours()).padStart(2,"0")}:${String(startedAt.getMinutes()).padStart(2,"0")}` : "";
    const endTimeStr = endTime ? `${String(endTime.getHours()).padStart(2,"0")}:${String(endTime.getMinutes()).padStart(2,"0")}` : "";
    const timeStr = (startTimeStr && endTimeStr) ? ` · ${startTimeStr}–${endTimeStr}` : (startTimeStr ? ` · с ${startTimeStr}` : "");
    return `
    <div class="item">
      <div class="item-main">
        <div class="name">${esc(w.name)} ${w.status === "in_progress" ? `<span class="badge">идёт</span>` : ""}</div>
        <small>${w.minutes ? w.minutes + " мин" : ""}${w.minutes && w.cal ? " · " : ""}${w.cal ? w.cal + " ккал" : ""}${timeStr}</small>
        ${workoutBodyHtml(w)}
      </div>
      <div class="item-right">
        ${w.status === "in_progress" ? `<button class="small primary" data-action="resumeWorkout" data-id="${w.id}">Продолжить</button>` : ""}
        <button class="icon-btn" data-action="delWorkout" data-id="${w.id}">✕</button>
      </div>
    </div>`;
  }).join("") : `<div class="empty">Тренировок за этот день пока нет.</div>`;

  // планы
  $("#planList").innerHTML = data.plans.length ? data.plans.map(p => `
    <div class="panel" style="margin:12px 0 0;padding:14px">
      <div class="section-title" style="font-size:16px">${esc(p.name)}
        <span class="small-actions">
          <button class="small primary" data-action="startPlan" data-id="${p.id}">Начать тренировку</button>
          <button class="small ghost" data-action="editPlan" data-id="${p.id}">Изменить</button>
          <button class="small danger" data-action="delPlan" data-id="${p.id}">Удалить</button>
        </span>
      </div>
      ${p.exercises.map(e => `<div class="item" style="cursor:default"><div class="item-main"><div class="name" style="font-weight:600;font-size:14.5px">${esc(e.name)}</div><small>${e.sets} × ${esc(e.reps)}${e.weight ? " · " + esc(e.weight) : ""}</small></div></div>`).join("")}
    </div>`).join("") : `<div class="empty">Планов пока нет. Создайте план — например «День ног».</div>`;

  // история тренировок (все записи)
  const hist = sortedWorkouts();
  $("#workoutHistory").innerHTML = hist.length ? hist.map(w => {
    const startedAt = w.startedAt ? new Date(w.startedAt) : null;
    const endTime = w.status === "done" && w.startedAt && w.minutes ? new Date(w.startedAt + w.minutes * 60000) : null;
    const startTimeStr = startedAt ? `${String(startedAt.getHours()).padStart(2,"0")}:${String(startedAt.getMinutes()).padStart(2,"0")}` : "";
    const endTimeStr = endTime ? `${String(endTime.getHours()).padStart(2,"0")}:${String(endTime.getMinutes()).padStart(2,"0")}` : "";
    const timeStr = (startTimeStr && endTimeStr) ? ` · ${startTimeStr}–${endTimeStr}` : (startTimeStr ? ` · с ${startTimeStr}` : "");
    return `
    <details class="workout-hist">
      <summary><b>${esc(w.name)}</b><span class="wh-meta">${fmtDateFullShort(w.date)}${timeStr}${w.minutes ? " · " + w.minutes + " мин" : ""}${w.cal ? " · " + w.cal + " ккал" : ""}${w.status === "in_progress" ? " · идёт" : ""}</span></summary>
      <div class="wh-body">${workoutBodyHtml(w) || `<div class="empty">Без деталей</div>`}</div>
    </details>`;
  }).join("") : `<div class="empty">История пуста — начните первую тренировку по плану.</div>`;
}

/* ---------- Тренировка вживую: запись подходов ---------- */
function openTrainingSession(planId) {
  const plan = data.plans.find(p => p.id === planId);
  if (!plan) return;
  let w = data.workouts.find(x => x.planId === planId && x.status === "in_progress");
  if (!w) {
    w = touch({ id: uid(), date: selectedDate, name: plan.name, planId, status: "in_progress", startedAt: Date.now(), minutes: 0, cal: 0, exercises: plan.exercises.map(e => ({ name: e.name, sets: [] })) });
    data.workouts.push(w);
    persist();
    renderWorkouts();
    toast("Тренировка началась — записывайте подходы по ходу занятия");
  } else {
    toast("Продолжаем незаконченную тренировку");
  }
  renderTrainingSession(w.id);
}

function renderTrainingSession(wid) {
  const w = data.workouts.find(x => x.id === wid);
  if (!w) return;
  const plan = data.plans.find(p => p.id === w.planId);
  const planEx = (plan && plan.exercises) || [];
  const exs = workoutExercises(w);
  // Время тренировки
  const startedAt = w.startedAt ? new Date(w.startedAt) : null;
  const startTimeStr = startedAt ? `${String(startedAt.getHours()).padStart(2,"0")}:${String(startedAt.getMinutes()).padStart(2,"0")}` : "";
  const rows = exs.map((ex, i) => {
    const last = lastSetsFor(ex.name, w);
    const planHint = planEx.find(pe => normExName(pe.name) === normExName(ex.name));
    const planTxt = planHint ? ` · план: ${planHint.sets}×${esc(planHint.reps)}${planHint.weight ? " · " + esc(planHint.weight) : ""}` : "";
    const pre = last && last.sets.length && ex.sets.length === 0 ? last.sets[last.sets.length - 1] : null;
    return `
    <div class="ts-ex" draggable="true" data-ex-index="${i}">
      <div class="ts-ex-head"><b title="Перетащите для изменения порядка">⇅ ${esc(ex.name)}</b><button class="icon-btn" data-action="delSessionEx" data-id="${w.id}" data-i="${i}" title="Удалить упражнение">✕</button></div>
      <div class="ts-last">${last ? `Прошлый раз (${fmtDateShort(last.date)}): <b>${esc(setsLine(last.sets))}</b>` : "Прошлый раз: записей нет"}${planTxt}</div>
      <div class="ts-sets">${ex.sets.length ? ex.sets.map((s, j) => `<span class="set-chip">${esc(fmtSet(s))}<button data-action="delSet" data-id="${w.id}" data-i="${i}" data-j="${j}" title="Удалить подход">✕</button></span>`).join("") : `<span class="empty" style="padding:4px 0">Подходы пока не записаны</span>`}</div>
      <div class="ts-input-row">
        <input class="ts-w" data-i="${i}" type="number" inputmode="decimal" min="0" step="0.5" placeholder="вес, кг" value="${pre && pre.weight != null ? pre.weight : ""}">
        <div style="display:flex;gap:6px;align-items:center;flex:1">
          <input class="ts-r" data-i="${i}" type="text" inputmode="text" placeholder="повторы или 'до отказа'" value="${pre ? esc(pre.reps) : ""}" style="flex:1">
          <label class="autocal-chk" style="white-space:nowrap;font-size:12px;margin:0"><input type="checkbox" class="chk-failure" data-i="${i}" ${pre && pre.toFailure ? "checked" : ""}> до отказа</label>
        </div>
        <button class="small primary" data-action="addSet" data-id="${w.id}" data-i="${i}">Записать подход</button>
      </div>
    </div>`;
  }).join("");
  openModal(`
    <div class="modal-head"><h3>${esc(w.name)} — запись подходов</h3><button class="close-x" data-action="closeSession">✕</button></div>
    <div class="hint" style="margin:0 0 10px">Вес и повторы вводятся по ходу тренировки. Всё сохраняется сразу — можно закрыть приложение и продолжить позже (кнопка «Продолжить» в списке тренировок за день).</div>
    <div class="panel rest-panel" style="margin:0 0 12px;padding:12px">
      <div class="section-title" style="margin-bottom:8px">Таймер отдыха</div>
      <div class="rest-face"><b id="restTime">${restFmt(num(data.settings.restSec) || 90)}</b></div>
      <div class="field-grid" style="grid-template-columns:1fr 1fr;margin-top:8px">
        <label class="field">Сколько отдыхать
          <select id="restDur">
            ${[15,30,45,60,75,90,120,150,180,240,300].map(s => `<option value="${s}" ${+data.settings.restSec === s ? "selected" : ""}>${restFmt(s)}</option>`).join("")}
            <option value="custom">Свой интервал…</option>
          </select>
        </label>
        <label class="field">Свой, сек<input id="restCustom" type="number" min="5" max="3600" placeholder="Например: 100" style="display:none"></label>
      </div>
      <label class="autocal-chk" style="margin-top:8px"><input type="checkbox" id="restAuto" ${data.settings.restAuto ? "checked" : ""}> Запускать автоматически после записи подхода</label>
      <div class="btn-row" style="margin-top:10px">
        <button class="primary" data-action="restToggle" id="restToggleBtn">Старт</button>
        <button class="ghost" data-action="restReset">Сброс</button>
      </div>
    </div>
    <div id="tsList">${rows || `<div class="empty">В этом плане нет упражнений — добавьте их кнопкой ниже.</div>`}</div>
    <div class="hint" style="margin:0 0 8px">💡 Перетащите упражнение за название ⇅ для изменения порядка</div>
    <div class="btn-row"><button class="ghost" data-action="addSessionEx" data-id="${w.id}">＋ Упражнение</button></div>
    <div class="field-grid" style="margin-top:10px">
      <label class="field">Длительность, мин<input id="tsMin" type="number" min="0" step="1" value="${w.minutes || ""}" placeholder="60"></label>
      <label class="field">Калории<input id="tsCal" type="number" min="0" step="1" value="${w.cal || ""}" placeholder="200"></label>
    </div>
    <div class="btn-row">
      <button data-action="finishWorkout" data-id="${w.id}">Завершить тренировку</button>
      <button class="ghost" data-action="closeSession">Закрыть (не удалять)</button>
    </div>
  `);
  // === Drag & Drop для перемещения упражнений ===
  let dragIdx = null;
  const list = $("#tsList");
  if (list) {
    list.querySelectorAll(".ts-ex").forEach(el => {
      el.addEventListener("dragstart", e => {
        dragIdx = +el.dataset.exIndex;
        el.style.opacity = "0.4";
        e.dataTransfer.effectAllowed = "move";
      });
      el.addEventListener("dragend", () => {
        el.style.opacity = "1";
        dragIdx = null;
        list.querySelectorAll(".ts-ex").forEach(x => x.style.borderTop = "");
      });
      el.addEventListener("dragover", e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        el.style.borderTop = "2px solid var(--accent)";
      });
      el.addEventListener("dragleave", () => {
        el.style.borderTop = "";
      });
      el.addEventListener("drop", e => {
        e.preventDefault();
        el.style.borderTop = "";
        const dropIdx = +el.dataset.exIndex;
        if (dragIdx !== null && dragIdx !== dropIdx) {
          const exs = workoutExercises(w);
          const [moved] = exs.splice(dragIdx, 1);
          exs.splice(dropIdx, 0, moved);
          w.exercises = exs;
          touch(w);
          persist();
          renderTrainingSession(w.id);
        }
      });
    });
  }
  restDraw();
  $("#restDur").addEventListener("change", e => {
    const custom = $("#restCustom");
    if (custom) custom.style.display = e.target.value === "custom" ? "" : "none";
    if (e.target.value !== "custom") { data.settings.restSec = +e.target.value || 90; persist(); restReset(); }
  });
  $("#restCustom").addEventListener("change", e => {
    const sec = Math.min(3600, Math.max(5, Math.round(num(e.target.value) || 0)));
    if (sec) { data.settings.restSec = sec; persist(); restReset(); }
  });
  $("#restAuto").addEventListener("change", e => { data.settings.restAuto = !!e.target.checked; persist(); });
  $(".modal").addEventListener("keydown", e => {
    if (e.key === "Enter" && e.target.classList && e.target.classList.contains("ts-r")) {
      e.preventDefault();
      addSetBtn(w.id, +e.target.dataset.i);
    }
  });
}

function addSetBtn(wid, i) {
  const w = data.workouts.find(x => x.id === wid);
  if (!w || !w.exercises || !w.exercises[i]) return;
  const reps = $(`.ts-r[data-i="${i}"]`).value.trim();
  const wRaw = $(`.ts-w[data-i="${i}"]`).value.trim();
  const toFailure = $(`.chk-failure[data-i="${i}"]`) ? !!$(`.chk-failure[data-i="${i}"]`).checked : false;
  if (!reps) { toast("Укажите повторы — без них подход не запишется", true); return; }
  const auto = $("#restAuto") ? $("#restAuto").checked : data.settings.restAuto;
  const sec = restReadSec();
  data.settings.restAuto = !!auto;
  data.settings.restSec = sec;
  w.exercises[i].sets.push({ weight: wRaw === "" ? null : num(wRaw), reps, toFailure: toFailure });
  touch(w);
  persist();
  renderTrainingSession(wid);
  if (auto) restStart(sec);
}

function finishWorkout(wid) {
  const w = data.workouts.find(x => x.id === wid);
  if (!w) return;
  restReset();
  const totalSets = workoutExercises(w).reduce((s, e) => s + (e.sets || []).length, 0);
  w.minutes = num($("#tsMin").value);
  w.cal = num($("#tsCal").value);
  w.status = "done";
  touch(w);
  persist();
  closeModal();
  refresh();
  toast(totalSets ? `Тренировка сохранена — ${totalSets} ${plural(totalSets, "подход", "подхода", "подходов")}` : "Тренировка сохранена");
}

function openPlanEditor(plan) {
  const ex = (plan && plan.exercises) || [{ name: "", sets: 3, reps: "12", weight: "" }];
  openModal(`
    <div class="modal-head"><h3>${plan ? "Изменить план" : "Новый тренировочный план"}</h3><button class="close-x" data-action="closeModal">✕</button></div>
    <label class="field">Название плана<input id="planName" value="${esc(plan ? plan.name : "")}" placeholder="Например: День спины" required></label>
    <div id="exRows" style="margin-top:12px"></div>
    <div class="btn-row">
      <button class="ghost" data-action="addExRow">＋ Упражнение</button>
      <button data-action="savePlan" data-id="${plan ? plan.id : ""}">Сохранить план</button>
    </div>
  `);
  const renderRows = () => {
    $("#exRows").innerHTML = ex.map((e, i) => `
      <div class="field-grid" style="margin-bottom:8px">
        <label class="field" style="grid-column:1/-1">Упражнение ${i + 1}<input class="ex-name" data-i="${i}" value="${esc(e.name)}" placeholder="Например: жим лёжа"></label>
        <label class="field">Подходы<input class="ex-sets" data-i="${i}" type="number" min="1" value="${e.sets}"></label>
        <label class="field">Повторы/время<input class="ex-reps" data-i="${i}" value="${esc(e.reps)}" placeholder="12"></label>
        <label class="field" style="grid-column:1/-1">Вес (необязательно)<input class="ex-weight" data-i="${i}" value="${esc(e.weight || "")}" placeholder="40 кг"></label>
      </div>`).join("");
  };
  renderRows();
  $("[data-action=addExRow]").addEventListener("click", () => { ex.push({ name: "", sets: 3, reps: "12", weight: "" }); renderRows(); });
  $("#exRows").addEventListener("input", e => {
    const i = +e.target.dataset.i;
    if (e.target.classList.contains("ex-name")) ex[i].name = e.target.value;
    if (e.target.classList.contains("ex-sets")) ex[i].sets = e.target.value;
    if (e.target.classList.contains("ex-reps")) ex[i].reps = e.target.value;
    if (e.target.classList.contains("ex-weight")) ex[i].weight = e.target.value;
  });
  $(".modal").addEventListener("click", e => {
    if (e.target.closest("[data-action=savePlan]")) {
      const name = $("#planName").value.trim();
      if (!name) { toast("Укажите название", true); return; }
      const exercises = ex.map(x => ({ name: x.name, sets: num(x.sets) || 3, reps: x.reps || "", weight: x.weight || "" })).filter(x => x.name);
      if (!exercises.length) { toast("Добавьте хотя бы одно упражнение", true); return; }
      const p = touch({ id: plan ? plan.id : uid(), name, exercises });
      if (plan) data.plans = data.plans.map(x => x.id === plan.id ? p : x);
      else data.plans.push(p);
      closeModal(); refresh(); toast("План сохранён");
    }
  }, { once: false });
}

/* ---------- Конструктор блюд из ингредиентов ---------- */
let recipeCtx = null; // {id, name, items:[{name,grams,cal,p,f,c}], finished}

function openRecipeBuilder(existing) {
  if (existing && existing.recipe) {
    recipeCtx = {
      id: existing.id, name: existing.name,
      items: JSON.parse(JSON.stringify(existing.recipe.items)).map(it => ({ ...it, autoCal: it.autoCal !== false })),
      finished: existing.recipe.finishedGrams || null,
      finishedTouched: existing.recipe.finishedAuto === true ? false : true // авто-вес сохраняем, если он был авто
    };
  } else {
    recipeCtx = { id: null, name: existing ? existing.name : "", items: [], finished: null, finishedTouched: false };
  }
  renderRecipeBuilder();
}

function recipeTotals() {
  const t = { g: 0, cal: 0, p: 0, f: 0, c: 0 };
  (recipeCtx.items || []).forEach(it => {
    const k = num(it.grams) / 100;
    t.g += num(it.grams); t.cal += num(it.cal) * k; t.p += num(it.p) * k; t.f += num(it.f) * k; t.c += num(it.c) * k;
  });
  return t;
}

function renderRecipeBuilder() {
  openModal(`
    <div class="modal-head"><h3>Блюдо из ингредиентов</h3><button class="close-x" data-action="closeModal">✕</button></div>
    <p class="hint" style="margin:0 0 10px">Соберите блюдо из ингредиентов с известным КБЖУ (например, пиццу): приложение посчитает КБЖУ всего блюда и на 100 г. Потом просто записывайте, сколько грамм съели.</p>
    <label class="field">Название блюда<input id="rbName" value="${esc(recipeCtx.name)}" placeholder="Например: пицца домашняя"></label>
    <div class="search-row" style="margin-top:10px"><input id="rbQuery" placeholder="Поиск ингредиента: мука, сыр…" autocomplete="off"><button data-action="recipeAddManual">Вручную</button></div>
    <div id="rbResults" style="margin-top:8px"></div>
    <div id="rbItems" style="margin-top:12px"></div>
    <div id="rbTotals"></div>
    <div class="btn-row"><button data-action="saveRecipe">Сохранить блюдо</button></div>
  `);
  const q = $("#rbQuery");
  let deb = null;
  q.addEventListener("input", () => { clearTimeout(deb); deb = setTimeout(() => renderRecipeSearch(q.value.trim()), 300); });
  renderRecipeSearch("");
  renderRecipeItems();
}

function renderRecipeSearch(q) {
  const el = $("#rbResults");
  if (!el) return;
  const norm = (q || "").toLowerCase().replace(/ё/g, "е");
  let list = FOOD_DB.map(x => ({ name: x.name, cal: x.cal, p: x.p, f: x.f, c: x.c }))
    .concat(data.customFoods.map(x => ({ name: x.name, cal: x.cal, p: x.p, f: x.f, c: x.c })));
  if (norm) list = list.filter(x => x.name.toLowerCase().replace(/ё/g, "е").includes(norm));
  el.innerHTML = list.slice(0, 8).map(x => `
    <div class="result-item" data-action="recipePick" data-json="${esc(JSON.stringify(x))}">
      <div class="ri-main"><div class="ri-name">${esc(x.name)}</div><div class="ri-sub">${Math.round(num(x.cal))} ккал/100г · Б${fmtNum(x.p)} Ж${fmtNum(x.f)} У${fmtNum(x.c)}</div></div>
      <span class="ri-kcal">＋</span>
    </div>`).join("") || `<div class="empty">Ничего не нашлось — добавьте ингредиент кнопкой «Вручную».</div>`;
}

function renderRecipeItems() {
  const el = $("#rbItems");
  if (!el) return;
  el.innerHTML = recipeCtx.items.length ? recipeCtx.items.map((it, i) => `
    <div class="rb-item">
      <div class="field-grid-3" style="gap:6px">
        <label class="field" style="grid-column:1/-1">Ингредиент ${i + 1}<input class="rb-n" data-i="${i}" value="${esc(it.name)}" placeholder="Название"></label>
        <label class="field">Граммы<input class="rb-g" data-i="${i}" type="number" min="1" step="1" value="${it.grams}"></label>
        <label class="field">Ккал/100г<input class="rb-cal" data-i="${i}" type="number" min="0" step="1" value="${it.cal}"></label>
        <label class="field">Б/100г<input class="rb-p" data-i="${i}" type="number" min="0" step="0.1" value="${it.p}"></label>
        <label class="field">Ж/100г<input class="rb-f" data-i="${i}" type="number" min="0" step="0.1" value="${it.f}"></label>
        <label class="field">У/100г<input class="rb-c" data-i="${i}" type="number" min="0" step="0.1" value="${it.c}"></label>
      </div>
      <button class="icon-btn" data-action="recipeDelItem" data-i="${i}" title="Удалить ингредиент">✕</button>
    </div>`).join("") : `<div class="empty">Ингредиенты пока не добавлены — найдите выше или нажмите «Вручную».</div>`;
  el.oninput = onRbInput;
  renderRecipeTotals();
}

function onRbInput(e) {
  const t = e.target;
  if (!t.dataset || t.dataset.i == null) return;
  const i = +t.dataset.i;
  const it = recipeCtx.items[i];
  if (!it) return;
  if (t.classList.contains("rb-n")) it.name = t.value;
  if (t.classList.contains("rb-g")) {
    it.grams = num(t.value);
    // авто-вес готового блюда следует за суммой ингредиентов, пока его не правили вручную
    if (!recipeCtx.finishedTouched) {
      const sum = Math.round(recipeTotals().g);
      recipeCtx.finished = sum;
      const f = $("#rbFinished");
      if (f) f.value = sum || "";
    }
  }
  if (t.classList.contains("rb-cal")) { it.cal = num(t.value); it.autoCal = false; } // ручной ввод калорий — приоритет
  if (t.classList.contains("rb-p")) it.p = num(t.value);
  if (t.classList.contains("rb-f")) it.f = num(t.value);
  if (t.classList.contains("rb-c")) it.c = num(t.value);
  // для ингредиентов без своих калорий (вручную добавленных) калории считаются по БЖУ
  if (it.autoCal && (t.classList.contains("rb-p") || t.classList.contains("rb-f") || t.classList.contains("rb-c"))) {
    it.cal = macroCal(it.p, it.f, it.c);
    const calEl = t.closest(".rb-item").querySelector(".rb-cal");
    if (calEl && calEl !== t) { calEl.value = it.cal; }
  }
  updateRecipeMath();
}

function renderRecipeTotals() {
  const el = $("#rbTotals");
  if (!el) return;
  const t = recipeTotals();
  const finVal = recipeCtx.finishedTouched ? (recipeCtx.finished || "") : (t.g ? Math.round(t.g) : "");
  el.innerHTML = `
    <div class="review-grid">
      <div class="card" id="rbSumG"><span>Ингредиенты</span><strong>—</strong></div>
      <div class="card" id="rbSumTotal"><span>КБЖУ всего блюда</span><strong>—</strong><small>—</small></div>
      <div class="card" id="rbPer100"><span>На 100 г</span><strong>—</strong><small>—</small></div>
    </div>
    <label class="field" style="margin-top:10px">Вес готового блюда, г (если при готовке вес меняется — впишите итоговый)<input id="rbFinished" type="number" min="1" step="1" value="${finVal}" placeholder="например: 450"></label>`;
  $("#rbFinished").addEventListener("input", () => {
    recipeCtx.finishedTouched = true;
    recipeCtx.finished = num($("#rbFinished").value) || null;
    updateRecipeMath();
  });
  updateRecipeMath();
}

function updateRecipeMath() {
  const gEl = $("#rbSumG"), totEl = $("#rbSumTotal"), pEl = $("#rbPer100");
  const t = recipeTotals();
  const fin = num($("#rbFinished") ? $("#rbFinished").value : 0) || t.g; // единый вес для превью и сохранения
  const k = fin ? 100 / fin : 0;
  if (gEl) gEl.innerHTML = `<span>Ингредиенты</span><strong>${Math.round(t.g)} г</strong>`;
  if (totEl) totEl.innerHTML = `<span>КБЖУ всего блюда</span><strong>${Math.round(t.cal)} ккал</strong><small>Б ${fmtNum(t.p)} · Ж ${fmtNum(t.f)} · У ${fmtNum(t.c)} г</small>`;
  if (pEl) pEl.innerHTML = `<span>На 100 г</span><strong>${Math.round(t.cal * k)} ккал</strong><small>Б ${fmtNum(t.p * k)} · Ж ${fmtNum(t.f * k)} · У ${fmtNum(t.c * k)} г</small>`;
}

function saveRecipe() {
  const name = $("#rbName").value.trim();
  if (!name) { toast("Укажите название блюда", true); return; }
  const items = recipeCtx.items.filter(it => it.name && it.name.trim() && num(it.grams) > 0);
  if (!items.length) { toast("Добавьте хотя бы один ингредиент с граммовкой", true); return; }
  const t = { g: 0, cal: 0, p: 0, f: 0, c: 0 };
  items.forEach(it => {
    const k = num(it.grams) / 100;
    t.g += num(it.grams); t.cal += num(it.cal) * k; t.p += num(it.p) * k; t.f += num(it.f) * k; t.c += num(it.c) * k;
  });
  const finished = num($("#rbFinished") ? $("#rbFinished").value : recipeCtx.finished) || t.g; // тот же вес, что в превью
  const k = 100 / finished;
  const cf = touch({
    id: recipeCtx.id || uid(), name,
    cal: round1(t.cal * k), p: round1(t.p * k), f: round1(t.f * k), c: round1(t.c * k),
    recipe: {
      totalGrams: Math.round(t.g), finishedGrams: finished, finishedAuto: !recipeCtx.finishedTouched,
      items: items.map(it => ({ name: it.name.trim(), grams: num(it.grams), cal: num(it.cal), p: num(it.p), f: num(it.f), c: num(it.c), autoCal: !!it.autoCal }))
    }
  });
  if (recipeCtx.id) data.customFoods = data.customFoods.map(x => x.id === recipeCtx.id ? cf : x);
  else data.customFoods.push(cf);
  closeModal();
  refresh();
  toast(`«${name}» сохранено в «Мои блюда» — записывайте, сколько грамм съели`);
}

function loadSamplePlans() {
  let added = 0;
  SAMPLE_PLANS.forEach(sp => {
    if (!data.plans.some(p => p.name === sp.name)) { data.plans.push({ id: uid(), name: sp.name, exercises: sp.exercises }); added++; }
  });
  refresh();
  toast(added ? `Добавлено планов: ${added}` : "Примеры уже добавлены");
}

/* ================= ПРОГРЕСС ================= */
function sortedWeights() { return [...data.weights].sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt); }

function renderProgress() {
  const weights = sortedWeights();
  const s = data.settings;

  // статистика веса
  if (weights.length) {
    const first = weights[0].kg, last = weights[weights.length - 1].kg;
    const diff = last - first;
    $("#weightStats").innerHTML = `<div class="stat-grid">
      <div class="card"><span>Было</span><strong>${first.toFixed(1)} кг</strong></div>
      <div class="card"><span>Сейчас</span><strong>${last.toFixed(1)} кг</strong></div>
      <div class="card"><span>Изменение</span><strong style="color:${diff < 0 ? "var(--green)" : diff > 0 ? "var(--danger)" : "#fff"}">${diff > 0 ? "+" : ""}${diff.toFixed(1)} кг</strong></div>
    </div>`;
  } else {
    $("#weightStats").innerHTML = `<div class="empty">Запишите вес хотя бы пару раз — появятся график и прогноз.</div>`;
  }

  // график веса (SVG)
  $("#weightChart").innerHTML = weights.length >= 2 ? weightChartSvg(weights) : "";

  // график калорий
  const days = [];
  for (let i = 13; i >= 0; i--) days.push(shiftDate(todayStr(), -i));
  const vals = days.map(d => Math.round(sum(foodsFor(d), "cal")));
  $("#calChart").innerHTML = calChartSvg(days, vals, num(s.goalCal));
  $("#goalCalLabel").textContent = num(s.goalCal) ? `${s.goalCal} ккал` : "не задана (укажи в настройках)";

  renderForecast(weights);
  renderWeekly(days, vals);

  // история веса
  const recent = [...weights].reverse().slice(0, 10);
  $("#weightList").innerHTML = recent.length ? recent.map(w => `
    <div class="item"><div class="item-main"><div class="name">${w.kg.toFixed(1)} кг</div><small>${fmtDateRu(w.date)}</small></div>
      <button class="icon-btn" data-action="delWeight" data-id="${w.id}">✕</button></div>`).join("")
    : `<div class="empty">Записей веса пока нет.</div>`;
}

function weightChartSvg(weights) {
  const w = 640, h = 200, pad = 34;
  const kg = weights.map(x => x.kg);
  let min = Math.min(...kg), max = Math.max(...kg);
  if (max - min < 1) { min -= 0.5; max += 0.5; }
  const span = max - min;
  const X = i => pad + (weights.length === 1 ? 0 : i * (w - pad * 2) / (weights.length - 1));
  const Y = v => h - pad - (v - min) / span * (h - pad * 2);
  const pts = weights.map((x, i) => `${X(i).toFixed(1)},${Y(x.kg).toFixed(1)}`).join(" ");
  const area = `${pad},${h - pad} ${pts} ${X(weights.length - 1).toFixed(1)},${h - pad}`;
  const labels = weights.length > 1 ? [0, Math.floor(weights.length / 2), weights.length - 1].map(i => `
    <text x="${X(i)}" y="${h - 10}" fill="#8ba3c4" font-size="11" text-anchor="${i === 0 ? "start" : i === weights.length - 1 ? "end" : "middle"}">${fmtDateShort(weights[i].date)}</text>`).join("") : "";
  const goal = num(data.settings.goalWeight);
  const goalLine = goal && goal >= min && goal <= max ? `<line x1="${pad}" x2="${w - pad}" y1="${Y(goal)}" y2="${Y(goal)}" stroke="#3fd08a" stroke-dasharray="5 5" stroke-width="1.5"/><text x="${w - pad}" y="${Y(goal) - 6}" fill="#3fd08a" font-size="11" text-anchor="end">цель ${goal} кг</text>` : "";
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}">
    <polyline points="${area}" fill="rgba(77,163,255,.12)" stroke="none"/>
    <line x1="${pad}" x2="${w - pad}" y1="${Y(max + span * .05)}" y2="${Y(max + span * .05)}" stroke="#1e3150"/>
    <polyline points="${pts}" fill="none" stroke="#4da3ff" stroke-width="2.5" stroke-linejoin="round"/>
    ${weights.map((x, i) => `<circle cx="${X(i)}" cy="${Y(x.kg)}" r="3.5" fill="#4da3ff"/>`).join("")}
    ${goalLine}${labels}
    <text x="${pad}" y="${Y(max) - 6}" fill="#8ba3c4" font-size="11">${max.toFixed(1)} кг</text>
    <text x="${pad}" y="${Y(min) + 16}" fill="#8ba3c4" font-size="11">${min.toFixed(1)} кг</text>
  </svg>`;
}

function calChartSvg(days, vals, goal) {
  const w = 640, h = 200, pad = 34;
  const maxV = Math.max(goal || 0, ...vals, 500);
  const bw = (w - pad * 2) / days.length * 0.62;
  const step = (w - pad * 2) / days.length;
  const Y = v => h - pad - v / maxV * (h - pad * 2);
  const goalLine = goal ? `<line x1="${pad}" x2="${w - pad}" y1="${Y(goal)}" y2="${Y(goal)}" stroke="#3fd08a" stroke-dasharray="5 5" stroke-width="1.5"/><text x="${w - pad}" y="${Y(goal) - 5}" fill="#3fd08a" font-size="11" text-anchor="end">цель</text>` : "";
  const bars = days.map((d, i) => {
    const v = vals[i];
    const x = pad + i * step + (step - bw) / 2;
    const y = Y(v);
    const col = v ? (goal && v > goal ? "#e0684f" : "#4da3ff") : "#22314e";
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${(h - pad - y).toFixed(1)}" rx="3" fill="${col}"/>`;
  }).join("");
  const labels = [0, Math.floor(days.length / 2), days.length - 1].map(i => `
    <text x="${pad + i * step + step / 2}" y="${h - 10}" fill="#8ba3c4" font-size="11" text-anchor="middle">${fmtDateShort(days[i])}</text>`).join("");
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}">${bars}${goalLine}${labels}</svg>`;
}

function renderForecast(weights) {
  const el = $("#forecastPanel");
  const s = data.settings;
  const goal = num(s.goalWeight);
  if (!goal) {
    el.innerHTML = `<div class="section-title">Прогноз достижения цели</div>
      <div class="sub">Укажите цель веса в настройках — и приложение посчитает, к какому дню вы придёте к ней с текущим темпом.</div>`;
    return;
  }
  if (weights.length < 3) {
    el.innerHTML = `<div class="section-title">Прогноз достижения цели</div>
      <div class="sub">Нужно минимум 3 записи веса (и хотя бы 1–2 недели наблюдений), чтобы построить прогноз.</div>`;
    return;
  }
  const first = weights[0], last = weights[weights.length - 1];
  const dayMs = 86400000;
  const spanDays = (new Date(last.date) - new Date(first.date)) / dayMs;
  if (spanDays < 7) {
    el.innerHTML = `<div class="section-title">Прогноз достижения цели</div>
      <div class="sub">Записывайте вес хотя бы неделю — тогда появится прогноз.</div>`;
    return;
  }
  // линейная регрессия
  const n = weights.length;
  const xs = weights.map(x => (new Date(x.date) - new Date(first.date)) / dayMs);
  const ys = weights.map(x => x.kg);
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  const slope = xs.reduce((s2, x, i) => s2 + (x - mx) * (ys[i] - my), 0) / xs.reduce((s2, x) => s2 + (x - mx) ** 2, 0);
  const cur = last.kg;
  const diff = cur - goal;
  const perWeek = slope * 7;
  const stale = (Date.now() - new Date(last.date).getTime()) > 14 * 86400000;
  const staleNote = stale ? " Последняя запись веса старше двух недель — обновите её для точного прогноза." : "";
  let html = `<div class="section-title">Прогноз достижения цели</div>`;
  if (Math.abs(diff) <= 0.3) {
    html += `<div class="big">Цель практически достигнута</div><div class="sub">Текущий вес ${cur.toFixed(1)} кг при цели ${goal} кг. Отличная работа — осталось удерживать результат.</div>`;
  } else if (Math.abs(slope) < 0.004) {
    html += `<div class="big">Вес держится на месте</div><div class="sub">Темп: ${fmtNum(Math.abs(perWeek))} кг в неделю. Чтобы двигаться к цели ${goal} кг, скорректируйте питание или активность.${staleNote}</div>`;
  } else if ((diff > 0 && slope > 0) || (diff < 0 && slope < 0)) {
    const dir = diff > 0 ? "растёт" : "снижается";
    const need = diff > 0 ? "снизить" : "набрать";
    html += `<div class="big">Сейчас вес ${dir}</div><div class="sub">Цель — ${goal} кг, тренд ${fmtNum(Math.abs(perWeek))} кг в неделю. Чтобы ${need} вес, темп нужно развернуть.${staleNote}</div>`;
  } else {
    const daysToGoal = Math.abs(diff / slope);
    if (daysToGoal > 730) {
      html += `<div class="big">Цель достижима, но не скоро</div><div class="sub">С текущим темпом (${fmtNum(Math.abs(perWeek))} кг в неделю) до цели ${goal} кг уйдёт больше двух лет — чуть скорректируйте план, и получится быстрее.${staleNote}</div>`;
    } else {
      const target = new Date(); target.setDate(target.getDate() + Math.round(daysToGoal));
      html += `<div class="big">С таким темпом вы достигнете цели ${goal} кг к ${fmtDateRu(target.toISOString().slice(0, 10))}</div>
        <div class="sub">Темп: ${fmtNum(Math.abs(perWeek))} кг в неделю. Прогноз приблизительный: он просто продлевает текущую динамику вперёд.${staleNote}</div>`;
    }
  }
  el.innerHTML = html;
}

function renderWeekly(days, vals) {
  const last7 = days.slice(-7), cal7 = vals.slice(-7);
  const withEntries = cal7.filter(v => v > 0);
  const avgCal = withEntries.length ? Math.round(withEntries.reduce((a, b) => a + b, 0) / withEntries.length) : 0;
  const weekFoods = last7.reduce((acc, d) => acc.concat(foodsFor(d)), []);
  const avgP = withEntries.length ? sum(weekFoods, "p") / withEntries.length : 0;
  const avgF = withEntries.length ? sum(weekFoods, "f") / withEntries.length : 0;
  const avgC = withEntries.length ? sum(weekFoods, "c") / withEntries.length : 0;
  const wkouts = last7.reduce((acc, d) => acc.concat(data.workouts.filter(w => w.date === d)), []);
  const wkMin = sum(wkouts, "minutes");
  const waterAvg = Math.round(last7.reduce((s, d) => s + (data.water[d] ? data.water[d].ml : 0), 0) / 7);
  // вес за неделю
  const weights = sortedWeights();
  let wDiff = null;
  if (weights.length >= 2) {
    const now = weights[weights.length - 1];
    const weekAgo = [...weights].reverse().find(x => x.date <= shiftDate(todayStr(), -7)) || weights[0];
    if (weekAgo && weekAgo.date !== now.date) wDiff = now.kg - weekAgo.kg;
  }
  // серия дней с записями
  let streak = 0;
  for (let i = 0; ; i++) {
    const d = shiftDate(todayStr(), -i);
    if (foodsFor(d).length || data.workouts.some(w => w.date === d)) streak++;
    else if (i === 0) continue; else break;
    if (i > 365) break;
  }
  $("#weeklyReview").innerHTML = `<div class="review-grid">
    <div class="card"><span>Средние калории</span><strong>${avgCal} ккал/день</strong></div>
    <div class="card"><span>Б / Ж / У в среднем</span><strong>${fmtNum(avgP)} / ${fmtNum(avgF)} / ${fmtNum(avgC)} г</strong></div>
    <div class="card"><span>Тренировки</span><strong>${wkouts.length} шт · ${wkMin} мин</strong></div>
    <div class="card"><span>Вода</span><strong>${waterAvg} мл/день</strong></div>
    <div class="card"><span>Вес за неделю</span><strong>${wDiff == null ? "—" : (wDiff > 0 ? "+" : "") + wDiff.toFixed(1) + " кг"}</strong></div>
    <div class="card"><span>Серия дней</span><strong>${streak} ${plural(streak, "день", "дня", "дней")} 🔥</strong></div>
  </div>`;
}

/* ================= ПЛАН ПИТАНИЯ ================= */
function renderMealPlan() {
  $("#dateInputP").value = selectedDate;
  const items = data.mealPlan[selectedDate] || [];
  const cal = sum(items, "cal"), p = sum(items, "p"), f = sum(items, "f"), c = sum(items, "c");
  const goal = num(data.settings.goalCal);
  $("#mealPlanSummary").innerHTML = `<div class="summary" style="grid-template-columns:repeat(4,1fr)">
    <div class="card accent"><span>Запланировано</span><strong>${Math.round(cal)} ккал</strong><small>${goal ? Math.round(cal / goal * 100) + "% от цели" : "цель не задана"}</small></div>
    <div class="card"><span>Белки</span><strong>${fmtNum(p)} г</strong></div>
    <div class="card"><span>Жиры</span><strong>${fmtNum(f)} г</strong></div>
    <div class="card"><span>Углеводы</span><strong>${fmtNum(c)} г</strong></div>
  </div>`;

  const names = data.settings.mealNames.length ? data.settings.mealNames : ["Завтрак", "Обед", "Ужин", "Перекус"];
  $("#mealPlanSections").innerHTML = names.map(meal => {
    const mi = items.filter(x => x.meal === meal);
    return `<div class="meal-block">
      <div class="meal-head"><b>${esc(meal)}</b><span class="meal-kcal">${Math.round(sum(mi, "cal"))} ккал</span></div>
      <div class="meal-body">
        ${mi.length ? mi.map(item => `
          <div class="item"><div class="item-main"><div class="name">${esc(item.name)}</div><small>${item.grams ? item.grams + " г · " : ""}Б: ${fmtNum(item.p)} · Ж: ${fmtNum(item.f)} · У: ${fmtNum(item.c)}</small></div>
            <div class="item-right"><span class="kcal">${Math.round(num(item.cal))} ккал</span><button class="icon-btn" data-action="delPlanItem" data-id="${item.id}">✕</button></div></div>`).join("")
          : `<div class="empty">Не запланировано.</div>`}
        <div class="meal-actions"><button class="small primary" data-action="addFood" data-meal="${esc(meal)}" data-target="plan">＋ Блюдо в план</button></div>
      </div>
    </div>`;
  }).join("");
}

function copyPlanToDiary() {
  const items = data.mealPlan[selectedDate] || [];
  if (!items.length) { toast("План на этот день пуст", true); return; }
  items.forEach(it => data.foods.push({ ...it, id: uid() }));
  refresh();
  toast(`Скопировано в дневник: ${items.length} ${plural(items.length, "блюдо", "блюда", "блюд")}`);
}

function applyTemplate(kind) {
  const t = MEAL_TEMPLATES[kind];
  data.mealPlan[selectedDate] = t.items.map(x => {
    const db = FOOD_DB.find(f => f.name === x.name) || { cal: 0, p: 0, f: 0, c: 0 };
    const k = x.grams / 100;
    return { id: uid(), date: selectedDate, meal: x.meal, name: x.name, grams: x.grams, cal: Math.round(db.cal * k), p: Math.round(db.p * k * 10) / 10, f: Math.round(db.f * k * 10) / 10, c: Math.round(db.c * k * 10) / 10 };
  });
  refresh();
  toast(`Применён пример меню: ${t.title} (не рекомендация врача)`);
}

/* ================= НАСТРОЙКИ ================= */
function renderSettings() {
  const s = data.settings;
  // цели
  const gf = $("[data-form=goals]");
  if (gf && document.activeElement && gf.contains(document.activeElement)) { /* не перезаписываем во время ввода */ }
  else {
    gf.querySelector("[name=goalCal]").value = s.goalCal || "";
    gf.querySelector("[name=goalP]").value = s.goalP || "";
    gf.querySelector("[name=goalF]").value = s.goalF || "";
    gf.querySelector("[name=goalC]").value = s.goalC || "";
    gf.querySelector("[name=waterGoal]").value = s.waterGoal || "";
    gf.querySelector("[name=goalWeight]").value = s.goalWeight || "";
  }
  // приёмы пищи
  $("#mealChips").innerHTML = s.mealNames.map((n, i) => `<span class="chip">${esc(n)}<button data-action="delMealName" data-i="${i}" title="Удалить">✕</button></span>`).join("");
  // синхронизация
  renderSyncSection();
  // ИИ
  const af = $("[data-form=ai]");
  if (!(document.activeElement && af.contains(document.activeElement))) {
    af.querySelector("[name=geminiKey]").value = "";
    af.querySelector("[name=geminiKey]").placeholder = s.geminiKey ? "сохранён (введите новый, чтобы заменить)" : "AIza...";
    af.querySelector("[name=aiModel]").value = s.aiModel || "gemini-2.5-flash";
  }
  renderInstallGuide();
}

function renderSyncSection() {
  const el = $("#syncSection");
  if (!el) return;
  const s = data.settings;
  if (!s.firebaseConfig) {
    el.innerHTML = `
      <label class="field">Конфигурация Firebase (firebaseConfig)<textarea id="fbConfig" placeholder='{"apiKey":"...","authDomain":"...","projectId":"...","appId":"..."}' style="min-height:90px;font-family:monospace;font-size:12px"></textarea></label>
      <div class="btn-row"><button data-action="saveFbConfig">Сохранить конфиг</button></div>
      <p class="hint">Инструкция — ниже в пункте «Как настроить».</p>`;
    return;
  }
  const user = fbUser;
  if (!user) {
    el.innerHTML = `
      <div class="sync-status"><span class="sync-dot"></span> Конфиг сохранён. Войдите, чтобы включить синхронизацию.</div>
      <div class="btn-row"><button data-action="emailLogin">Войти по почте (проще всего)</button></div>
      <div class="btn-row"><button class="ghost" data-action="googleLogin">Или через Google</button></div>
      <div class="btn-row"><button class="ghost small" data-action="resetFbConfig">Сбросить конфиг</button></div>`;
    return;
  }
  el.innerHTML = `
    <div class="user-badge"><img src="${esc(user.photoURL || "")}" alt="" onerror="this.style.display='none'"><div><b style="font-size:14px">${esc(user.displayName || "Пользователь")}</b><div class="ub-mail">${esc(user.email)}</div></div></div>
    <div class="sync-status"><span class="sync-dot${syncState.ok ? " on" : syncState.err ? " err" : ""}"></span> ${esc(syncState.msg)}</div>
    <div class="btn-row">
      <button data-action="syncPush">Сохранить в облако</button>
      <button class="ghost" data-action="syncPull">Загрузить из облака</button>
    </div>
    <label class="field" style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-direction:row"><input type="checkbox" data-action="autoSyncChk" style="width:18px;min-height:0" ${s.autoSync ? "checked" : ""}> Автосинхронизация при изменениях</label>
    <div class="btn-row"><button class="danger small" data-action="googleLogout">Выйти из аккаунта</button></div>`;
}

function renderInstallGuide() {
  const el = $("#installGuide");
  if (!el) return;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  el.innerHTML = `
    <p class="hint" style="margin:0 0 10px">Приложение работает офлайн и устанавливается на телефон как обычное приложение (PWA). Данные хранятся на устройстве.</p>
    ${installPromptEvent ? `<div class="btn-row" style="margin-top:0"><button data-action="installPwa">Установить приложение</button></div>` : ""}
    ${isIOS ? `<p class="hint"><b>iPhone:</b> откройте сайт в Safari → кнопка «Поделиться» (квадрат со стрелкой) → «На экран “Домой”».</p>
      <p class="hint"><b>Android:</b> в Chrome → меню (⋮) → «Установить приложение» / «Добавить на главный экран».</p>`
    : `<p class="hint"><b>Android:</b> в Chrome → меню (⋮) → «Установить приложение» / «Добавить на главный экран». <b>Компьютер:</b> значок установки в адресной строке.</p>`}`;
}

/* ================= FIREBASE СИНХРОНИЗАЦИЯ ================= */
let fbApp = null, fbAuth = null, fbDb = null, fbUser = null;
let syncState = { ok: false, err: false, msg: "Готово к синхронизации" };
let fbModules = null;

async function initFirebase(quiet) {
  const cfgText = data.settings.firebaseConfig;
  if (!cfgText) return;
  let cfg;
  const cfgSource = cfgText || (typeof window.FB_CONFIG === "object" ? window.FB_CONFIG : null);
  if (!cfgSource) return;
  try { cfg = typeof cfgSource === "string" ? JSON.parse(cfgSource) : cfgSource; }
  catch { if (!quiet) toast("Конфиг Firebase повреждён — вставьте заново", true); return; }
  try {
    if (!fbModules) {
      const base = "https://www.gstatic.com/firebasejs/10.12.2/";
      const [appMod, authMod, dbMod] = await Promise.all([
        import(base + "firebase-app.js"),
        import(base + "firebase-auth.js"),
        import(base + "firebase-firestore.js")
      ]);
      fbModules = { appMod, authMod, dbMod };
    }
    const { appMod, authMod, dbMod } = fbModules;
    if (!fbApp) {
      fbApp = appMod.initializeApp(cfg);
      fbAuth = authMod.getAuth(fbApp);
      fbDb = dbMod.getFirestore(fbApp);
      authMod.onAuthStateChanged(fbAuth, async u => {
        const prev = fbUser;
        fbUser = u;
        if (u) {
          // вход: переключаемся на аккаунтное хранилище, тянем облако, объединяем
          const guestRaw = store.getItem(STORAGE_KEY);
          const guestData = guestRaw ? JSON.parse(guestRaw) : null;
          ACCOUNT_KEY = "healthDiary.v2:" + u.uid;
          const localRaw = store.getItem(ACCOUNT_KEY);
          data = loadData();
          if (localRaw) { await syncPull(true); }
          else if (guestData && (guestData.foods || []).length) {
            // первое вход на устройстве: миграция гостевых данных в аккаунт
            mergeCloud(guestData);
            persist();
            await syncPull(true);
            toast("Локальные записи перенесены в аккаунт");
          } else {
            await syncPull(true);
          }
          renderAll();
        } else if (prev) {
          // выход: возвращаемся к гостевому хранилищу
          ACCOUNT_KEY = null;
          data = loadData();
          renderAll();
        }
        renderSyncSection();
      });
    }
  } catch (e) {
    syncState = { ok: false, err: true, msg: "Ошибка Firebase: " + e.message };
    renderSyncSection();
  }
}

function authErrText(code) {
  const map = {
    "auth/invalid-credential": "Неверная почта или пароль",
    "auth/wrong-password": "Неверная почта или пароль",
    "auth/user-not-found": "Аккаунт с такой почтой не найден — зарегистрируйтесь",
    "auth/email-already-in-use": "Аккаунт с такой почтой уже есть — войдите",
    "auth/weak-password": "Пароль слишком короткий (минимум 6 символов)",
    "auth/invalid-email": "Некорректная почта",
    "auth/too-many-requests": "Слишком много попыток — подождите минуту",
    "auth/api-key-not-valid.-please-pass-a-valid-api-key": "Неверный конфиг Firebase — пройдите шаги инструкции заново",
    "auth/network-request-failed": "Нет соединения — проверьте интернет",
    "auth/operation-not-allowed": "В Firebase не включён вход Email/Password — см. шаг 2 инструкции"
  };
  if (map[code]) return map[code];
  if (/api-key/.test(code)) return "Неверный конфиг Firebase — пройдите шаги инструкции заново";
  return code;
}
function openEmailAuth() {
  openModal(`
    <div class="modal-head"><h3>Вход по почте</h3><button class="close-x" data-action="closeModal">✕</button></div>
    <p class="hint" style="margin:0 0 10px">Регистрация прямо в приложении. Почта нужна только как имя аккаунта — никаких писем не приходит.</p>
    <label class="field">Почта<input id="eaEmail" type="email" placeholder="vasha.pochta@gmail.com" autocomplete="email"></label>
    <label class="field" style="margin-top:8px">Пароль (минимум 6 символов)<input id="eaPass" type="password" placeholder="••••••" autocomplete="current-password"></label>
    <div class="btn-row">
      <button data-action="emailSignIn">Войти</button>
      <button class="ghost" data-action="emailSignUp">Создать аккаунт</button>
    </div>
    <div id="eaErr" class="hint" style="color:var(--danger)"></div>
  `, { center: true });
  $("#eaPass").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); emailSignIn(); } });
}
async function emailSignIn() {
  if (!fbAuth) { await initFirebase(); if (!fbAuth) { $("#eaErr").textContent = "Сначала сохраните конфиг Firebase в настройках"; return; } }
  const email = $("#eaEmail").value.trim(), pass = $("#eaPass").value;
  try {
    await fbModules.authMod.signInWithEmailAndPassword(fbAuth, email, pass);
    closeModal();
  } catch (e) { $("#eaErr").textContent = authErrText(e.code || e.message); }
}
async function emailSignUp() {
  if (!fbAuth) { await initFirebase(); if (!fbAuth) { $("#eaErr").textContent = "Сначала сохраните конфиг Firebase в настройках"; return; } }
  const email = $("#eaEmail").value.trim(), pass = $("#eaPass").value;
  if (pass.length < 6) { $("#eaErr").textContent = "Пароль слишком короткий (минимум 6 символов)"; return; }
  try {
    await fbModules.authMod.createUserWithEmailAndPassword(fbAuth, email, pass);
    closeModal();
    toast("Аккаунт создан");
  } catch (e) { $("#eaErr").textContent = authErrText(e.code || e.message); }
}
async function googleLogin() {
  if (!fbAuth) { await initFirebase(); if (!fbAuth) { toast("Сначала сохраните корректный конфиг Firebase", true); return; } }
  const provider = new fbModules.authMod.GoogleAuthProvider();
  try {
    await fbModules.authMod.signInWithPopup(fbAuth, provider);
    toast("Вы вошли через Google");
  } catch (e) {
    if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") {
      try { await fbModules.authMod.signInWithRedirect(fbAuth, provider); } catch (e2) { toast("Вход не удался: " + e2.message, true); }
    } else toast("Вход не удался: " + (e.code || e.message), true);
  }
}
async function googleLogout() {
  if (fbAuth) await fbAuth.signOut();
  fbUser = null;
  renderSyncSection();
}

function mergeCloud(cloud) {
  // слияние по id: новее побеждает; удаления (tombstones) применяются
  const dels = Object.assign({}, cloud.del || {});
  const newer = (a, b) => ((b && b.u) || 0) > ((a && a.u) || 0) ? b : a;
  const mergeArr = (a, b) => {
    const map = new Map();
    for (const x of a) if (x && x.id) map.set(x.id, x);
    for (const x of b || []) if (x && x.id) map.set(x.id, newer(map.get(x.id), x));
    let out = [...map.values()];
    if (Object.keys(dels).length) out = out.filter(x => !dels[x.id] || (x.u || 0) > dels[x.id]);
    return out;
  };
  data.foods = mergeArr(data.foods, cloud.foods || []);
  data.weights = mergeArr(data.weights, cloud.weights || []);
  data.workouts = mergeArr(data.workouts, cloud.workouts || []);
  data.customFoods = mergeArr(data.customFoods, cloud.customFoods || []);
  data.plans = mergeArr(data.plans, cloud.plans || []);
  data.mealPlan = data.mealPlan || {};
  for (const [d, items] of Object.entries(cloud.mealPlan || {})) {
    data.mealPlan[d] = mergeArr(data.mealPlan[d] || [], items);
  }
  data.water = normalizeWater(data.water);
  for (const [d, w] of Object.entries(cloud.water || {})) {
    const cw = w && typeof w === "object" ? w : { ml: +w || 0, u: 0 };
    const lw = data.water[d] || { ml: 0, u: 0 };
    data.water[d] = cw.u > lw.u ? cw : lw;
    if (dels["water:" + d] && (data.water[d].u || 0) <= dels["water:" + d]) delete data.water[d];
  }
  if (cloud.settings) {
    const cs = { ...cloud.settings };
    delete cs.openaiKey; delete cs.firebaseConfig; // секреты не синхронизируем
    for (const k of Object.keys(cs)) {
      const lv = data.settings[k], cv = cs[k];
      const isUndef = lv === undefined || lv === null || lv === "" || (Array.isArray(lv) && !lv.length);
      if (isUndef && cv !== undefined) data.settings[k] = cv;
    }
  }
  purgeTombstones();
}

async function syncPush(silent) {
  if (!fbUser || !fbDb) return;
  syncState = { ok: false, err: false, msg: "Сохранение в облако…" };
  renderSyncSection();
  try {
    const { doc, setDoc } = fbModules.dbMod;
    const payload = JSON.parse(JSON.stringify(data));
    payload.settings = { ...payload.settings, geminiKey: "", openaiKey: "", firebaseConfig: "" }; // секреты не покидают устройство
    await setDoc(doc(fbDb, "users", fbUser.uid), { data: JSON.stringify(payload), syncedAt: Date.now() });
    syncState = { ok: true, err: false, msg: "Синхронизировано " + new Date().toLocaleTimeString("ru-RU") };
    renderSyncSection();
    if (!silent) toast("Сохранено в облако");
  } catch (e) {
    syncState = { ok: false, err: true, msg: "Ошибка: " + e.message };
    renderSyncSection();
    if (!silent) toast("Ошибка сохранения: " + e.message, true);
  }
}

async function syncPull(silent) {
  if (!fbUser || !fbDb) return;
  syncState = { ok: false, err: false, msg: "Загрузка из облака…" };
  renderSyncSection();
  try {
    const { doc, getDoc } = fbModules.dbMod;
    const snap = await getDoc(doc(fbDb, "users", fbUser.uid));
    if (!snap.exists()) { toast("В облаке пока ничего нет — нажмите «Сохранить в облако»", true); syncState = { ok: true, err: false, msg: "В облаке пусто" }; renderSyncSection(); return; }
    const cloud = JSON.parse(snap.data().data);
    mergeCloud(cloud);
    persist();
    renderAll();
    syncState = { ok: true, err: false, msg: "Загружено " + new Date().toLocaleTimeString("ru-RU") };
    renderSyncSection();
    toast("Загружено из облака (данные объединены)");
  } catch (e) {
    syncState = { ok: false, err: true, msg: "Ошибка: " + e.message };
    renderSyncSection();
    if (!silent) toast("Ошибка загрузки: " + e.message, true);
  }
}

function scheduleAutoSync() {
  if (!data.settings.autoSync || !fbUser) return;
  clearTimeout(pendingSaveSync);
  pendingSaveSync = setTimeout(() => syncPush(true), 3000);
}

/* ================= ДЕЙСТВИЯ ================= */
const actions = {
  prevDay: () => { selectedDate = shiftDate(selectedDate, -1); renderAll(); },
  nextDay: () => { selectedDate = shiftDate(selectedDate, 1); renderAll(); },
  today: () => { selectedDate = todayStr(); renderAll(); },
  addFood: (el) => { openFoodSearch(el.dataset.meal || "Обед", el.dataset.target === "plan" ? "plan" : "diary"); },
  manualEntry: () => showAddManually(),
  photoFood: () => { openFoodSearch(null); renderFoodSearch("photo"); },
  voiceFood: () => openVoice(),
  barcodeFood: () => { openFoodSearch(null); renderFoodSearch("barcode"); },
  closeModal: () => closeModal(),
  restToggle: () => restToggle(),
  restReset: () => restReset(),
  backToSearch: () => openFoodSearch(foodSearchCtx.meal, foodSearchCtx.target),
  pickFood: (el) => { openPortionEditor(JSON.parse(el.dataset.json)); },
  confirmPortion: (el) => confirmPortion(JSON.parse(el.dataset.item)),
  editFood: (el) => editFood(el.dataset.id),
  saveEditFood: (el) => saveEditFood(el.dataset.id),
  saveManualFood: () => saveManualFood(),
  delFood: (el) => { data.foods = data.foods.filter(x => x.id !== el.dataset.id); tombstone(el.dataset.id); refresh(); },
  delWorkout: (el) => { data.workouts = data.workouts.filter(x => x.id !== el.dataset.id); tombstone(el.dataset.id); refresh(); },
  delWeight: (el) => { data.weights = data.weights.filter(x => x.id !== el.dataset.id); tombstone(el.dataset.id); refresh(); },
  waterAdd: (el) => {
    const ml = +el.dataset.ml;
    const cur = data.water[selectedDate] ? data.water[selectedDate].ml : 0;
    const mlNew = Math.max(0, cur + ml);
    data.water[selectedDate] = { ml: mlNew, u: Date.now() };
    persist(); renderDiary();
  },
  copyYesterday: () => copyYesterday(),
  showAddManually: () => showAddManually(),
  saveMealAsDish: (el) => saveMealAsDish(el.dataset.meal),
  newCustomFood: () => newCustomFood(),
  saveCustomFood: (el) => saveCustomFood(el.dataset.id || ""),
  lookupBarcode: () => doBarcodeLookup($("#barcodeInput").value.trim()),
  startScan: () => startScan(),
  pickPhoto: () => $("#photoFile").click(),
  recognizePhoto: () => recognizePhoto(),
  addPhotoItems: () => addPhotoItems(),
  toggleMic: () => { },
  searchVoiceItem: (el) => searchVoiceItem(+el.dataset.i),
  addVoiceItems: () => addVoiceItems(),
  newPlan: () => openPlanEditor(null),
  editPlan: (el) => openPlanEditor(data.plans.find(p => p.id === el.dataset.id)),
  delPlan: (el) => {
    const p = data.plans.find(x => x.id === el.dataset.id);
    if (p && confirm(`Удалить план «${p.name}»?`)) { data.plans = data.plans.filter(x => x.id !== el.dataset.id); tombstone(el.dataset.id); refresh(); }
  },
  startPlan: (el) => openTrainingSession(el.dataset.id),
  resumeWorkout: (el) => renderTrainingSession(el.dataset.id),
  addSet: (el) => addSetBtn(el.dataset.id, +el.dataset.i),
  delSet: (el) => {
    const w = data.workouts.find(x => x.id === el.dataset.id);
    if (w && w.exercises && w.exercises[+el.dataset.i]) {
      w.exercises[+el.dataset.i].sets.splice(+el.dataset.j, 1);
      touch(w); persist(); renderTrainingSession(w.id);
    }
  },
  delSessionEx: (el) => {
    const w = data.workouts.find(x => x.id === el.dataset.id);
    if (w && w.exercises && w.exercises[+el.dataset.i]) {
      w.exercises.splice(+el.dataset.i, 1);
      touch(w); persist(); renderTrainingSession(w.id);
    }
  },
  addSessionEx: (el) => {
    const name = prompt("Название упражнения:");
    if (!name || !name.trim()) return;
    const w = data.workouts.find(x => x.id === el.dataset.id);
    if (!w) return;
    w.exercises = workoutExercises(w);
    w.exercises.push({ name: name.trim(), sets: [] });
    touch(w); persist(); renderTrainingSession(w.id);
  },
  finishWorkout: (el) => finishWorkout(el.dataset.id),
  closeSession: () => { restReset(); closeModal(); renderWorkouts(); },
  newRecipe: () => openRecipeBuilder(null),
  editRecipe: (el) => openRecipeBuilder(data.customFoods.find(c => c.id === el.dataset.id)),
  editCustomFood: (el) => newCustomFood(data.customFoods.find(c => c.id === el.dataset.id)),
  delCustomFood: (el) => {
    const c = data.customFoods.find(x => x.id === el.dataset.id);
    if (!c) return;
    if (!confirm(`Удалить блюдо «${c.name}» из «Моих блюд»? Записи в дневнике за прошлые дни останутся.`)) return;
    data.customFoods = data.customFoods.filter(x => x.id !== c.id);
    tombstone(c.id);
    refresh();
    if ($("#customList")) renderFoodSearch("custom");
  },
  recipePick: (el) => {
    const x = JSON.parse(el.dataset.json);
    recipeCtx.items.push({ name: x.name, grams: 100, cal: num(x.cal), p: num(x.p), f: num(x.f), c: num(x.c), autoCal: false });
    renderRecipeItems();
  },
  recipeAddManual: () => {
    recipeCtx.items.push({ name: "", grams: 100, cal: 0, p: 0, f: 0, c: 0, autoCal: true });
    renderRecipeItems();
  },
  recipeDelItem: (el) => {
    recipeCtx.items.splice(+el.dataset.i, 1);
    renderRecipeItems();
  },
  saveRecipe: () => saveRecipe(),
  loadSamplePlans: () => loadSamplePlans(),
  addWeightNow: () => { switchTab("diary"); setTimeout(() => $("[data-form=weight] input").focus(), 100); },
  gotoProgress: () => switchTab("progress"),
  copyPlanToDiary: () => copyPlanToDiary(),
  applyBalanced: () => applyTemplate("balanced"),
  applyProtein: () => applyTemplate("protein"),
  clearPlan: () => {
    if (!confirm("Очистить план питания на этот день?")) return;
    delete data.mealPlan[selectedDate]; refresh();
  },
  delPlanItem: (el) => {
    data.mealPlan[selectedDate] = (data.mealPlan[selectedDate] || []).filter(x => x.id !== el.dataset.id);
    tombstone(el.dataset.id);
    refresh();
  },
  delMealName: (el) => {
    if (data.settings.mealNames.length <= 1) { toast("Должен остаться хотя бы один приём пищи", true); return; }
    const i = +el.dataset.i;
    const name = data.settings.mealNames[i];
    const rest = data.settings.mealNames.filter((_, j) => j !== i);
    const affected = data.foods.filter(f => f.meal === name).length + (data.mealPlan[selectedDate] || []).filter(f => f.meal === name).length;
    if (affected && !confirm(`У приёма «${name}» есть записи (${affected}). Перенести их на «${rest[0]}»?`)) return;
    if (affected) {
      data.foods.forEach(f => { if (f.meal === name) { f.meal = rest[0]; touch(f); } });
      Object.values(data.mealPlan).forEach(items => items.forEach(f => { if (f.meal === name) { f.meal = rest[0]; touch(f); } }));
    }
    data.settings.mealNames.splice(i, 1);
    refresh();
  },
  saveFbConfig: async () => {
    const raw = $("#fbConfig").value.trim();
    try { JSON.parse(raw); } catch { toast("Это не похоже на конфиг — вставьте объект firebaseConfig целиком", true); return; }
    data.settings.firebaseConfig = raw;
    persist();
    await initFirebase();
    if (fbAuth) renderSyncSection();
    toast("Конфиг Firebase сохранён");
  },
  resetFbConfig: () => { data.settings.firebaseConfig = ""; persist(); renderSyncSection(); },
  googleLogin: () => googleLogin(),
  emailLogin: () => openEmailAuth(),
  emailSignIn: () => emailSignIn(),
  emailSignUp: () => emailSignUp(),
  googleLogout: () => googleLogout(),
  syncPush: () => syncPush(false),
  syncPull: () => syncPull(),
  installPwa: async () => {
    if (installPromptEvent) { installPromptEvent.prompt(); const r = await installPromptEvent.userChoice; if (r.outcome === "accepted") toast("Устанавливаем…"); }
  },
  exportData: () => {
    const payload = JSON.parse(JSON.stringify(data));
    payload.settings = { ...payload.settings, geminiKey: "", openaiKey: "", firebaseConfig: "" }; // ключи в экспорт не включаем
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `dnevnik-zdorovia-${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast("Файл с данными скачан");
  },
  importData: () => {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = ".json,application/json";
    inp.onchange = () => {
      const file = inp.files[0]; if (!file) return;
      const r = new FileReader();
      r.onload = () => {
        try {
          const imported = JSON.parse(r.result);
          if (!imported || typeof imported !== "object" || !("foods" in imported)) throw new Error("format");
          mergeCloud(imported);
          persist(); renderAll();
          toast("Данные импортированы");
        } catch { toast("Не удалось прочитать файл — это экспорт этого приложения?", true); }
      };
      r.readAsText(file);
    };
    inp.click();
  },
  clearData: () => {
    if (!confirm("Удалить ВСЕ данные (еда, вес, тренировки, планы)? Это необратимо.")) return;
    if (!confirm("Точно? Рекомендуем сначала сделать экспорт.")) return;
    data = defaultData();
    persist(); renderAll();
    toast("Все данные удалены");
  }
};

document.addEventListener("click", e => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const fn = actions[btn.dataset.action];
  if (fn) { e.preventDefault(); fn(btn, e); }
});

// чекбокс автосинхронизации (не кнопка)
document.addEventListener("change", e => {
  if (e.target.matches("[data-action=autoSyncChk]")) {
    data.settings.autoSync = e.target.checked;
    persist();
  }
});

// автопересчёт калорий по БЖУ в строках фото/голоса
 document.addEventListener("input", e => {
  const t = e.target;
  if (!t.classList) return;
  const pre = (t.classList.contains("ph-p") || t.classList.contains("ph-f") || t.classList.contains("ph-c")) ? "ph"
    : (t.classList.contains("vi-p") || t.classList.contains("vi-f") || t.classList.contains("vi-c")) ? "vi" : null;
  if (!pre || t.dataset.i == null) return;
  const i = t.dataset.i;
  const cal = document.querySelector(`.${pre}-cal[data-i="${i}"]`);
  const p = document.querySelector(`.${pre}-p[data-i="${i}"]`);
  const f = document.querySelector(`.${pre}-f[data-i="${i}"]`);
  const c = document.querySelector(`.${pre}-c[data-i="${i}"]`);
  if (cal && p && f && c) cal.value = macroCal(p.value, f.value, c.value);
});

/* формы */
document.addEventListener("submit", e => {
  const form = e.target.closest("form[data-form]");
  if (!form) return;
  e.preventDefault();
  const fd = new FormData(form);
  switch (form.dataset.form) {
    case "weight": {
      const kg = num(fd.get("kg"));
      if (!kg) { toast("Укажите вес в килограммах", true); return; }
      data.weights = data.weights.filter(w => w.date !== selectedDate);
      data.weights.push(touch({ id: uid(), date: selectedDate, kg, createdAt: Date.now() }));
      form.reset();
      refresh();
      toast("Вес сохранён");
      break;
    }
    case "workout": {
      const name = (fd.get("name") || "").trim();
      if (!name) { toast("Укажите название тренировки", true); return; }
      data.workouts.push(touch({ id: uid(), date: selectedDate, name, minutes: num(fd.get("minutes")), cal: num(fd.get("calories")), details: (fd.get("details") || "").trim() }));
      form.reset();
      refresh();
      toast("Тренировка добавлена");
      break;
    }
    case "goals": {
      data.settings.goalCal = num(fd.get("goalCal"));
      data.settings.goalP = num(fd.get("goalP"));
      data.settings.goalF = num(fd.get("goalF"));
      data.settings.goalC = num(fd.get("goalC"));
      data.settings.waterGoal = num(fd.get("waterGoal")) || 2000;
      data.settings.goalWeight = num(fd.get("goalWeight")) || null;
      refresh();
      toast("Цели сохранены");
      break;
    }
    case "addMealName": {
      const n = (fd.get("mealName") || "").trim();
      if (!n) return;
      if (data.settings.mealNames.length >= 10) { toast("Максимум 10 приёмов пищи", true); return; }
      data.settings.mealNames.push(n);
      form.reset();
      refresh();
      break;
    }
    case "ai": {
      const key = (fd.get("geminiKey") || "").trim();
      if (key) data.settings.geminiKey = key;
      data.settings.aiModel = (fd.get("aiModel") || "gemini-2.5-flash").trim();
      refresh();
      toast("Настройки ИИ сохранены");
      break;
    }
  }
});

// переключение вкладок
$$(".tabbar button").forEach(b => b.addEventListener("click", () => switchTab(b.dataset.tab)));

// даты
["dateInput", "dateInputW", "dateInputP"].forEach(id => {
  const el = document.getElementById(id);
  el.addEventListener("change", () => { selectedDate = el.value || todayStr(); renderAll(); });
});

/* ================= PWA ================= */
let installPromptEvent = null;
window.addEventListener("beforeinstallprompt", e => {
  e.preventDefault();
  installPromptEvent = e;
  const btn = $("#installBtn");
  if (btn) btn.hidden = false;
  renderInstallGuide();
});
document.getElementById("installBtn").addEventListener("click", () => {
  if (installPromptEvent) installPromptEvent.prompt().catch(() => {});
});
window.addEventListener("appinstalled", () => {
  $("#installBtn").hidden = true;
  installPromptEvent = null;
  toast("Приложение установлено");
});

try {
  if (navigator.serviceWorker) {
    window.addEventListener("load", () => {
      try { navigator.serviceWorker.register("sw.js").catch(() => { /* офлайн недоступен — ок */ }); } catch { /* песочница — ок */ }
    });
    // при обновлении service worker перезагружаем страницу один раз, чтобы не застревать на старой версии
    let swReloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (swReloaded) return;
      swReloaded = true;
      window.location.reload();
    });
  }
} catch { /* песочница предпросмотра: service worker недоступен — ок */ }

/* индикатор сети */
function updateSyncDot() {
  const dot = $("#syncDot");
  if (!dot) return;
  if (fbUser) dot.className = "sync-dot" + (syncState.ok ? " on" : syncState.err ? " err" : "");
  else dot.className = "sync-dot";
}
const _origRenderSync = renderSyncSection;
renderSyncSection = function () { _origRenderSync(); updateSyncDot(); };

/* ================= API ЧАТ ================= */
/* Прокси для API, которые запрещают вызовы из браузера (CORS) */
const API_PROXY = (() => {
  const raw = window.__API_BASE__;
  if (!raw) return null;
  if (typeof raw === "string" && raw.startsWith("__PORT_")) {
    // плейсхолдер не переписан: на локальной машине — прямой адрес, на хостинге — без прокси
    if (["localhost", "127.0.0.1"].includes(location.hostname)) return "http://localhost:8787";
    return null;
  }
  return raw; // путь относительно текущей страницы (прописывается при деплое)
})();

function initApiChat() {
  const sendBtn = $("#chatSendBtn");
  const input = $("#chatInput");
  const messages = $("#chatMessages");
  const apiKeyInput = $("#apiKeyInput");
  const apiUrlInput = $("#apiUrlInput");
  const modelSelect = $("#apiModelSelect");
  if (!sendBtn || !input || !messages) return;
  let chatHistory = [];
  sendBtn.addEventListener("click", sendChat);
  input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } });
  function addMsg(role, text, isErr) {
    const div = document.createElement("div");
    div.className = "msg " + (isErr ? "err" : role);
    div.textContent = text;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
    const hint = messages.querySelector('div[style*="text-align:center"]');
    if (hint) hint.remove();
  }
  async function sendChat() {
    const apiKey = apiKeyInput.value.trim();
    const apiUrl = apiUrlInput.value.trim() || "https://api.munito.ai/inference/v1";
    const model = modelSelect.value;
    const text = input.value.trim();
    if (!apiKey) { addMsg("err", "⚠️ Вставьте API ключ"); return; }
    if (!text) return;
    input.value = "";
    addMsg("user", text);
    chatHistory.push({ role: "user", content: text });
    sendBtn.disabled = true;
    sendBtn.textContent = "...";
    try {
      let res, data;
      try {
        res = await fetch(apiUrl + "/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + apiKey
          },
          body: JSON.stringify({
            model: model,
            messages: chatHistory,
            stream: false
          })
        });
        data = await res.json();
        if (!res.ok) {
          throw new Error(data.error?.message || "Ошибка API: " + res.status);
        }
      } catch (e) {
        // «Failed to fetch» = API запрещает вызовы из браузера (CORS) или недоступен —
        // пробуем через встроенный прокси сайта
        if (API_PROXY && (e instanceof TypeError || /Failed to fetch/i.test(e.message))) {
          const pres = await fetch(API_PROXY + "/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: apiUrl, key: apiKey, model: model, messages: chatHistory })
          });
          data = await pres.json();
          if (!pres.ok) {
            throw new Error(data.error?.message || "Ошибка прокси: " + pres.status);
          }
        } else {
          throw e;
        }
      }
      const reply = data.choices?.[0]?.message?.content || JSON.stringify(data, null, 2);
      chatHistory.push({ role: "assistant", content: reply });
      addMsg("ai", reply);
    } catch (err) {
      addMsg("err", "❌ " + err.message);
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = "→";
    }
  }
}

/* ================= СТАРТ ================= */
window.addEventListener("online", () => { if (fbUser && data.settings.autoSync) syncPush(true); });
if (data.settings.firebaseConfig || (typeof window.FB_CONFIG === "object" && window.FB_CONFIG)) initFirebase(true);
// если данные мигрированы из v1 — сразу сохраняем в новый ключ
if (!store.getItem(STORAGE_KEY) && store.getItem(OLD_KEY)) persist();
switchTab("diary");
/* ================= ЗАПУСК API ЧАТА ================= */
initApiChat();
