// ====== UI refs ======
const groupBox = document.getElementById("groupBox");
const personSelect = document.getElementById("personSelect");
const searchInput = document.getElementById("searchInput");
const clearBtn = document.getElementById("clearBtn");
const resultArea = document.getElementById("resultArea");

// memo/log UI
const memoInput = document.getElementById("memoInput");
const saveMemoBtn = document.getElementById("saveMemoBtn");
const clearMemoBtn = document.getElementById("clearMemoBtn");
const logArea = document.getElementById("logArea");
const logCount = document.getElementById("logCount");
const deleteVisibleBtn = document.getElementById("deleteVisibleBtn");
const deleteAllBtn = document.getElementById("deleteAllBtn");

// suggestion UI
const suggestArea = document.getElementById("suggestArea");
const suggestCount = document.getElementById("suggestCount");
const refreshSuggestBtn = document.getElementById("refreshSuggestBtn");

// ====== state ======
let data = null;

// ====== utils ======
const norm = (s) => (s ?? "").toString().trim().toLowerCase();
const nowISO = () => new Date().toISOString();

// ====== storage keys ======
const STORAGE_KEY = "conversation_logs_v1";
const ACCORDION_KEY = "accordion_open_v1"; // groupId|personId -> open

// ====== suggestion tuning ======
const SUGGEST_LIMIT = 8;
const COOLDOWN_DAYS = 7;
const PASS_HARD_LIMIT = 3;
const PASS_RATE_LIMIT = 0.6;

// ===================== localStorage logs =====================
function loadLogs() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); }
  catch { return []; }
}
function saveLogs(logs) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(logs));
}

/**
 * type: "memo" | "question_asked" | "question_pass"
 */
function makeLogItem({ type, groupId, groupName, personId, personName, text, meta }) {
  return {
    id: `log_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    createdAt: nowISO(),
    type,
    groupId,
    groupName,
    personId: personId || "",
    personName: personName || "",
    text: (text ?? "").toString().trim(),
    meta: meta || {}
  };
}

// ===================== accordion state =====================
function loadAccordionState() {
  try { return JSON.parse(localStorage.getItem(ACCORDION_KEY) || "{}"); }
  catch { return {}; }
}
function saveAccordionState(state) {
  localStorage.setItem(ACCORDION_KEY, JSON.stringify(state));
}
function isPersonOpen(groupId, personId) {
  const s = loadAccordionState();
  return s[`${groupId}|${personId}`] ?? false; // default closed
}
function setPersonOpen(groupId, personId, open) {
  const s = loadAccordionState();
  s[`${groupId}|${personId}`] = open;
  saveAccordionState(s);
}

// ===================== data load + normalize multi-group =====================
async function loadData() {
  const res = await fetch("./data.json", { cache: "no-store" });
  if (!res.ok) throw new Error("data.json が読み込めませんでした");
  const raw = await res.json();

  // 展開： "club,university" を個別 group に分配
  const map = new Map(); // groupId -> {id,name,people:[]}

  for (const g of (raw.groups ?? [])) {
    const ids = String(g.id ?? "").split(",").map(s => s.trim()).filter(Boolean);
    const names = String(g.name ?? "").split(",").map(s => s.trim());

    if (ids.length <= 1) {
      const id = ids[0] || g.id;
      if (!map.has(id)) map.set(id, { id, name: g.name, people: [] });
      const target = map.get(id);
      target.name = target.name || g.name;
      target.people.push(...(g.people ?? []));
      continue;
    }

    ids.forEach((id, i) => {
      const name = names[i] || names[0] || id;
      if (!map.has(id)) map.set(id, { id, name, people: [] });
      const target = map.get(id);
      if (!target.name) target.name = name;
      target.people.push(...(g.people ?? []));
    });
  }

  // group内 person 重複排除（person.id）
  const groups = [...map.values()].map(group => {
    const seen = new Set();
    const uniq = [];
    for (const p of (group.people ?? [])) {
      const pid = p?.id ?? `${p?.name ?? ""}`;
      if (!pid) continue;
      if (seen.has(pid)) continue;
      seen.add(pid);
      uniq.push(p);
    }
    return { ...group, people: uniq };
  });

  // 並び順：name のあいうえお（ざっくり）で
  groups.sort((a, b) => String(a.name).localeCompare(String(b.name), "ja"));

  data = { groups };
}

// ===================== selectors (multi group) =====================
function getSelectedGroupIds() {
  const checks = [...groupBox.querySelectorAll("input[type=checkbox][data-group-id]")];
  return checks.filter(c => c.checked).map(c => c.dataset.groupId);
}

function getSelectedGroups() {
  const ids = new Set(getSelectedGroupIds());
  return (data?.groups ?? []).filter(g => ids.has(g.id));
}

function getAllGroupsMap() {
  const map = new Map();
  for (const g of (data?.groups ?? [])) map.set(g.id, g);
  return map;
}

function setGroupCheckboxes() {
  groupBox.innerHTML = "";
  for (const g of (data.groups ?? [])) {
    const label = document.createElement("label");
    label.className = "groupChip";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.dataset.groupId = g.id;

    cb.addEventListener("change", () => {
      // 所属が変わったら相手選択をリセット（存在しない人になる可能性）
      personSelect.value = "";
      setPersonOptions();
      render();
    });

    const span = document.createElement("span");
    span.textContent = g.name;

    label.appendChild(cb);
    label.appendChild(span);

    groupBox.appendChild(label);
  }
}

function personMatchesSearch(p, q) {
  if (!q) return true;
  const hay = [
    p.name,
    ...(p.tags ?? []),
    ...Object.values(p.info ?? {}).map(v => String(v))
  ].map(norm).join(" ");
  return hay.includes(q);
}

function setPersonOptions() {
  const selectedGroups = getSelectedGroups();
  const q = norm(searchInput.value);

  personSelect.innerHTML = "";
  const opt0 = document.createElement("option");
  opt0.value = "";
  opt0.textContent = "（未選択）";
  personSelect.appendChild(opt0);

  if (selectedGroups.length === 0) {
    personSelect.disabled = true;
    return;
  }

  // 選択所属の people を union
  const byId = new Map(); // personId -> person
  for (const g of selectedGroups) {
    for (const p of (g.people ?? [])) {
      if (!p?.id) continue;
      // 検索は person の情報で絞る
      if (!personMatchesSearch(p, q)) continue;
      if (!byId.has(p.id)) byId.set(p.id, p);
    }
  }

  // 名前順
  const people = [...byId.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), "ja"));

  for (const p of people) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    personSelect.appendChild(opt);
  }

  personSelect.disabled = false;
}

function getSelectedPerson() {
  const pid = personSelect.value;
  if (!pid) return null;

  const selectedGroups = getSelectedGroups();
  for (const g of selectedGroups) {
    const found = (g.people ?? []).find(p => p.id === pid);
    if (found) return found;
  }
  return null;
}

function getPersonGroupIds(pid) {
  const groupIds = [];
  for (const g of (data?.groups ?? [])) {
    if ((g.people ?? []).some(p => p.id === pid)) groupIds.push(g.id);
  }
  return groupIds;
}

function getBestGroupContextForPerson(pid) {
  // ログやメモで groupId を決めたい時：
  // 選択中の所属の中でその人がいる最初の group を返す
  const selectedIds = getSelectedGroupIds();
  for (const gid of selectedIds) {
    const g = (data.groups ?? []).find(x => x.id === gid);
    if (!g) continue;
    if ((g.people ?? []).some(p => p.id === pid)) return g;
  }
  // それでもなければ選択中の先頭
  const gid0 = selectedIds[0];
  return (data.groups ?? []).find(x => x.id === gid0) ?? null;
}

// ===================== DOM helpers =====================
function el(tag, className, text) {
  const d = document.createElement(tag);
  if (className) d.className = className;
  if (text !== undefined) d.textContent = text;
  return d;
}
function renderEmpty(msg) {
  resultArea.innerHTML = "";
  resultArea.appendChild(el("div", "empty", msg));
}

// ===================== question logging =====================
function pushQuestionLog({ mode, questionText, targetPerson, groupContext }) {
  const selectedGroups = getSelectedGroups();
  if (selectedGroups.length === 0) return;

  const type = mode === "asked" ? "question_asked" : "question_pass";
  const p = targetPerson || getSelectedPerson();
  if (!p) return;

  // groupContext が渡されていればそれを優先（所属ごとの一覧から押した時など）
  const g = groupContext || getBestGroupContextForPerson(p.id) || selectedGroups[0];

  const logs = loadLogs();
  logs.push(
    makeLogItem({
      type,
      groupId: g.id,
      groupName: g.name,
      personId: p.id,
      personName: p.name,
      text: questionText,
      meta: { kind: "question" }
    })
  );
  saveLogs(logs);

  renderLogs();
  renderSuggestions();
}

// ===================== render helpers for questions =====================
function makeQuestionRow(questionText, targetPerson, groupContext) {
  const row = el("div", "qItemRow");
  row.appendChild(el("div", "qText", questionText));

  const btns = el("div", "qBtns");

  const askedBtn = el("button", "qBtn", "この質問を聞いた");
  askedBtn.type = "button";
  askedBtn.addEventListener("click", () => {
    pushQuestionLog({ mode: "asked", questionText, targetPerson, groupContext });
  });

  const passBtn = el("button", "qBtn", "パス");
  passBtn.type = "button";
  passBtn.addEventListener("click", () => {
    pushQuestionLog({ mode: "pass", questionText, targetPerson, groupContext });
  });

  btns.appendChild(askedBtn);
  btns.appendChild(passBtn);
  row.appendChild(btns);

  const li = document.createElement("li");
  li.appendChild(row);
  return li;
}

// ===================== main render =====================
function renderPersonView(p) {
  resultArea.innerHTML = "";

  const block = el("div", "block");

  const badgeRow = el("div", "badgeRow");
  badgeRow.appendChild(el("div", "title", p.name));

  // 選択中所属の中で、この人が属する所属名をバッジ表示
  const selected = getSelectedGroups();
  const belong = selected.filter(g => (g.people ?? []).some(x => x.id === p.id));
  for (const g of belong) badgeRow.appendChild(el("div", "badge", `所属: ${g.name}`));

  for (const t of (p.tags ?? [])) badgeRow.appendChild(el("div", "badge", t));
  block.appendChild(badgeRow);

  // info
  const info = p.info ?? {};
  const keys = Object.keys(info).filter(k => String(info[k] ?? "").trim() !== "");
  if (keys.length) {
    const kv = el("div", "kv");
    for (const k of keys) {
      kv.appendChild(el("div", "k", k));
      kv.appendChild(el("div", "v", String(info[k])));
    }
    block.appendChild(kv);
  } else {
    block.appendChild(el("div", "empty", "（相手の情報がまだありません）"));
  }

  // questions (dedup)
  const qSearch = norm(searchInput.value);
  const qs = (p.questions ?? [])
    .filter(x => String(x ?? "").trim() !== "")
    .filter(q => !qSearch || norm(q).includes(qSearch));

  const h = el("div", "badgeRow");
  h.appendChild(el("div", "badge", "相手にすべき質問（ボタンでログ化）"));
  block.appendChild(h);

  if (!qs.length) {
    block.appendChild(el("div", "empty", "（質問がありません / 検索に一致しません）"));
  } else {
    const ul = el("ul", "qList");
    // person view なので groupContext は「最適な所属（選択中で所属している最初）」にする
    const gctx = getBestGroupContextForPerson(p.id);
    for (const q of qs) ul.appendChild(makeQuestionRow(q, p, gctx));
    block.appendChild(ul);
  }

  resultArea.appendChild(block);
}

function renderGroupsAccordionView(groups) {
  resultArea.innerHTML = "";
  const qSearch = norm(searchInput.value);

  if (groups.length === 0) {
    renderEmpty("所属を選択してください。");
    return;
  }

  for (const g of groups) {
    const wrap = el("div", "block");

    const head = el("div", "badgeRow");
    head.appendChild(el("div", "badge", `所属「${g.name}」の質問（人ごとに開閉）`));
    wrap.appendChild(head);

    const people = (g.people ?? []).filter(p => {
      if (!qSearch) return true;
      const hitQ = (p.questions ?? []).some(q => norm(q).includes(qSearch));
      return hitQ || personMatchesSearch(p, qSearch);
    });

    if (!people.length) {
      wrap.appendChild(el("div", "empty", "（この所属は検索条件に一致する人がいません）"));
      resultArea.appendChild(wrap);
      continue;
    }

    for (const p of people) {
      const open = isPersonOpen(g.id, p.id);

      const acc = el("div", "personAccordion");

      const headerBtn = el("button", "accHeader");
      headerBtn.type = "button";

      const left = el("div", "accLeft");
      const chev = el("div", "chev", open ? "v" : ">");
      left.appendChild(chev);
      left.appendChild(el("div", "title", p.name));

      const meta = el("div", "accMeta");
      meta.appendChild(el("div", "badge", `${(p.questions ?? []).length}問`));
      for (const t of (p.tags ?? [])) meta.appendChild(el("div", "badge", t));
      left.appendChild(meta);

      headerBtn.appendChild(left);

      const body = el("div", "accBody");
      body.style.display = open ? "block" : "none";

      const qs = (p.questions ?? [])
        .filter(x => String(x ?? "").trim() !== "")
        .filter(q => !qSearch || norm(q).includes(qSearch) || personMatchesSearch(p, qSearch));

      if (!qs.length) {
        body.appendChild(el("div", "empty", "（質問がありません / 検索に一致しません）"));
      } else {
        const ul = el("ul", "qList");
        for (const q of qs) ul.appendChild(makeQuestionRow(q, p, g));
        body.appendChild(ul);
      }

      headerBtn.addEventListener("click", () => {
        const nextOpen = body.style.display === "none";
        body.style.display = nextOpen ? "block" : "none";
        chev.textContent = nextOpen ? "v" : ">";
        setPersonOpen(g.id, p.id, nextOpen);
      });

      acc.appendChild(headerBtn);
      acc.appendChild(body);
      wrap.appendChild(acc);
    }

    resultArea.appendChild(wrap);
  }
}

function render() {
  const groups = getSelectedGroups();
  const p = getSelectedPerson();

  if (groups.length === 0) {
    renderEmpty("所属を1つ以上選択してください。");
    renderLogs();
    renderSuggestions();
    return;
  }

  if (p) renderPersonView(p);
  else renderGroupsAccordionView(groups);

  renderLogs();
  renderSuggestions();
}

// ===================== logs render =====================
function selectedGroupIdSet() {
  return new Set(getSelectedGroupIds());
}

function logMatchesCurrentFilter(log) {
  const gset = selectedGroupIdSet();
  const pid = personSelect.value || "";
  const q = norm(searchInput.value);

  // グループ複数：選択中のどれかに一致
  if (gset.size > 0 && !gset.has(log.groupId)) return false;

  // person 選択時：その person のログだけ
  if (pid && log.personId !== pid) return false;

  if (!q) return true;
  const hay = [log.groupName, log.personName, log.text, log.type].map(norm).join(" ");
  return hay.includes(q);
}

function formatJST(iso) {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${y}/${m}/${day} ${hh}:${mm}`;
}

function typeLabel(t) {
  if (t === "memo") return "メモ";
  if (t === "question_asked") return "聞いた";
  if (t === "question_pass") return "パス";
  return t || "log";
}

function renderLogs() {
  const logs = loadLogs();
  const filtered = logs
    .filter(logMatchesCurrentFilter)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  logCount.textContent = `${filtered.length}件`;
  logArea.innerHTML = "";

  if (!filtered.length) {
    logArea.appendChild(el("div", "empty", "（ログがありません）"));
    return;
  }

  for (const item of filtered) {
    const card = el("div", "logCard");

    const top = el("div", "logTop");
    top.appendChild(el("div", "badge", formatJST(item.createdAt)));
    top.appendChild(el("div", "badge", typeLabel(item.type)));
    top.appendChild(el("div", "badge", `所属: ${item.groupName}`));
    if (item.personName) top.appendChild(el("div", "badge", `相手: ${item.personName}`));
    card.appendChild(top);

    card.appendChild(el("div", "logText", item.text));

    const btnRow = el("div", "row");
    btnRow.style.marginTop = "10px";

    const del = el("button", "smallBtn", "このログを削除");
    del.type = "button";
    del.addEventListener("click", () => {
      const next = loadLogs().filter(x => x.id !== item.id);
      saveLogs(next);
      renderLogs();
      renderSuggestions();
    });

    btnRow.appendChild(del);
    card.appendChild(btnRow);

    logArea.appendChild(card);
  }
}

// ===================== memo save =====================
function saveMemo() {
  const groups = getSelectedGroups();
  if (groups.length === 0) {
    alert("所属を選んでから保存してください。");
    return;
  }

  const text = (memoInput.value || "").trim();
  if (!text) {
    alert("メモが空です。");
    return;
  }

  const p = getSelectedPerson();
  let g = groups[0];

  if (p) {
    const gctx = getBestGroupContextForPerson(p.id);
    if (gctx) g = gctx;
  }

  const logs = loadLogs();
  logs.push(
    makeLogItem({
      type: "memo",
      groupId: g.id,
      groupName: g.name,
      personId: p?.id || "",
      personName: p?.name || "",
      text
    })
  );

  saveLogs(logs);
  memoInput.value = "";
  renderLogs();
  renderSuggestions();
}

// ===================== delete logs =====================
function deleteVisibleLogs() {
  const logs = loadLogs();
  const remained = logs.filter(l => !logMatchesCurrentFilter(l));

  if (remained.length === logs.length) {
    alert("削除対象がありません。");
    return;
  }
  const ok = confirm("表示中のログをすべて削除します。よろしいですか？");
  if (!ok) return;

  saveLogs(remained);
  renderLogs();
  renderSuggestions();
}

function deleteAllLogs() {
  const ok = confirm("全ログを削除します。よろしいですか？");
  if (!ok) return;
  saveLogs([]);
  renderLogs();
  renderSuggestions();
}

// ===================== suggestions =====================
function daysSince(iso) {
  if (!iso) return 1e9;
  const ms = Date.now() - new Date(iso).getTime();
  return ms / (1000 * 60 * 60 * 24);
}

function buildQuestionStats(logs) {
  // key: groupId|personId|questionText
  const map = new Map();
  for (const l of logs) {
    if (l.meta?.kind !== "question") continue;
    const key = `${l.groupId}|${l.personId}|${l.text}`;

    const cur = map.get(key) || { asked: 0, pass: 0, lastAskedAt: "" };

    if (l.type === "question_asked") {
      cur.asked += 1;
      if (!cur.lastAskedAt || l.createdAt > cur.lastAskedAt) cur.lastAskedAt = l.createdAt;
    } else if (l.type === "question_pass") {
      cur.pass += 1;
    }
    map.set(key, cur);
  }
  return map;
}

function collectCandidateQuestions() {
  const groups = getSelectedGroups();
  const p = getSelectedPerson();
  const qSearch = norm(searchInput.value);
  if (groups.length === 0) return [];

  const list = [];

  if (p) {
    // person選択中：その人が属する選択中所属の質問を候補に（同じ質問は同一所属単位で扱う）
    for (const g of groups) {
      const personInGroup = (g.people ?? []).find(x => x.id === p.id);
      if (!personInGroup) continue;
      for (const q of (personInGroup.questions ?? [])) {
        if (!q || !String(q).trim()) continue;
        if (qSearch && !norm(q).includes(qSearch)) continue;
        list.push({ groupId: g.id, groupName: g.name, personId: p.id, personName: p.name, text: q });
      }
    }
    return list;
  }

  // person未選択：選択所属全部から候補を集める
  for (const g of groups) {
    for (const person of (g.people ?? [])) {
      if (qSearch) {
        const hitQ = (person.questions ?? []).some(q => norm(q).includes(qSearch));
        const hitP = personMatchesSearch(person, qSearch);
        if (!hitQ && !hitP) continue;
      }
      for (const q of (person.questions ?? [])) {
        if (!q || !String(q).trim()) continue;
        if (qSearch && !norm(q).includes(qSearch) && !personMatchesSearch(person, qSearch)) continue;
        list.push({ groupId: g.id, groupName: g.name, personId: person.id, personName: person.name, text: q });
      }
    }
  }

  return list;
}

function scoreCandidate(candidate, statsMap) {
  const key = `${candidate.groupId}|${candidate.personId}|${candidate.text}`;
  const st = statsMap.get(key) || { asked: 0, pass: 0, lastAskedAt: "" };

  const asked = st.asked || 0;
  const pass = st.pass || 0;
  const total = asked + pass;

  if (pass >= PASS_HARD_LIMIT) return { ok: false, score: -1e9, st };
  if (total >= 3 && (pass / total) > PASS_RATE_LIMIT) return { ok: false, score: -1e9, st };

  const d = daysSince(st.lastAskedAt);
  if (d < COOLDOWN_DAYS) return { ok: false, score: -1e9, st };

  const recencyBonus = Math.min(30, d);
  const score = 100 + recencyBonus - asked * 18 - pass * 28 + Math.random() * 3;
  return { ok: true, score, st };
}

function renderSuggestions() {
  const groups = getSelectedGroups();
  if (groups.length === 0) {
    suggestArea.innerHTML = `<div class="empty">（所属を選ぶと候補が出ます）</div>`;
    suggestCount.textContent = "0件";
    return;
  }

  const logs = loadLogs();
  const statsMap = buildQuestionStats(logs);
  const candidates = collectCandidateQuestions();

  const scored = [];
  for (const c of candidates) {
    const r = scoreCandidate(c, statsMap);
    if (r.ok) scored.push({ ...c, score: r.score, st: r.st });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, SUGGEST_LIMIT);

  suggestCount.textContent = `${top.length}件`;
  suggestArea.innerHTML = "";

  if (!top.length) {
    suggestArea.appendChild(el("div", "empty", "（候補がありません：パス多い/最近聞いた/検索条件の可能性）"));
    return;
  }

  for (const it of top) {
    const card = el("div", "suggestCard");

    const topRow = el("div", "badgeRow");
    topRow.appendChild(el("div", "badge", "候補"));
    topRow.appendChild(el("div", "badge", `所属: ${it.groupName}`));
    topRow.appendChild(el("div", "badge", `相手: ${it.personName}`));
    topRow.appendChild(el("div", "badge", `聞いた:${it.st.asked || 0}`));
    topRow.appendChild(el("div", "badge", `パス:${it.st.pass || 0}`));
    card.appendChild(topRow);

    card.appendChild(el("div", "logText", it.text));

    const btnRow = el("div", "qBtns");
    btnRow.style.marginTop = "10px";

    const askedBtn = el("button", "qBtn", "この質問を聞いた");
    askedBtn.type = "button";
    askedBtn.addEventListener("click", () => {
      pushQuestionLog({
        mode: "asked",
        questionText: it.text,
        targetPerson: { id: it.personId, name: it.personName },
        groupContext: { id: it.groupId, name: it.groupName }
      });
    });

    const passBtn = el("button", "qBtn", "パス");
    passBtn.type = "button";
    passBtn.addEventListener("click", () => {
      pushQuestionLog({
        mode: "pass",
        questionText: it.text,
        targetPerson: { id: it.personId, name: it.personName },
        groupContext: { id: it.groupId, name: it.groupName }
      });
    });

    btnRow.appendChild(askedBtn);
    btnRow.appendChild(passBtn);
    card.appendChild(btnRow);

    suggestArea.appendChild(card);
  }
}

// ===================== init & events =====================
function safeKeepPersonSelection() {
  const before = personSelect.value;
  setPersonOptions();
  const stillExists = [...personSelect.options].some(o => o.value === before);
  if (!stillExists) personSelect.value = "";
  else personSelect.value = before;
}

function clearAll() {
  // groups uncheck
  [...groupBox.querySelectorAll("input[type=checkbox][data-group-id]")].forEach(c => (c.checked = false));
  personSelect.value = "";
  searchInput.value = "";
  memoInput.value = "";
  setPersonOptions();
  render();
}

async function init() {
  try {
    await loadData();
    setGroupCheckboxes();
    setPersonOptions();
    render();

    personSelect.addEventListener("change", render);

    searchInput.addEventListener("input", () => {
      safeKeepPersonSelection();
      render();
    });

    clearBtn.addEventListener("click", clearAll);

    saveMemoBtn.addEventListener("click", saveMemo);
    clearMemoBtn.addEventListener("click", () => (memoInput.value = ""));
    deleteVisibleBtn.addEventListener("click", deleteVisibleLogs);
    deleteAllBtn.addEventListener("click", deleteAllLogs);

    refreshSuggestBtn.addEventListener("click", renderSuggestions);

  } catch (e) {
    console.error(e);
    renderEmpty("読み込みエラー：data.json を確認してください。");
    suggestArea.innerHTML = `<div class="empty">（候補を出せません）</div>`;
  }
}

init();
