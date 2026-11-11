import { commitState, createVault, exportEncryptedBackup, hasVault, importEncryptedBackup, readStorageHealth, requestPersistentStorage, restorePrevious, unlockVault } from "./storage.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const screens = { vault: $("#vault-screen"), ledger: $("#ledger-screen") };
const forms = { create: $("#create-vault-form"), unlock: $("#unlock-form"), entry: $("#entry-form") };
const dialog = $("#entry-dialog");
const wagerDialog = $("#wager-dialog");
const backupDialog = $("#backup-import-dialog");
const TYPE = {
  stake: { label: "投注支出", delta: -1, color: "out", group: "bet" },
  payout: { label: "派彩返还", delta: 1, color: "in", group: "bet" },
  deposit: { label: "账户存入", delta: 1, color: "in", group: "movement" },
  withdrawal: { label: "账户取出", delta: -1, color: "out", group: "movement" },
  refund: { label: "独立退款 / 退回", delta: 1, color: "in", group: "movement" },
  bonus: { label: "奖金 / 赠金", delta: 1, color: "in", group: "movement" },
};
const WAGER_STATUS = { open: "未结算", won: "已结算 · 赢", lost: "已结算 · 输", void: "已作废 / 退回", cashout: "提前结算 / 其他结算" };
const STAKE_BANDS = ["≤ ¥10", "¥10.01–¥50", "¥50.01–¥100", "> ¥100"];
const PAGES = ["overview", "records", "analysis", "risk"];

let session = null;
let deferredInstallPrompt = null;
let saveBusy = false;
let editingRecordId = null;
let editingWagerId = null;
let persistentStorageRequest;
let lockPending = false;
let activePage = "overview";
let activeFilter = "all";
let activePeriod = "7";
let pendingBackup = null;
let activeWagerFilter = "all";
let analysisDateBasis = "placed";
let activeAnalysisPeriod = "month";
let activeWagerDrilldown = null;
let wagerPreviewUrl = null;
let wagerEntrySource = "manual";
let wagerOriginalSource = "manual";

function formatMoney(minor) {
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" }).format(minor / 100);
}

function formatDate(value, withYear = false) {
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return "日期无效";
  return new Intl.DateTimeFormat("zh-CN", withYear ? { month: "short", day: "numeric", year: "numeric" } : { month: "short", day: "numeric" }).format(date);
}

function setError(selector, message = "") {
  $(selector).textContent = message;
}

function showVault(createMode) {
  screens.vault.classList.remove("hidden");
  screens.ledger.classList.add("hidden");
  forms.create.classList.toggle("hidden", !createMode);
  forms.unlock.classList.toggle("hidden", createMode);
  $("#backup-import-button").classList.toggle("hidden", !createMode);
  $("#lock-button").classList.add("hidden");
}

function showLedger() {
  screens.vault.classList.add("hidden");
  screens.ledger.classList.remove("hidden");
  $("#lock-button").classList.remove("hidden");
  setPage(activePage);
  render();
  refreshHealth();
}

function lockApp() {
  session = null;
  if (dialog.open) dialog.close();
  if (wagerDialog.open) wagerDialog.close();
  showVault(false);
}

function finishPendingLock() {
  if (!lockPending) return;
  lockPending = false;
  lockApp();
}

function recordsInPeriod(period) {
  const records = session?.state.records ?? [];
  if (period === "all") return records;
  const days = Number(period);
  const start = localDateInput(1 - days);
  const end = localDateInput();
  return records.filter((record) => record.date >= start && record.date <= end);
}

function localDateFromTimestamp(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function periodInfo(dateValue, period = session?.state.riskSettings?.period ?? "monthly") {
  const date = new Date(`${dateValue}T12:00:00`);
  if (period === "weekly") {
    const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - ((date.getDay() + 6) % 7));
    const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
    const start = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, "0")}-${String(monday.getDate()).padStart(2, "0")}`;
    const end = `${sunday.getFullYear()}-${String(sunday.getMonth() + 1).padStart(2, "0")}-${String(sunday.getDate()).padStart(2, "0")}`;
    return { key: start, start, end, label: `本周（${formatDate(start)}–${formatDate(end)}）` };
  }
  const start = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-01`;
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  const end = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return { key: start.slice(0, 7), start, end, label: `${date.getFullYear()} 年 ${date.getMonth() + 1} 月` };
}

function currentPeriodInfo(period) { return periodInfo(localDateInput(), period); }
function wagerResult(wager) { return wager.status === "open" ? null : wager.actualReturnMinor - wager.stakeMinor - wager.feeMinor; }
function isSettledForRoi(wager) { return wager.status !== "open" && wager.status !== "void"; }
function wagerDate(wager, basis = "placed") { return localDateFromTimestamp(basis === "settled" ? wager.settledAt : wager.placedAt); }
function stakeBandIndex(amountMinor) { return amountMinor <= 1000 ? 0 : amountMinor <= 5000 ? 1 : amountMinor <= 10000 ? 2 : 3; }

function wagerMetrics(wagers) {
  const eligible = wagers.filter(isSettledForRoi);
  const settledNet = eligible.reduce((sum, wager) => sum + wagerResult(wager), 0);
  const settledStake = eligible.reduce((sum, wager) => sum + wager.stakeMinor, 0);
  const returned = wagers.filter((wager) => wager.status !== "open").reduce((sum, wager) => sum + wager.actualReturnMinor, 0);
  const openStake = wagers.filter((wager) => wager.status === "open").reduce((sum, wager) => sum + wager.stakeMinor, 0);
  const fees = eligible.reduce((sum, wager) => sum + wager.feeMinor, 0);
  const actualNet = wagers.filter((wager) => wager.status !== "open").reduce((sum, wager) => sum + wagerResult(wager), 0);
  return { settledNet, settledStake, returned, openStake, actualNet, fees, count: wagers.length, settledCount: eligible.length, roi: settledStake ? settledNet / settledStake * 100 : null };
}

function wagerOutcomeMetrics(wagers, dateBasis = analysisDateBasis) {
  const settled = wagers.filter(isSettledForRoi).slice().sort((a, b) => {
    const aTime = new Date(dateBasis === "settled" ? a.settledAt : a.placedAt).getTime();
    const bTime = new Date(dateBasis === "settled" ? b.settledAt : b.placedAt).getTime();
    return aTime - bTime || a.placedAt.localeCompare(b.placedAt);
  });
  let wins = 0, losses = 0, currentSign = 0, currentLength = 0, maxWinStreak = 0, maxLossStreak = 0;
  for (const wager of settled) {
    const net = wagerResult(wager);
    const sign = net > 0 ? 1 : net < 0 ? -1 : 0;
    if (sign > 0) wins += 1;
    if (sign < 0) losses += 1;
    if (sign === 0) {
      currentSign = 0;
      currentLength = 0;
      continue;
    }
    currentLength = sign === currentSign ? currentLength + 1 : 1;
    currentSign = sign;
    if (sign > 0) maxWinStreak = Math.max(maxWinStreak, currentLength);
    else maxLossStreak = Math.max(maxLossStreak, currentLength);
  }
  const totalStake = settled.reduce((sum, wager) => sum + wager.stakeMinor, 0);
  const maxStake = settled.reduce((maximum, wager) => Math.max(maximum, wager.stakeMinor), 0);
  return { wins, losses, maxWinStreak, maxLossStreak, averageStake: settled.length ? Math.round(totalStake / settled.length) : null, maxStake: settled.length ? maxStake : null };
}

function appendAudit(state, entity, id, action, before, after) {
  const entry = { id: crypto.randomUUID(), entity, entityId: id, action, at: new Date().toISOString(), before: before ? structuredClone(before) : null, after: after ? structuredClone(after) : null };
  return [...(state.auditLog ?? []), entry].slice(-500);
}

function describeAuditValue(entity, value) {
  if (!value) return "已删除";
  if (entity === "wager") return `${value.event} · ${formatMoney(value.stakeMinor)} · ${WAGER_STATUS[value.status] ?? value.status}${value.status === "open" ? "" : ` · 净结果 ${formatMoney(wagerResult(value))}`}`;
  if (entity === "record") return `${TYPE[value.kind]?.label ?? "流水"} · ${formatMoney(value.amountMinor)} · ${formatDate(value.date, true)}`;
  if (entity === "settings") return `周期 ${value.period === "weekly" ? "自然周" : "法定月"} · 预算 ${value.budgetMinor == null ? "未设置" : formatMoney(value.budgetMinor)} · 亏损上限 ${value.lossLimitMinor == null ? "未设置" : formatMoney(value.lossLimitMinor)} · 单笔上限 ${value.maxStakeMinor == null ? "未设置" : formatMoney(value.maxStakeMinor)}`;
  return "保护操作";
}

function auditFields(entity, value) {
  if (!value) return [];
  const dateTime = (raw) => {
    if (!raw) return "未填写";
    const date = new Date(raw);
    return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date) : "时间无效";
  };
  const timeLimit = (raw) => raw || "未限制";
  if (entity === "wager") return [
    ["event", "比赛 / 事件", value.event], ["sport", "运动 / 类别", value.sport || "未填写"], ["league", "联赛", value.league || "未填写"],
    ["market", "玩法", value.market || "未填写"], ["platform", "平台", value.platform || "未填写"],
    ["oddsMilli", "赔率", value.oddsMilli == null ? "未填写" : (value.oddsMilli / 1000).toFixed(3).replace(/0+$/, "").replace(/\.$/, "")],
    ["stakeMinor", "投注金额", formatMoney(value.stakeMinor)], ["combo", "投注类型", value.combo === "parlay" ? "串关" : "单关"],
    ["status", "结算状态", WAGER_STATUS[value.status] ?? value.status],
    ["actualReturnMinor", "实际返还", value.actualReturnMinor == null ? "未结算" : formatMoney(value.actualReturnMinor)],
    ["feeMinor", "手续费", formatMoney(value.feeMinor ?? 0)], ["settledAt", "结算时间", dateTime(value.settledAt)],
    ["result", "赛果", value.result || "未填写"], ["tags", "标签", (Array.isArray(value.tags) ? value.tags : []).join("、") || "无"],
    ["beforeState", "下注前状态", value.beforeState || "未填写"], ["note", "备注", value.note || "无"],
    ["source", "录入来源", value.source === "image" ? "图片识别" : "手工录入"], ["placedAt", "投注时间", dateTime(value.placedAt)],
  ].map(([key, label, text]) => ({ key, label, text, raw: value[key] ?? null }));
  if (entity === "record") return [
    ["kind", "流水类型", TYPE[value.kind]?.label ?? value.kind], ["amountMinor", "金额", formatMoney(value.amountMinor)],
    ["deltaMinor", "资金变动", formatMoney(value.deltaMinor)], ["date", "日期", value.date || "未填写"],
    ["note", "备注", value.note || "无"], ["legacyType", "旧版关联标记", value.legacyType === undefined ? "旧版记录" : value.legacyType ? "旧版关联" : "新独立流水"],
  ].map(([key, label, text]) => ({ key, label, text, raw: value[key] ?? null }));
  if (entity === "settings") return [
    ["period", "预算周期", value.period === "weekly" ? "自然周" : "法定月"],
    ["budgetMinor", "周期预算", value.budgetMinor == null ? "未设置" : formatMoney(value.budgetMinor)],
    ["lossLimitMinor", "亏损上限", value.lossLimitMinor == null ? "未设置" : formatMoney(value.lossLimitMinor)],
    ["maxStakeMinor", "单笔上限", value.maxStakeMinor == null ? "未设置" : formatMoney(value.maxStakeMinor)],
    ["allowedStart", "允许开始时间", timeLimit(value.allowedStart)], ["allowedEnd", "允许结束时间", timeLimit(value.allowedEnd)],
    ["cooloffUntil", "冷静期结束", value.cooloffUntil ? dateTime(value.cooloffUntil) : "未开启"],
    ["stoppedPeriodKey", "停止周期", value.stoppedPeriodKey || "未停止"],
  ].map(([key, label, text]) => ({ key, label, text, raw: value[key] ?? null }));
  return [];
}

function auditChanges(entry) {
  const before = auditFields(entry.entity, entry.before);
  const after = auditFields(entry.entity, entry.after);
  if (!entry.before || !entry.after) {
    return (entry.after ? after : before).map((field) => ({ label: field.label, from: entry.before ? field.text : "", to: entry.after ? field.text : "" }));
  }
  const beforeMap = new Map(before.map((field) => [field.key, field]));
  return after.flatMap((field) => {
    const previous = beforeMap.get(field.key);
    if (!previous || JSON.stringify(previous.raw) === JSON.stringify(field.raw)) return [];
    return [{ label: field.label, from: previous.text, to: field.text }];
  });
}

function calculate(records) {
  const betRecords = records.filter(isLegacyBetRecord);
  const net = betRecords.reduce((sum, record) => sum + record.deltaMinor, 0);
  const stake = betRecords.filter((record) => record.kind === "stake").reduce((sum, record) => sum + record.amountMinor, 0);
  const returned = betRecords.filter((record) => ["payout", "refund"].includes(record.kind)).reduce((sum, record) => sum + record.amountMinor, 0);
  return { net, stake, returned, count: records.length };
}

function isLegacyBetRecord(record) {
  return ["stake", "payout"].includes(record.kind) || (record.kind === "refund" && record.legacyType !== false);
}

function setPage(page) {
  if (!PAGES.includes(page)) return;
  activePage = page;
  for (const name of PAGES) $(`#page-${name}`).classList.toggle("hidden", name !== page);
  $$(`[data-page]`).forEach((button) => {
    const selected = button.dataset.page === page;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-current", selected ? "page" : "false");
  });
  if (session) render();
  window.scrollTo({ top: 0, behavior: "auto" });
}

function createEntryRow(record, withActions = true) {
  const type = TYPE[record.kind] ?? { label: "未知类型", delta: 0, color: "in" };
  const row = document.createElement("li");
  row.className = "entry-row";
  const mark = document.createElement("span");
  mark.className = `entry-mark ${type.color}`;
  mark.textContent = type.delta < 0 ? "−" : "+";
  const details = document.createElement("div");
  details.className = "entry-details";
  const title = document.createElement("strong");
  title.textContent = type.label;
  const subtitle = document.createElement("span");
  subtitle.textContent = `${formatDate(record.date, true)}${record.note ? ` · ${record.note}` : ""}`;
  details.append(title, subtitle);
  const amount = document.createElement("strong");
  amount.className = `entry-amount ${type.color}`;
  amount.textContent = `${type.delta < 0 ? "−" : "+"}${formatMoney(record.amountMinor)}`;
  row.append(mark, details, amount);

  if (withActions) {
    const actions = document.createElement("div");
    actions.className = "entry-actions";
    const editButton = document.createElement("button");
    editButton.className = "entry-action";
    editButton.type = "button";
    editButton.dataset.editId = record.id;
    editButton.textContent = "编辑";
    editButton.setAttribute("aria-label", `编辑${type.label} ${formatMoney(record.amountMinor)}`);
    const deleteButton = document.createElement("button");
    deleteButton.className = "entry-action destructive";
    deleteButton.type = "button";
    deleteButton.dataset.deleteId = record.id;
    deleteButton.textContent = "删除";
    deleteButton.setAttribute("aria-label", `删除${type.label} ${formatMoney(record.amountMinor)}`);
    actions.append(editButton, deleteButton);
    row.append(actions);
  }
  return row;
}

function createWagerRow(wager, withActions = true) {
  const row = document.createElement("li");
  row.className = "entry-row wager-row";
  const mark = document.createElement("span");
  mark.className = `entry-mark ${wager.status === "open" ? "pending" : wagerResult(wager) < 0 ? "out" : "in"}`;
  mark.textContent = wager.status === "open" ? "…" : wager.status === "lost" ? "−" : wager.status === "won" ? "+" : "✓";
  const details = document.createElement("div");
  details.className = "entry-details";
  const title = document.createElement("strong");
  title.textContent = wager.event;
  const meta = [wager.sport, wager.league, wager.market, wager.platform, wager.combo === "parlay" ? "串关" : "单关", WAGER_STATUS[wager.status], wager.source === "image" ? "图片识别" : "手工录入", wager.result].filter(Boolean).join(" · ");
  const subtitle = document.createElement("span");
  subtitle.textContent = `${formatDate(localDateFromTimestamp(wager.placedAt), true)} · ${meta}`;
  const detail = document.createElement("span");
  detail.className = "wager-detail";
  const odds = wager.oddsMilli == null ? "赔率未填" : `赔率 ${(wager.oddsMilli / 1000).toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}`;
  detail.textContent = wager.status === "open"
    ? `投注 ${formatMoney(wager.stakeMinor)} · ${odds} · 未结算${wager.note ? ` · ${wager.note}` : ""}`
    : `投注 ${formatMoney(wager.stakeMinor)} · ${odds} · 返还 ${formatMoney(wager.actualReturnMinor)} · 手续费 ${formatMoney(wager.feeMinor)} · ${wager.settledAt ? `结算 ${formatDate(localDateFromTimestamp(wager.settledAt), true)}` : ""}${wager.note ? ` · ${wager.note}` : ""}`;
  details.append(title, subtitle, detail);
  const amount = document.createElement("strong");
  amount.className = `entry-amount ${wager.status === "open" ? "pending" : wagerResult(wager) < 0 ? "out" : "in"}`;
  amount.textContent = wager.status === "open" ? `未结算 ${formatMoney(wager.stakeMinor)}` : formatMoney(wagerResult(wager));
  row.append(mark, details, amount);
  if (withActions) {
    const actions = document.createElement("div");
    actions.className = "entry-actions";
    const edit = document.createElement("button");
    edit.className = "entry-action";
    edit.type = "button";
    edit.dataset.editWagerId = wager.id;
    edit.textContent = wager.status === "open" ? "结算 / 编辑" : "查看 / 编辑";
    const remove = document.createElement("button");
    remove.className = "entry-action destructive";
    remove.type = "button";
    remove.dataset.deleteWagerId = wager.id;
    remove.textContent = "删除";
    actions.append(edit, remove);
    row.append(actions);
  }
  const history = session.state.auditLog.filter((item) => item.entity === "wager" && item.entityId === wager.id);
  if (history.length) {
    const detailsLog = document.createElement("details");
    detailsLog.className = "row-history";
    const summary = document.createElement("summary");
    summary.textContent = `修改记录 ${history.length}`;
    const list = document.createElement("ul");
    for (const item of history.slice().reverse()) {
      const line = document.createElement("li");
      line.textContent = `${new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(new Date(item.at))} · ${item.action === "create" ? "新增" : item.action === "delete" ? "删除" : "编辑"}`;
      list.append(line);
    }
    detailsLog.append(summary, list);
    row.append(detailsLog);
  }
  return row;
}

function currentCycleData(sourceWagers = session.state.wagers) {
  const info = currentPeriodInfo();
  const wagers = sourceWagers.filter((wager) => {
    const date = localDateFromTimestamp(wager.placedAt);
    return date >= info.start && date <= info.end;
  });
  const settledInCycle = sourceWagers.filter((wager) => {
    if (wager.status === "open") return false;
    const date = localDateFromTimestamp(wager.settledAt);
    return date >= info.start && date <= info.end;
  });
  const openWagers = sourceWagers.filter((wager) => wager.status === "open");
  const legacy = session.state.records.filter((record) => record.kind === "stake" && record.date >= info.start && record.date <= info.end);
  const legacyBetLines = session.state.records.filter((record) => isLegacyBetRecord(record) && record.date >= info.start && record.date <= info.end);
  const legacyNet = calculate(legacyBetLines).net;
  const metrics = wagerMetrics(wagers);
  const settledCycleNet = settledInCycle.reduce((sum, wager) => sum + wagerResult(wager), 0);
  const realizedLoss = Math.max(0, -settledCycleNet) + Math.max(0, -legacyNet);
  const openStake = openWagers.reduce((sum, wager) => sum + wager.stakeMinor, 0);
  const riskExposure = realizedLoss + openStake;
  const legacyBudget = legacy.reduce((sum, item) => sum + item.amountMinor, 0);
  const wagerBudget = wagers.reduce((sum, item) => sum + item.stakeMinor, 0);
  const maxLegacyStake = legacy.reduce((maximum, item) => Math.max(maximum, item.amountMinor), 0);
  const maxWagerStake = [...wagers, ...openWagers].reduce((maximum, item) => Math.max(maximum, item.stakeMinor), 0);
  const maxRecordedStake = Math.max(maxLegacyStake, maxWagerStake);
  return { info, wagers, legacy, legacyNet, metrics, settledCycleNet, realizedLoss, openWagers, openStake, riskExposure, maxRecordedStake, budgetUsed: legacyBudget + wagerBudget };
}

function wagerCashChangeBetween(wagers, start, end) {
  return wagers.reduce((sum, wager) => {
    const placedDate = localDateFromTimestamp(wager.placedAt);
    const stakeChange = placedDate >= start && placedDate <= end ? -wager.stakeMinor : 0;
    const settledDate = localDateFromTimestamp(wager.settledAt);
    const settlementChange = wager.status !== "open" && settledDate >= start && settledDate <= end
      ? wager.actualReturnMinor - wager.feeMinor : 0;
    return sum + stakeChange + settlementChange;
  }, 0);
}

function renderWagerTrend(container, wagers) {
  const groups = new Map();
  for (let offset = 6; offset >= 0; offset--) {
    const day = localDateInput(-offset);
    groups.set(day, { net: 0, has: false });
  }
  for (const wager of wagers) {
    const day = localDateFromTimestamp(wager.placedAt);
    if (!groups.has(day) || !isSettledForRoi(wager)) continue;
    const row = groups.get(day);
    row.net += wagerResult(wager);
    row.has = true;
  }
  const values = [...groups.values()];
  const max = Math.max(1, ...values.map((item) => Math.abs(item.net)));
  container.replaceChildren();
  for (const [day, item] of groups) {
    const row = document.createElement("div");
    row.className = "trend-row";
    const label = document.createElement("span");
    label.className = "trend-label";
    label.textContent = formatDate(day);
    const track = document.createElement("span");
    track.className = "trend-track";
    const bar = document.createElement("progress");
    bar.className = `trend-bar ${item.net < 0 ? "loss" : "gain"}`;
    bar.max = 100;
    bar.value = item.has ? Math.max(4, Math.abs(item.net) / max * 100) : 0;
    track.append(bar);
    const amount = document.createElement("strong");
    amount.className = `trend-value ${item.net < 0 ? "negative" : ""}`;
    amount.textContent = item.has ? formatMoney(item.net) : "—";
    row.append(label, track, amount);
    container.append(row);
  }
}

function renderOverview() {
  const { info, wagers, metrics, openWagers, openStake, riskExposure, budgetUsed } = currentCycleData();
  const settings = session.state.riskSettings;
  $("#hero-caption").textContent = `${info.label}已结算投注净结果（按投注日期）`;
  $("#budget-period-title").textContent = settings.period === "weekly" ? "本周预算" : "本月预算";
  $("#settled-net").textContent = formatMoney(metrics.settledNet);
  $("#settled-net").classList.toggle("negative", metrics.settledNet < 0);
  $("#settled-stake").textContent = formatMoney(metrics.settledStake);
  $("#open-stake").textContent = formatMoney(openStake);
  $("#open-count").textContent = `${openWagers.length} 笔`;
  $("#settled-roi").textContent = metrics.roi == null ? "—" : `${metrics.roi.toFixed(1)}%`;
  const budget = settings.budgetMinor;
  $("#budget-used").textContent = formatMoney(budgetUsed);
  $("#budget-left").textContent = budget == null ? "—" : formatMoney(budget - budgetUsed);
  $("#budget-remaining").textContent = budget == null ? "未设置" : `${formatMoney(budget - budgetUsed)} 剩余`;
  $("#budget-remaining").classList.toggle("negative", budget != null && budgetUsed >= budget);
  $("#budget-progress").value = budget ? Math.min(100, budgetUsed / budget * 100) : 0;
  $("#budget-caption").textContent = `${info.label} · 按投注日期累计本金，赢款不会增加可用预算。${budget == null ? "请在“保护”中设置。" : ""}`;

  const cycleRecords = session.state.records.filter((record) => record.date >= info.start && record.date <= info.end);
  const legacyBetLines = cycleRecords.filter(isLegacyBetRecord);
  $("#legacy-result-card").classList.toggle("hidden", legacyBetLines.length === 0);
  $("#legacy-cycle-net").textContent = formatMoney(calculate(legacyBetLines).net);
  const deposits = cycleRecords.filter((record) => record.kind === "deposit").reduce((sum, record) => sum + record.amountMinor, 0);
  const withdrawals = cycleRecords.filter((record) => record.kind === "withdrawal").reduce((sum, record) => sum + record.amountMinor, 0);
  const wagerCashChange = wagerCashChangeBetween(session.state.wagers, info.start, info.end);
  const legacyCashChange = cycleRecords.reduce((sum, record) => sum + record.deltaMinor, 0);
  $("#deposit-total").textContent = formatMoney(deposits);
  $("#withdrawal-total").textContent = formatMoney(withdrawals);
  $("#net-deposits").textContent = formatMoney(deposits - withdrawals);
  $("#wager-cash-change").textContent = formatMoney(wagerCashChange);
  $("#fund-change").textContent = formatMoney(legacyCashChange + wagerCashChange);
  $("#fund-change").classList.toggle("negative", legacyCashChange + wagerCashChange < 0);

  const sevenDays = session.state.wagers.filter((wager) => {
    const date = localDateFromTimestamp(wager.placedAt);
    return date >= localDateInput(-6) && date <= localDateInput();
  });
  const sevenMetrics = wagerMetrics(sevenDays);
  $("#week-net").textContent = formatMoney(sevenMetrics.settledNet);
  $("#week-net").classList.toggle("negative", sevenMetrics.settledNet < 0);
  $("#week-stake").textContent = formatMoney(sevenMetrics.settledStake);
  $("#week-return").textContent = formatMoney(sevenMetrics.returned);
  renderWagerTrend($("#week-chart"), sevenDays);
  const sortedWagers = [...session.state.wagers].sort((a, b) => b.placedAt.localeCompare(a.placedAt));
  const oldRecords = [...session.state.records].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  $("#overview-empty-state").classList.toggle("hidden", sortedWagers.length + oldRecords.length > 0);
  const recent = $("#overview-recent-list");
  const rows = sortedWagers.slice(0, 4).map((wager) => createWagerRow(wager));
  if (rows.length < 4) rows.push(...oldRecords.slice(0, 4 - rows.length).map((record) => createEntryRow(record)));
  recent.replaceChildren(...rows);
}

function renderRecords() {
  const allWagers = [...session.state.wagers].sort((a, b) => b.placedAt.localeCompare(a.placedAt));
  updateRecentOptions(allWagers);
  const query = $("#wager-search").value.trim().toLocaleLowerCase("zh-CN");
  const wagers = allWagers.filter((wager) => {
    const statusMatch = activeWagerFilter === "all" || (activeWagerFilter === "open" ? wager.status === "open" : wager.status !== "open");
    const searchable = [wager.event, wager.sport, wager.league, wager.market, wager.platform, wager.result, wager.beforeState, wager.note, wager.oddsMilli == null ? "" : wager.oddsMilli / 1000, ...(wager.tags ?? [])].join(" ").toLocaleLowerCase("zh-CN");
    const queryMatch = !query || searchable.includes(query);
    const drilldown = activeWagerDrilldown;
    const drilldownMatch = !drilldown || (wagerDate(wager, drilldown.dateBasis) >= drilldown.range.start
      && wagerDate(wager, drilldown.dateBasis) <= drilldown.range.end
      && analysisGroup(wager, drilldown.dimension, drilldown.dateBasis) === drilldown.value);
    return statusMatch && queryMatch && drilldownMatch;
  });
  $("#wager-count").textContent = `${wagers.length} 笔投注 · 未结算 ${allWagers.filter((wager) => wager.status === "open").length} 笔${activeWagerDrilldown ? ` · 分析筛选：${activeWagerDrilldown.value}` : ""}`;
  $("#clear-wager-drilldown").classList.toggle("hidden", !activeWagerDrilldown);
  $("#wager-empty-state").classList.toggle("hidden", wagers.length > 0);
  $("#wager-list").replaceChildren(...wagers.map((wager) => createWagerRow(wager)));
  $$(`[data-wager-filter]`).forEach((button) => {
    const selected = button.dataset.wagerFilter === activeWagerFilter;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });

  const all = [...session.state.records].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  const filtered = activeFilter === "all" ? all : all.filter((record) => activeFilter === "movement" ? TYPE[record.kind]?.group === "movement" : record.kind === activeFilter);
  $("#records-count").textContent = activeFilter === "all" ? `共 ${all.length} 笔记录` : `当前筛选 ${filtered.length} / ${all.length} 笔`;
  const empty = filtered.length === 0;
  $("#records-empty-state").classList.toggle("hidden", !empty);
  $("#records-empty-title").textContent = all.length === 0 ? "还没有流水" : "没有符合条件的记录";
  $("#records-empty-copy").textContent = all.length === 0 ? "记录投注、派彩或账户资金移动后会显示在这里。" : "可以切换流水类型，或新增一笔记录。";
  const list = $("#entry-list");
  list.replaceChildren(...filtered.map((record) => createEntryRow(record)));
  $("#restore-button").disabled = session.state.sequence <= 1;
  $$(`[data-filter]`).forEach((button) => {
    const selected = button.dataset.filter === activeFilter;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

function updateRecentOptions(wagers) {
  for (const [selector, field] of [["#sports-options", "sport"], ["#league-options", "league"], ["#platform-options", "platform"]]) {
    const values = [...new Set(wagers.map((wager) => wager[field]?.trim()).filter(Boolean))].slice(0, 20);
    $(selector).replaceChildren(...values.map((value) => {
      const option = document.createElement("option");
      option.value = value;
      return option;
    }));
  }
}

function analysisRange() {
  const today = localDateInput();
  if (activeAnalysisPeriod === "all") return { start: "0000-01-01", end: "9999-12-31", label: "全部记录" };
  if (activeAnalysisPeriod === "custom") {
    const start = $("#analysis-start").value;
    const end = $("#analysis-end").value;
    if (start && end && start <= end) return { start, end, label: `${formatDate(start, true)}–${formatDate(end, true)}` };
    return { start: "9999-01-01", end: "0000-01-01", label: "请设置有效日期范围" };
  }
  const period = periodInfo(today, activeAnalysisPeriod === "week" ? "weekly" : "monthly");
  return { start: period.start, end: today, label: activeAnalysisPeriod === "week" ? "本周至今" : "本月至今" };
}

function analysisGroup(wager, dimension, dateBasis = analysisDateBasis) {
  if (dimension === "odds") {
    if (!wager.oddsMilli) return "未填写赔率";
    const odds = wager.oddsMilli / 1000;
    if (odds < 1.5) return "1.00–1.49";
    if (odds < 2) return "1.50–1.99";
    if (odds < 3) return "2.00–2.99";
    if (odds < 5) return "3.00–4.99";
    return "5.00 及以上";
  }
  if (dimension === "hour") {
    const timestamp = dateBasis === "settled" ? wager.settledAt : wager.placedAt;
    if (!timestamp) return "未填写时间";
    const hour = new Date(timestamp).getHours();
    return hour < 6 ? "00–05 时" : hour < 12 ? "06–11 时" : hour < 18 ? "12–17 时" : "18–23 时";
  }
  if (dimension === "weekday") {
    const names = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    const timestamp = dateBasis === "settled" ? wager.settledAt : wager.placedAt;
    if (!timestamp) return "未填写时间";
    return names[new Date(timestamp).getDay()];
  }
  const value = { sport: wager.sport, league: wager.league, market: wager.market, platform: wager.platform }[dimension];
  return value?.trim() || "未填写";
}

function renderWagerAnalysisTrend(wagers, range) {
  const monthly = activeAnalysisPeriod === "all" || (range.start && range.end && new Date(range.end) - new Date(range.start) > 90 * 86400000);
  const groups = new Map();
  for (const wager of wagers) {
    if (!isSettledForRoi(wager)) continue;
    const day = wagerDate(wager, analysisDateBasis);
    if (!day) continue;
    const key = monthly ? day.slice(0, 7) : day;
    const item = groups.get(key) ?? { net: 0, count: 0 };
    item.net += wagerResult(wager);
    item.count += 1;
    groups.set(key, item);
  }
  const rows = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  const maximum = Math.max(1, ...rows.map(([, item]) => Math.abs(item.net)));
  const container = $("#analysis-trend");
  container.replaceChildren();
  for (const [key, item] of rows) {
    const row = document.createElement("div");
    row.className = "trend-row";
    const label = document.createElement("span");
    label.className = "trend-label";
    label.textContent = monthly ? formatMonth(key) : formatDate(key);
    const track = document.createElement("span");
    track.className = "trend-track";
    const bar = document.createElement("progress");
    bar.className = `trend-bar ${item.net < 0 ? "loss" : "gain"}`;
    bar.max = 100;
    bar.value = Math.max(4, Math.abs(item.net) / maximum * 100);
    track.append(bar);
    const value = document.createElement("strong");
    value.className = `trend-value ${item.net < 0 ? "negative" : ""}`;
    value.textContent = formatMoney(item.net);
    row.append(label, track, value);
    container.append(row);
  }
  $("#trend-title").textContent = monthly ? "每月已结算净结果" : "每日已结算净结果";
  $("#analysis-no-trend").classList.toggle("hidden", rows.length > 0);
}

function renderWagerBreakdown(wagers) {
  const dimension = $("#analysis-dimension").value;
  const completenessFields = ["sport", "league", "market", "platform", "oddsMilli"];
  const completenessLabels = { sport: "运动", league: "联赛", market: "玩法", platform: "平台", oddsMilli: "赔率" };
  const groups = new Map();
  for (const wager of wagers) {
    const key = analysisGroup(wager, dimension);
    const item = groups.get(key) ?? { count: 0, stake: 0, net: 0, settledCount: 0, start: "", end: "", completeFields: 0, missingFields: Object.fromEntries(completenessFields.map((field) => [field, 0])) };
    item.count += 1;
    for (const field of completenessFields) {
      const complete = field === "oddsMilli" ? wager[field] != null : typeof wager[field] === "string" && Boolean(wager[field].trim());
      if (complete) item.completeFields += 1;
      else item.missingFields[field] += 1;
    }
    const day = wagerDate(wager, analysisDateBasis);
    if (day) {
      item.start = !item.start || day < item.start ? day : item.start;
      item.end = !item.end || day > item.end ? day : item.end;
    }
    if (isSettledForRoi(wager)) {
      item.settledCount += 1;
      item.stake += wager.stakeMinor;
      item.net += wagerResult(wager);
    }
    groups.set(key, item);
  }
  const list = $("#type-breakdown");
  list.replaceChildren();
  const sorted = [...groups.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 12);
  $("#breakdown-empty").classList.toggle("hidden", sorted.length > 0);
  for (const [label, item] of sorted) {
    const row = document.createElement("div");
    row.className = "breakdown-row";
    const heading = document.createElement("div");
    heading.className = "breakdown-heading";
    const name = document.createElement("button");
    name.className = "drilldown-button";
    name.type = "button";
    name.dataset.wagerDimension = dimension;
    name.dataset.wagerValue = label;
    name.textContent = `${label} · ${item.count} 笔`;
    const stats = document.createElement("strong");
    const roi = item.stake ? `${(item.net / item.stake * 100).toFixed(1)}%` : "—";
    stats.textContent = `结算额 ${formatMoney(item.stake)} · ROI ${roi}`;
    heading.append(name, stats);
    const result = document.createElement("span");
    result.className = `breakdown-result ${item.net < 0 ? "negative" : ""}`;
    const span = item.start ? `${formatDate(item.start, true)}${item.start === item.end ? "" : `–${formatDate(item.end, true)}`}` : "无日期范围";
    result.textContent = `${item.settledCount ? `净结果 ${formatMoney(item.net)} · 已结算 ${item.settledCount}${item.settledCount < 30 ? " · 样本少" : ""}` : "尚无已结算投注"} · 覆盖 ${span}`;
    const completeness = document.createElement("p");
    completeness.className = "breakdown-quality";
    const percent = Math.round(item.completeFields / (item.count * completenessFields.length) * 100);
    const missing = completenessFields.filter((field) => item.missingFields[field] > 0)
      .map((field) => `${completenessLabels[field]} ${item.missingFields[field]} 笔`).join(" · ");
    completeness.textContent = `关键字段已填写 ${percent}%${missing ? ` · 缺失 ${missing}` : " · 字段齐全"}`;
    row.append(heading, result, completeness);
    list.append(row);
  }
}

function renderStakeDistribution(wagers) {
  const container = $("#stake-distribution");
  container.replaceChildren();
  $("#distribution-empty").classList.toggle("hidden", wagers.length > 0);
  $("#distribution-caption").textContent = `所选范围 ${wagers.length} 笔；按每笔投注本金分组，金额包含未结算投注，不代表赛果或未来表现。`;
  if (!wagers.length) return;
  const bands = STAKE_BANDS.map((label, index) => {
    const matched = wagers.filter((wager) => stakeBandIndex(wager.stakeMinor) === index);
    return { label, count: matched.length, stake: matched.reduce((sum, wager) => sum + wager.stakeMinor, 0) };
  });
  const maximum = Math.max(1, ...bands.map((band) => band.count));
  for (const band of bands) {
    const row = document.createElement("div");
    row.className = "distribution-row";
    const label = document.createElement("span");
    label.className = "distribution-label";
    label.textContent = band.label;
    const track = document.createElement("span");
    track.className = "trend-track";
    const bar = document.createElement("progress");
    bar.className = "trend-bar gain";
    bar.max = 100;
    bar.value = band.count ? Math.max(5, band.count / maximum * 100) : 0;
    track.append(bar);
    const value = document.createElement("strong");
    value.className = "distribution-value";
    value.textContent = `${band.count} 笔 · ${formatMoney(band.stake)}`;
    row.append(label, track, value);
    container.append(row);
  }
}

function renderAnalysis() {
  const range = analysisRange();
  const wagers = session.state.wagers.filter((wager) => {
    const date = wagerDate(wager, analysisDateBasis);
    return date && date >= range.start && date <= range.end;
  });
  const metrics = wagerMetrics(wagers);
  $("#analysis-net").textContent = formatMoney(metrics.settledNet);
  $("#analysis-net").classList.toggle("negative", metrics.settledNet < 0);
  $("#analysis-stake").textContent = formatMoney(metrics.settledStake);
  $("#analysis-return").textContent = formatMoney(metrics.returned);
  $("#analysis-rate").textContent = metrics.roi == null ? "—" : `${metrics.roi.toFixed(1)}%`;
  $("#analysis-rate").classList.toggle("negative", metrics.settledNet < 0);
  $("#analysis-open").textContent = formatMoney(metrics.openStake);
  $("#analysis-count").textContent = String(metrics.count);
  const outcomes = wagerOutcomeMetrics(wagers, analysisDateBasis);
  $("#analysis-average-stake").textContent = outcomes.averageStake == null ? "—" : formatMoney(outcomes.averageStake);
  $("#analysis-max-stake").textContent = outcomes.maxStake == null ? "—" : formatMoney(outcomes.maxStake);
  $("#analysis-outcomes").textContent = `${outcomes.wins} / ${outcomes.losses}`;
  $("#analysis-streaks").textContent = `${outcomes.maxWinStreak} / ${outcomes.maxLossStreak}`;
  $("#analysis-period-label").textContent = `${range.label} · ${analysisDateBasis === "placed" ? "按投注日期" : "按结算日期"} · ${metrics.count} 笔投注`;
  const completenessFields = ["sport", "league", "market", "platform", "oddsMilli"];
  const fieldCount = wagers.length * completenessFields.length;
  const completedFields = wagers.reduce((sum, wager) => sum + completenessFields.filter((key) => key === "oddsMilli" ? wager[key] != null : typeof wager[key] === "string" && Boolean(wager[key].trim())).length, 0);
  const completeness = fieldCount ? `${Math.round(completedFields / fieldCount * 100)}%` : "—";
  const dates = wagers.map((wager) => wagerDate(wager, analysisDateBasis)).filter(Boolean).sort();
  const coverage = dates.length ? `${formatDate(dates[0], true)}${dates[0] === dates.at(-1) ? "" : `–${formatDate(dates.at(-1), true)}`}` : "无记录";
  const sampleWarning = metrics.settledCount < 30 ? `已结算样本 ${metrics.settledCount} 笔，数据不足以评价稳定性。` : `已结算样本 ${metrics.settledCount} 笔。`;
  $("#analysis-sample-note").textContent = `${sampleWarning}所选字段完整度 ${completeness} · 覆盖 ${coverage} · 历史描述，不代表未来表现。`;
  $("#analysis-custom-range").classList.toggle("hidden", activeAnalysisPeriod !== "custom");
  renderWagerAnalysisTrend(wagers, range);
  renderStakeDistribution(wagers);
  renderWagerBreakdown(wagers);
  const basisDate = analysisDateBasis === "placed" ? (record) => record.date : (record) => record.date;
  const legacyRecords = session.state.records.filter((record) => basisDate(record) >= range.start && basisDate(record) <= range.end && isLegacyBetRecord(record));
  const legacyNet = calculate(legacyRecords).net;
  $("#legacy-analysis-note").textContent = legacyRecords.length ? `另有 ${legacyRecords.length} 笔旧版未关联流水，原始净结果 ${formatMoney(legacyNet)}；因缺少结算状态，未计入新口径 ROI。` : "旧版未关联投注流水不计入以上已结算 ROI。所有统计仅描述本机已有记录，不用于预测结果。";
  $$(`[data-period]`).forEach((button) => {
    const selected = button.dataset.period === activeAnalysisPeriod;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  $$(`[data-date-basis]`).forEach((button) => {
    const selected = button.dataset.dateBasis === analysisDateBasis;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

function renderTrend(container, records, period, compact) {
  const groups = new Map();
  if (compact) {
    for (let offset = 6; offset >= 0; offset--) {
      const date = localDateInput(-offset);
      groups.set(date, { label: formatDate(date), net: 0, hasBetRecord: false });
    }
  }
  const monthly = period === "all";
  for (const record of records) {
    if (!isLegacyBetRecord(record)) continue;
    const key = monthly ? record.date.slice(0, 7) : record.date;
    const group = groups.get(key) ?? { label: monthly ? formatMonth(key) : formatDate(key), net: 0, hasBetRecord: false };
    group.net += record.deltaMinor;
    group.hasBetRecord = true;
    groups.set(key, group);
  }
  const visible = [...groups.entries()].filter(([, group]) => compact || group.hasBetRecord).sort(([a], [b]) => a.localeCompare(b));
  container.replaceChildren();
  if (!visible.length) return;
  const maxMagnitude = Math.max(1, ...visible.map(([, group]) => Math.abs(group.net)));
  for (const [key, group] of visible) {
    const row = document.createElement("div");
    row.className = "trend-row";
    const label = document.createElement("span");
    label.className = "trend-label";
    label.textContent = group.label;
    const track = document.createElement("span");
    track.className = "trend-track";
    const bar = document.createElement("progress");
    bar.className = `trend-bar ${group.net < 0 ? "loss" : "gain"}`;
    bar.max = 100;
    bar.value = group.hasBetRecord ? Math.max(4, Math.abs(group.net) / maxMagnitude * 100) : 0;
    bar.setAttribute("aria-label", `${group.label}净结果${formatMoney(group.net)}`);
    track.append(bar);
    const value = document.createElement("strong");
    value.className = `trend-value ${group.net < 0 ? "negative" : ""}`;
    value.textContent = formatMoney(group.net);
    row.append(label, track, value);
    row.dataset.periodKey = key;
    container.append(row);
  }
}

function formatMonth(value) {
  const [year, month] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("zh-CN", { year: "2-digit", month: "short" }).format(new Date(year, month - 1, 1));
}

function renderBreakdown(records) {
  const definitions = ["stake", "payout", "refund", "deposit", "withdrawal"];
  const amounts = definitions.map((kind) => ({
    kind,
    amount: records.filter((record) => record.kind === kind).reduce((sum, record) => sum + record.amountMinor, 0),
    count: records.filter((record) => record.kind === kind).length,
  }));
  const total = amounts.reduce((sum, item) => sum + item.amount, 0);
  const list = $("#type-breakdown");
  list.replaceChildren();
  $("#breakdown-empty").classList.toggle("hidden", total !== 0);
  for (const item of amounts) {
    if (item.count === 0) continue;
    const row = document.createElement("div");
    row.className = "breakdown-row";
    const header = document.createElement("div");
    header.className = "breakdown-heading";
    const label = document.createElement("span");
    label.textContent = TYPE[item.kind].label;
    const value = document.createElement("strong");
    value.textContent = `${formatMoney(item.amount)} · ${item.count} 笔`;
    header.append(label, value);
    const track = document.createElement("span");
    track.className = "breakdown-track";
    const bar = document.createElement("progress");
    bar.className = `breakdown-bar ${TYPE[item.kind].color}`;
    bar.max = 100;
    bar.value = total ? Math.max(3, item.amount / total * 100) : 0;
    track.append(bar);
    row.append(header, track);
    list.append(row);
  }
}

function render() {
  if (!session) return;
  renderOverview();
  renderRecords();
  renderAnalysis();
  renderRisk();
}

function riskAlerts() {
  const alerts = [];
  const { info, riskExposure, budgetUsed } = currentCycleData();
  const settings = session.state.riskSettings;
  const key = currentPeriodInfo(settings.period).key;
  if (settings.stoppedPeriodKey === key) alerts.push({ level: "stop", text: "你已选择停止本周期的新增投注记录。下个周期自动解除。" });
  if (settings.cooloffUntil && new Date(settings.cooloffUntil) > new Date()) alerts.push({ level: "stop", text: `冷静期进行中，至 ${new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(settings.cooloffUntil))}。` });
  if (settings.budgetMinor != null) {
    const ratio = budgetUsed / settings.budgetMinor;
    if (ratio >= 1) alerts.push({ level: "stop", text: `已达到周期预算（${formatMoney(budgetUsed)} / ${formatMoney(settings.budgetMinor)}）；应用内新增投注已锁定。` });
    else if (ratio >= 0.8) alerts.push({ level: "warn", text: `周期预算已使用 ${(ratio * 100).toFixed(0)}%（${formatMoney(budgetUsed)} / ${formatMoney(settings.budgetMinor)}）。` });
  }
  if (settings.lossLimitMinor != null) {
    const ratio = riskExposure / settings.lossLimitMinor;
    if (ratio >= 1) alerts.push({ level: "stop", text: `已达到亏损风险上限（本周期结算净结果、旧版记录估算和全部未结算本金）：${formatMoney(riskExposure)} / ${formatMoney(settings.lossLimitMinor)}。` });
    else if (ratio >= 0.8) alerts.push({ level: "warn", text: `当前风险占用已达亏损上限的 ${(ratio * 100).toFixed(0)}%；全部未结算本金按全额风险计入。` });
  }
  if (settings.maxStakeMinor != null) alerts.push({ level: "info", text: `单笔上限为 ${formatMoney(settings.maxStakeMinor)}；超过上限的新增投注会被拒绝，编辑也不能增加超限金额或风险占用。` });
  if (settings.allowedStart && settings.allowedEnd) {
    const current = new Date().getHours() * 60 + new Date().getMinutes();
    const start = Number(settings.allowedStart.slice(0, 2)) * 60 + Number(settings.allowedStart.slice(3));
    const end = Number(settings.allowedEnd.slice(0, 2)) * 60 + Number(settings.allowedEnd.slice(3));
    if (!(start <= end ? current >= start && current < end : current >= start || current < end)) alerts.push({ level: "stop", text: `当前时间不在允许记账时段 ${settings.allowedStart}–${settings.allowedEnd}，本工具会拒绝新增投注。` });
  }
  const now = Date.now();
  const recent = session.state.wagers.filter((wager) => {
    const age = now - new Date(wager.placedAt).getTime();
    return age >= 0 && age <= 60 * 60 * 1000;
  });
  if (recent.length >= 5) alerts.push({ level: "warn", text: `过去 60 分钟记录了 ${recent.length} 笔投注。短暂离开并检查预算，可能有帮助。` });
  const weekStart = localDateInput(-6);
  const night = session.state.wagers.filter((wager) => {
    const date = localDateFromTimestamp(wager.placedAt);
    const hour = new Date(wager.placedAt).getHours();
    return date >= weekStart && date <= localDateInput() && hour < 5;
  });
  if (night.length >= 3) alerts.push({ level: "warn", text: `最近 7 天有 ${night.length} 笔投注记录在 00:00–04:59。此提醒只反映记录时间。` });
  const sorted = [...session.state.wagers].sort((a, b) => a.placedAt.localeCompare(b.placedAt));
  const lastLossIndex = sorted.map((wager, index) => ({ wager, index })).filter(({ wager }) => wager.status !== "open" && wager.status !== "void" && wagerResult(wager) < 0).at(-1);
  if (lastLossIndex) {
    const lastLoss = lastLossIndex.wager;
    const lossTime = new Date(lastLoss.settledAt).getTime();
    const after = sorted.slice(lastLossIndex.index + 1).find((wager) => {
      const placed = new Date(wager.placedAt).getTime();
      return placed >= lossTime && placed - lossTime <= 24 * 60 * 60 * 1000 && wager.stakeMinor >= lastLoss.stakeMinor * 1.5;
    });
    if (after) alerts.push({ level: "warn", text: `一笔后续投注（${formatMoney(after.stakeMinor)}）比最近亏损投注（${formatMoney(lastLoss.stakeMinor)}）高出至少 50%，且在 24 小时内。可以考虑暂停。` });
    const topup = session.state.records.find((record) => record.kind === "deposit" && record.createdAt && new Date(record.createdAt) >= new Date(lossTime) && new Date(record.createdAt) - lossTime <= 6 * 60 * 60 * 1000);
    if (topup) alerts.push({ level: "warn", text: `最近一次结算亏损后 6 小时内记录过存款（${formatMoney(topup.amountMinor)}）。` });
  }
  return alerts;
}

function renderRisk() {
  const settings = session.state.riskSettings;
  const { realizedLoss, riskExposure, budgetUsed, info } = currentCycleData();
  const currentKey = currentPeriodInfo(settings.period).key;
  const paused = settings.cooloffUntil && new Date(settings.cooloffUntil) > new Date();
  const stopped = settings.stoppedPeriodKey === currentKey;
  const overBudget = settings.budgetMinor != null && budgetUsed >= settings.budgetMinor;
  const overLoss = settings.lossLimitMinor != null && riskExposure >= settings.lossLimitMinor;
  $("#risk-status").textContent = paused ? "冷静期进行中" : stopped ? "本周期已停止新增投注" : overBudget || overLoss ? "达到预设上限：已暂停应用内新增投注" : "未触发硬性暂停。请按预设额度记录。";
  $("#risk-status").className = `risk-status ${paused || stopped || overBudget || overLoss ? "blocked" : ""}`;
  $("#risk-budget-usage").textContent = settings.budgetMinor == null ? `${formatMoney(budgetUsed)} · 未设上限` : `${formatMoney(budgetUsed)} / ${formatMoney(settings.budgetMinor)}`;
  $("#risk-budget-remaining").textContent = settings.budgetMinor == null ? "未设置" : formatMoney(settings.budgetMinor - budgetUsed);
  $("#risk-exposure").textContent = formatMoney(riskExposure);
  $("#risk-loss-remaining").textContent = settings.lossLimitMinor == null ? "未设置" : formatMoney(settings.lossLimitMinor - riskExposure);
  $("#risk-loss").textContent = formatMoney(realizedLoss);
  $("#stop-cycle-button").disabled = stopped;
  $("#stop-cycle-button").textContent = stopped ? "本周期已停止" : `停止${settings.period === "weekly" ? "本周" : "本月"}新增记录`;
  const alertList = $("#risk-alerts");
  const alerts = riskAlerts();
  if (!settings.budgetMinor && !settings.lossLimitMinor && !settings.maxStakeMinor) alerts.push({ level: "info", text: "尚未设置金额上限。可在下方预设适合自己的周期预算、亏损上限和最大单笔。" });
  if (!alerts.length) alerts.push({ level: "ok", text: "当前记录未触发已配置的提醒。持续遵守预设额度；没有继续下注也是执行计划。" });
  alertList.replaceChildren(...alerts.map((alert) => {
    const item = document.createElement("p");
    item.className = `risk-alert ${alert.level}`;
    item.textContent = alert.text;
    return item;
  }));
  $("#risk-period").value = settings.period;
  $("#risk-budget-input").value = settings.budgetMinor == null ? "" : (settings.budgetMinor / 100).toFixed(2);
  $("#risk-loss-input").value = settings.lossLimitMinor == null ? "" : (settings.lossLimitMinor / 100).toFixed(2);
  $("#risk-max-input").value = settings.maxStakeMinor == null ? "" : (settings.maxStakeMinor / 100).toFixed(2);
  $("#risk-time-start").value = settings.allowedStart ?? "";
  $("#risk-time-end").value = settings.allowedEnd ?? "";
  $("#risk-settings-error").textContent = "";
  $("#risk-budget-usage").setAttribute("aria-label", `${info.label}预算使用情况`);
  const auditList = $("#audit-list");
  const auditItems = [...(session.state.auditLog ?? [])].reverse();
  auditList.replaceChildren(...auditItems.map((entry) => {
    const item = document.createElement("li");
    const at = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(new Date(entry.at));
    const action = { create: "新增", edit: "修改", delete: "删除", "stop-period": "停止本周期", "cooloff-24h": "开启 24 小时冷静期", "cooloff-168h": "开启 7 天冷静期" }[entry.action] ?? "更新保护设置";
    const entity = entry.entity === "wager" ? "投注" : entry.entity === "record" ? "流水" : "保护设置";
    const before = describeAuditValue(entry.entity, entry.before);
    const after = describeAuditValue(entry.entity, entry.after);
    const summary = document.createElement("p");
    summary.className = "audit-summary";
    summary.textContent = `${at} · ${action}${entity}：${before}${entry.before && entry.after ? ` → ${after}` : entry.after ? `：${after}` : ""}`;
    item.append(summary);
    const details = document.createElement("details");
    details.className = "audit-details";
    const heading = document.createElement("summary");
    heading.textContent = "查看字段明细";
    const list = document.createElement("ul");
    let rendered = false;
    details.addEventListener("toggle", () => {
      if (!details.open || rendered) return;
      rendered = true;
      for (const change of auditChanges(entry)) {
        const row = document.createElement("li");
        row.textContent = `${change.label}：${change.from ? `${change.from} → ` : ""}${change.to || "已删除"}`;
        list.append(row);
      }
      if (!list.childElementCount) {
        const empty = document.createElement("li");
        empty.textContent = "没有可显示的字段变化。";
        list.append(empty);
      }
    });
    details.append(heading, list);
    item.append(details);
    return item;
  }));
}

function amountInputMinor(value, allowZero = false) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return NaN;
  const minor = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(minor) && (allowZero ? minor >= 0 : minor > 0) ? minor : NaN;
}

function localDateTimeInput(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function updateWagerImageNote() {
  const note = $("#wager-image-note");
  if (wagerPreviewUrl) {
    note.textContent = "图片只在本机临时预览；请手工核对金额、赔率、玩法和结果。保存记录或关闭窗口后，图片会从预览中移除。";
  } else if (editingWagerId && wagerOriginalSource === "image") {
    note.textContent = "这条记录标记为图片对照来源；原图片未保存。如需重新对照，可选择图片临时预览。";
  } else {
    note.textContent = "图片只在本机临时预览，不会上传或写入账本。当前版本不自动识别文字，请对照图片手工核对录入。";
  }
}

function clearWagerImagePreview(restoreOriginalSource = true) {
  if (wagerPreviewUrl) URL.revokeObjectURL(wagerPreviewUrl);
  wagerPreviewUrl = null;
  $("#wager-image-preview").removeAttribute("src");
  $("#wager-image-preview-wrap").classList.add("hidden");
  $("#wager-image-input").value = "";
  wagerEntrySource = restoreOriginalSource ? wagerOriginalSource : "manual";
  updateWagerImageNote();
}

function selectWagerImage(file) {
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    setError("#wager-error", "请选择图片文件。");
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    setError("#wager-error", "图片超过 10 MB。请先在本机缩小图片后再选择；文件不会上传。");
    return;
  }
  clearWagerImagePreview(false);
  wagerPreviewUrl = URL.createObjectURL(file);
  wagerEntrySource = "image";
  $("#wager-image-preview").src = wagerPreviewUrl;
  $("#wager-image-preview-wrap").classList.remove("hidden");
  setError("#wager-error");
  updateWagerImageNote();
}

function wagerBlockReasons(candidate, current) {
  const settings = session.state.riskSettings;
  const reasons = [];
  const now = new Date();
  const cycle = currentPeriodInfo(settings.period);
  if (!current && settings.stoppedPeriodKey === cycle.key) reasons.push("你已停止本周期新增投注记录。");
  if (!current && settings.cooloffUntil && new Date(settings.cooloffUntil) > now) reasons.push("冷静期尚未结束。");
  if (settings.maxStakeMinor != null && candidate.stakeMinor > settings.maxStakeMinor
    && (!current || candidate.stakeMinor > current.stakeMinor)) reasons.push(`超过单笔上限 ${formatMoney(settings.maxStakeMinor)}。`);
  const currentData = currentCycleData();
  const projectedWagers = current
    ? session.state.wagers.map((wager) => wager.id === current.id ? candidate : wager)
    : [candidate, ...session.state.wagers];
  const projectedData = currentCycleData(projectedWagers);
  if (settings.budgetMinor != null && projectedData.budgetUsed > settings.budgetMinor
    && projectedData.budgetUsed > currentData.budgetUsed) reasons.push(`此更改会提高已超限的周期预算占用，或使其超过预算 ${formatMoney(settings.budgetMinor)}。`);
  if (settings.lossLimitMinor != null && projectedData.riskExposure > settings.lossLimitMinor
    && projectedData.riskExposure > currentData.riskExposure) reasons.push("此更改会提高已超限的亏损风险占用，或使其超过预设上限（已实现亏损加未结算本金）。");
  if (!current && settings.allowedStart && settings.allowedEnd) {
    const current = now.getHours() * 60 + now.getMinutes();
    const start = Number(settings.allowedStart.slice(0, 2)) * 60 + Number(settings.allowedStart.slice(3));
    const end = Number(settings.allowedEnd.slice(0, 2)) * 60 + Number(settings.allowedEnd.slice(3));
    const inWindow = start <= end ? current >= start && current < end : current >= start || current < end;
    if (!inWindow) reasons.push(`已超出允许记账时段 ${settings.allowedStart}–${settings.allowedEnd}。`);
  }
  return reasons;
}

async function saveWager(event) {
  event.preventDefault();
  if (!session || saveBusy) return;
  const stakeMinor = amountInputMinor($("#wager-stake").value);
  if (!Number.isSafeInteger(stakeMinor) || stakeMinor <= 0) return setError("#wager-error", "请输入有效投注金额，最多两位小数。");
  const status = $("#wager-status").value;
  const settled = status !== "open";
  const actualReturnMinor = settled ? amountInputMinor($("#wager-return").value, true) : null;
  const feeMinor = settled ? (amountInputMinor($("#wager-fee").value || "0", true) ?? 0) : 0;
  if (settled && (!Number.isSafeInteger(actualReturnMinor) || actualReturnMinor < 0)) return setError("#wager-error", "已结算投注请填写实际返还；输时填 0，返还金额应包含返还本金。");
  if (settled && (!Number.isSafeInteger(feeMinor) || feeMinor < 0)) return setError("#wager-error", "手续费金额无效。");
  const placed = new Date($("#wager-placed-at").value);
  if (Number.isNaN(placed.getTime())) return setError("#wager-error", "请填写有效投注时间。");
  if (!editingWagerId && placed.getTime() > Date.now() + 5 * 60 * 1000) return setError("#wager-error", "投注时间不能晚于当前时间；请只录入已实际发生的投注。");
  let settledAt = null;
  if (settled) {
    settledAt = new Date($("#wager-settled-at").value || localDateTimeInput());
    if (Number.isNaN(settledAt.getTime()) || settledAt < placed) return setError("#wager-error", "结算时间无效，且不能早于投注时间。");
  }
  const oddsText = $("#wager-odds").value.trim();
  const odds = oddsText ? Number(oddsText) : null;
  if (odds != null && (!Number.isFinite(odds) || odds < 1 || odds > 1000)) return setError("#wager-error", "赔率需在 1.000 至 1000 之间，或留空。");
  const current = editingWagerId ? session.state.wagers.find((item) => item.id === editingWagerId) : null;
  if (editingWagerId && !current) return setError("#wager-error", "该投注记录不存在，请关闭后刷新。");
  const eventName = $("#wager-event").value.trim();
  if (!eventName) return setError("#wager-error", "请填写比赛或事件。");
  if (!current) {
    const duplicate = session.state.wagers.some((wager) => wager.event.toLocaleLowerCase("zh-CN") === eventName.toLocaleLowerCase("zh-CN")
      && wager.platform === $("#wager-platform").value.trim() && wager.stakeMinor === stakeMinor
      && Math.abs(new Date(wager.placedAt) - placed) <= 2 * 60 * 60 * 1000);
    if (duplicate && !confirm("发现时间、事件、平台和金额相近的投注。仍要新增这笔记录吗？")) return;
  }
  const tags = [...new Set($("#wager-tags").value.split(",").map((tag) => tag.trim()).filter(Boolean))].slice(0, 8);
  const wager = {
    id: current?.id ?? crypto.randomUUID(),
    placedAt: placed.toISOString(),
    event: eventName,
    sport: $("#wager-sport").value.trim(),
    league: $("#wager-league").value.trim(),
    market: $("#wager-market").value.trim(),
    platform: $("#wager-platform").value.trim(),
    oddsMilli: odds == null ? null : Math.round(odds * 1000),
    stakeMinor,
    combo: $("#wager-combo").value,
    status,
    actualReturnMinor,
    feeMinor,
    settledAt: settled ? settledAt.toISOString() : null,
    result: $("#wager-result").value.trim(),
    tags,
    note: $("#wager-note").value.trim(),
    beforeState: $("#wager-state").value.trim(),
    source: wagerEntrySource,
    createdAt: current?.createdAt ?? new Date().toISOString(),
    ...(current ? { updatedAt: new Date().toISOString() } : {}),
  };
  const wagers = current
    ? session.state.wagers.map((item) => item.id === current.id ? wager : item)
    : [wager, ...session.state.wagers];
  const blocked = wagerBlockReasons(wager, current);
  if (blocked.length) return setError("#wager-error", `未保存：${blocked.join(" ")}`);
  let nextState = { ...session.state, sequence: session.state.sequence + 1, wagers };
  nextState.auditLog = appendAudit(nextState, "wager", wager.id, current ? "edit" : "create", current, wager);
  saveBusy = true;
  $("#wager-save-button").disabled = true;
  try {
    const health = await commitState(nextState, session.key);
    session.state = nextState;
    wagerDialog.close();
    render();
    updateHealthDisplay(health);
    await refreshHealth();
  } catch (error) {
    setError("#wager-error", `保存失败，未报告为已保存：${error.message}`);
  } finally {
    saveBusy = false;
    $("#wager-save-button").disabled = false;
    finishPendingLock();
  }
}

function syncSettlementFields() {
  const settled = $("#wager-status").value !== "open";
  $("#settlement-fields").classList.toggle("hidden", !settled);
  $("#wager-return").required = settled;
  $("#wager-settled-at").required = settled;
  if (settled && !$("#wager-settled-at").value) $("#wager-settled-at").value = localDateTimeInput();
  if (!settled) {
    $("#wager-return").value = "";
    $("#wager-settled-at").value = "";
  }
}

function openNewWager() {
  editingWagerId = null;
  wagerOriginalSource = "manual";
  clearWagerImagePreview(false);
  $("#wager-form").reset();
  $("#wager-title").textContent = "记录投注";
  $("#wager-save-button").textContent = "加密保存投注";
  $("#wager-placed-at").value = localDateTimeInput();
  $("#wager-settled-at").value = "";
  $("#wager-fee").value = "0";
  setError("#wager-error");
  syncSettlementFields();
  wagerDialog.showModal();
  $("#wager-event").focus();
}

function openEditWager(id) {
  const wager = session.state.wagers.find((item) => item.id === id);
  if (!wager) return;
  editingWagerId = wager.id;
  wagerOriginalSource = wager.source === "image" ? "image" : "manual";
  clearWagerImagePreview(false);
  wagerEntrySource = wagerOriginalSource;
  $("#wager-title").textContent = wager.status === "open" ? "投注记录 / 结算" : "编辑已记录投注";
  $("#wager-save-button").textContent = "加密保存更改";
  $("#wager-event").value = wager.event;
  $("#wager-sport").value = wager.sport;
  $("#wager-league").value = wager.league;
  $("#wager-market").value = wager.market;
  $("#wager-platform").value = wager.platform;
  $("#wager-odds").value = wager.oddsMilli == null ? "" : (wager.oddsMilli / 1000).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  $("#wager-stake").value = (wager.stakeMinor / 100).toFixed(2);
  $("#wager-combo").value = wager.combo ?? "single";
  $("#wager-status").value = wager.status;
  $("#wager-placed-at").value = localDateTimeInput(new Date(wager.placedAt));
  $("#wager-return").value = wager.actualReturnMinor == null ? "" : (wager.actualReturnMinor / 100).toFixed(2);
  $("#wager-fee").value = (wager.feeMinor / 100).toFixed(2);
  $("#wager-settled-at").value = wager.settledAt ? localDateTimeInput(new Date(wager.settledAt)) : "";
  $("#wager-result").value = wager.result ?? "";
  $("#wager-tags").value = (wager.tags ?? []).join(", ");
  $("#wager-note").value = wager.note ?? "";
  $("#wager-state").value = wager.beforeState ?? "";
  setError("#wager-error");
  syncSettlementFields();
  wagerDialog.showModal();
}

async function deleteWager(id) {
  if (!session || saveBusy) return;
  const wager = session.state.wagers.find((item) => item.id === id);
  if (!wager || !confirm(`删除“${wager.event}” ${formatMoney(wager.stakeMinor)} 的投注记录？本机审计历史会保留删除时间。`)) return;
  let nextState = { ...session.state, sequence: session.state.sequence + 1, wagers: session.state.wagers.filter((item) => item.id !== id) };
  nextState.auditLog = appendAudit(nextState, "wager", id, "delete", wager, null);
  saveBusy = true;
  try {
    const health = await commitState(nextState, session.key);
    session.state = nextState;
    render();
    updateHealthDisplay(health);
    await refreshHealth();
  } catch (error) { alert(`删除失败：${error.message}`); }
  finally { saveBusy = false; finishPendingLock(); }
}

function parseOptionalLimit(selector) {
  const value = amountInputMinor($(selector).value);
  if (value === null) return null;
  return Number.isSafeInteger(value) ? value : NaN;
}

function windowMinutes(start, end) {
  if (!start || !end) return null;
  const parse = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  return (parse(end) - parse(start) + 1440) % 1440;
}

function timeWindowIsSubset(previousStart, previousEnd, nextStart, nextEnd) {
  if (!previousStart || !previousEnd) return true;
  if (!nextStart || !nextEnd) return false;
  const parse = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const previousLength = windowMinutes(previousStart, previousEnd);
  const nextLength = windowMinutes(nextStart, nextEnd);
  const offset = (parse(nextStart) - parse(previousStart) + 1440) % 1440;
  return nextLength <= previousLength && offset + nextLength <= previousLength;
}

async function saveRiskSettings(event) {
  event.preventDefault();
  if (!session || saveBusy) return;
  const settings = session.state.riskSettings;
  const proposed = {
    ...settings,
    period: $("#risk-period").value,
    budgetMinor: parseOptionalLimit("#risk-budget-input"),
    lossLimitMinor: parseOptionalLimit("#risk-loss-input"),
    maxStakeMinor: parseOptionalLimit("#risk-max-input"),
    allowedStart: $("#risk-time-start").value,
    allowedEnd: $("#risk-time-end").value,
  };
  if ([proposed.budgetMinor, proposed.lossLimitMinor, proposed.maxStakeMinor].some(Number.isNaN)) return setError("#risk-settings-error", "金额无效，请用两位小数或留空。");
  if (Boolean(proposed.allowedStart) !== Boolean(proposed.allowedEnd)) return setError("#risk-settings-error", "允许时段需要同时填写开始和结束时间，或都留空。");
  if (proposed.allowedStart && proposed.allowedStart === proposed.allowedEnd) return setError("#risk-settings-error", "允许时段的开始和结束不能相同。");
  if (proposed.period !== settings.period && cycleHasActivity(settings.period)) return setError("#risk-settings-error", "本周期已有记录，预算周期将在下一周期开始后才能切换。");
  const activity = cycleHasActivity(settings.period);
  const currentData = currentCycleData();
  if (settings.budgetMinor == null && proposed.budgetMinor != null && currentData.budgetUsed > 0 && proposed.budgetMinor > currentData.budgetUsed) return setError("#risk-settings-error", `本周期已有投注；首次设定预算不能高于已用额度 ${formatMoney(currentData.budgetUsed)}。`);
  if (settings.lossLimitMinor == null && proposed.lossLimitMinor != null && currentData.riskExposure > 0 && proposed.lossLimitMinor > currentData.riskExposure) return setError("#risk-settings-error", `已有风险敞口；首次设定亏损上限不能高于当前风险占用 ${formatMoney(currentData.riskExposure)}。`);
  if (settings.maxStakeMinor == null && proposed.maxStakeMinor != null && currentData.maxRecordedStake > 0 && proposed.maxStakeMinor > currentData.maxRecordedStake) return setError("#risk-settings-error", `已有投注；首次设定单笔上限不能高于当前周期最大单笔或未结算投注 ${formatMoney(currentData.maxRecordedStake)}。`);
  const raised = ["budgetMinor", "lossLimitMinor", "maxStakeMinor"].some((key) => {
    const oldValue = settings[key], newValue = proposed[key];
    return oldValue != null && (newValue == null || newValue > oldValue);
  });
  const timeWindowWidened = !timeWindowIsSubset(settings.allowedStart, settings.allowedEnd, proposed.allowedStart, proposed.allowedEnd);
  if (activity && (raised || timeWindowWidened)) return setError("#risk-settings-error", "本周期已有投注记录，不能提高/取消金额上限或放宽时段；可降低上限，放宽设置下周期再生效。");
  let nextState = { ...session.state, sequence: session.state.sequence + 1, riskSettings: proposed };
  nextState.auditLog = appendAudit(nextState, "settings", "risk", "edit", settings, proposed);
  saveBusy = true;
  try {
    await commitState(nextState, session.key);
    session.state = nextState;
    render();
    setError("#risk-settings-error", "设置已加密保存。");
  } catch (error) { setError("#risk-settings-error", `保存失败：${error.message}`); }
  finally { saveBusy = false; finishPendingLock(); }
}

function cycleHasActivity(period) {
  const info = currentPeriodInfo(period);
  return session.state.wagers.some((wager) => {
    if (wager.status === "open") return true;
    const placed = localDateFromTimestamp(wager.placedAt);
    const settled = localDateFromTimestamp(wager.settledAt);
    return (placed >= info.start && placed <= info.end) || (settled >= info.start && settled <= info.end);
  }) || session.state.records.some((record) => isLegacyBetRecord(record) && record.date >= info.start && record.date <= info.end);
}

async function stopCycle() {
  const settings = session.state.riskSettings;
  const key = currentPeriodInfo(settings.period).key;
  if (settings.stoppedPeriodKey === key || !confirm("停止本周期在本工具内新增投注记录？此操作不能提前解除，会在下个预算周期开始时自动解除。")) return;
  await saveRiskAction({ ...settings, stoppedPeriodKey: key }, "stop-period");
}

async function startCooloff(hours) {
  const currentUntil = new Date(session.state.riskSettings.cooloffUntil ?? 0).getTime();
  const until = Math.max(currentUntil, Date.now() + hours * 60 * 60 * 1000);
  if (!confirm(`开启 ${hours === 24 ? "24 小时" : "7 天"}冷静期？期间本工具会拒绝新增投注记录。`)) return;
  await saveRiskAction({ ...session.state.riskSettings, cooloffUntil: new Date(until).toISOString() }, `cooloff-${hours}h`);
}

async function saveRiskAction(settings, action) {
  if (!session || saveBusy) return;
  let nextState = { ...session.state, sequence: session.state.sequence + 1, riskSettings: settings };
  nextState.auditLog = appendAudit(nextState, "settings", "risk", action, session.state.riskSettings, settings);
  saveBusy = true;
  try {
    await commitState(nextState, session.key);
    session.state = nextState;
    render();
  } catch (error) { alert(`保存保护操作失败：${error.message}`); }
  finally { saveBusy = false; finishPendingLock(); }
}

async function refreshHealth() {
  persistentStorageRequest ??= requestPersistentStorage();
  const persistent = await persistentStorageRequest;
  const health = await readStorageHealth();
  const label = health.persisted ? "持久存储已启用" : persistent ? "已申请持久存储" : "浏览器未保证长期保留";
  $("#storage-status").textContent = label;
  const meter = $("#storage-meter");
  const warning = $("#quota-warning");
  if (health.usage != null && health.quota != null) {
    const used = `${(health.usage / 1024 / 1024).toFixed(1)} MB`;
    const limit = `${(health.quota / 1024 / 1024).toFixed(0)} MB`;
    const ratio = Math.round((health.ratio ?? 0) * 100);
    meter.textContent = `本机存储 ${used} / ${limit}`;
    if ((health.ratio ?? 0) >= 0.8) {
      warning.textContent = `浏览器存储空间已使用约 ${ratio}%。请清理设备中不相关的内容；不要清除筹记的网站数据，否则账本可能永久丢失。`;
      warning.classList.remove("hidden");
    } else {
      warning.classList.add("hidden");
    }
  } else {
    meter.textContent = "浏览器未提供存储配额信息";
  }
}

async function saveEntry(event) {
  event.preventDefault();
  if (!session || saveBusy) return;
  const amountText = $("#entry-amount").value.trim();
  const amountParts = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(amountText);
  const amountMinor = amountParts ? Number(amountParts[1]) * 100 + Number((amountParts[2] ?? "").padEnd(2, "0")) : 0;
  if (!amountParts || amountMinor <= 0 || !Number.isSafeInteger(amountMinor)) {
    setError("#entry-error", "请输入有效金额（最多两位小数）。");
    return;
  }
  const date = $("#entry-date").value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(`${date}T12:00:00`).getTime())) {
    setError("#entry-error", "请选择有效日期。");
    return;
  }
  saveBusy = true;
  const kind = $("#entry-kind").value;
  const type = TYPE[kind];
  const current = editingRecordId ? session.state.records.find((item) => item.id === editingRecordId) : null;
  if (!type || (editingRecordId && !current)) {
    setError("#entry-error", "这条记录已不存在，请关闭后刷新账本。");
    saveBusy = false;
    return;
  }
  if (!current && ["stake", "payout"].includes(kind)) {
    setError("#entry-error", "请用“记录投注”逐注记录新投注。旧版未关联支出和返还只用于保留、纠正历史流水。 ");
    saveBusy = false;
    return;
  }
  const record = {
    id: current?.id ?? crypto.randomUUID(),
    kind,
    amountMinor,
    deltaMinor: amountMinor * type.delta,
    date,
    note: $("#entry-note").value.trim(),
    createdAt: current?.createdAt ?? new Date().toISOString(),
    ...(kind === "refund" && !current ? { legacyType: false } : {}),
    ...(current?.legacyType !== undefined ? { legacyType: current.legacyType } : {}),
    ...(current ? { updatedAt: new Date().toISOString() } : {}),
  };
  const records = current
    ? session.state.records.map((item) => item.id === current.id ? record : item)
    : [record, ...session.state.records];
  let nextState = { ...session.state, sequence: session.state.sequence + 1, records };
  nextState.auditLog = appendAudit(nextState, "record", record.id, current ? "edit" : "create", current, record);
  try {
    const health = await commitState(nextState, session.key);
    session.state = nextState;
    setError("#entry-error");
    dialog.close();
    render();
    updateHealthDisplay(health);
    await refreshHealth();
  } catch (error) {
    setError("#entry-error", `保存失败，界面未报告为已保存：${error.message}`);
  } finally {
    saveBusy = false;
    finishPendingLock();
  }
}

function openNewEntry() {
  editingRecordId = null;
  forms.entry.reset();
  $("#entry-date").value = localDateInput();
  $("#entry-title").textContent = "新增记录";
  $("#entry-save-button").textContent = "加密保存";
  setError("#entry-error");
  dialog.showModal();
  $("#entry-amount").focus();
}

function openEditEntry(recordId) {
  const record = session?.state.records.find((item) => item.id === recordId);
  if (!record) return;
  editingRecordId = record.id;
  $("#entry-kind").value = record.kind;
  $("#entry-amount").value = (record.amountMinor / 100).toFixed(2);
  $("#entry-date").value = record.date;
  $("#entry-note").value = record.note;
  $("#entry-title").textContent = "编辑记录";
  $("#entry-save-button").textContent = "加密保存更改";
  setError("#entry-error");
  dialog.showModal();
  $("#entry-amount").focus();
}

async function deleteEntry(recordId) {
  if (!session || saveBusy) return;
  const record = session.state.records.find((item) => item.id === recordId);
  if (!record) return;
  const type = TYPE[record.kind];
  if (!confirm(`删除这条${type.label} ${formatMoney(record.amountMinor)}记录？删除会写入新的加密快照。`)) return;
  saveBusy = true;
  try {
    const nextState = {
      ...session.state,
      sequence: session.state.sequence + 1,
      records: session.state.records.filter((item) => item.id !== recordId),
    };
    nextState.auditLog = appendAudit(nextState, "record", recordId, "delete", record, null);
    const health = await commitState(nextState, session.key);
    session.state = nextState;
    render();
    updateHealthDisplay(health);
    await refreshHealth();
  } catch (error) {
    alert(`删除失败，账本保持不变：${error.message}`);
  } finally {
    saveBusy = false;
    finishPendingLock();
  }
}

function updateHealthDisplay(health) {
  if (health?.ratio != null && health.ratio >= 0.8) {
    $("#quota-warning").textContent = "存储空间接近上限。请及时检查浏览器存储。";
    $("#quota-warning").classList.remove("hidden");
  }
}

function localDateInput(offsetDays = 0) {
  const now = new Date();
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

async function refreshVaultState() {
  try {
    const exists = await hasVault();
    showVault(!exists);
  } catch (error) {
    setError("#vault-error", `无法读取本机账本：${error.message}`);
  }
}

function downloadEncryptedBackup(bundle) {
  const content = JSON.stringify(bundle);
  const file = new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = `chouji-encrypted-backup-${localDateInput()}.json`;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function minorCsv(minor) {
  const value = Math.abs(minor);
  return `${minor < 0 ? "-" : ""}${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}`;
}

function oddsCsv(oddsMilli) {
  if (oddsMilli == null) return "";
  return `${Math.floor(oddsMilli / 1000)}.${String(oddsMilli % 1000).padStart(3, "0")}`.replace(/0+$/, "").replace(/\.$/, "");
}

function csvCell(value, numeric = false) {
  let text = String(value ?? "");
  const firstVisible = text.replace(/^[\s\u0000-\u001f\u00a0\ufeff]+/u, "");
  if (!numeric && (/^[=+\-@]/.test(firstVisible) || /^[\u0000-\u001f]/.test(text))) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function exportCsv() {
  if (!session) return;
  const wagerCount = session.state.wagers.length;
  const recordCount = session.state.records.length;
  if (wagerCount + recordCount === 0) {
    $("#backup-status").textContent = "账本还没有记录可导出。";
    return;
  }
  if (!confirm(`将生成未加密 CSV，包含 ${wagerCount} 笔投注和 ${recordCount} 笔资金/旧版流水，以及事件、平台与备注等个人信息。文件保存到本机后不会再受账本加密保护，请只存入安全位置。继续？`)) return;

  const headers = ["记录类别", "投注/流水时间", "结算时间", "比赛/事件", "运动/类别", "联赛", "玩法", "平台", "赔率", "记录金额(CNY)", "类型", "结算状态", "实际返还(CNY)", "投注净结果(CNY)", "手续费(CNY)", "赛果", "标签", "下注前状态", "资金变动(CNY)", "备注", "来源"];
  const numericColumns = new Set([8, 9, 12, 13, 14, 18]);
  const rows = [headers];
  for (const wager of session.state.wagers) {
    const cashChange = -wager.stakeMinor + (wager.status === "open" ? 0 : wager.actualReturnMinor - wager.feeMinor);
    rows.push([
      "逐注投注", wager.placedAt, wager.settledAt ?? "", wager.event, wager.sport, wager.league, wager.market, wager.platform,
      oddsCsv(wager.oddsMilli), minorCsv(wager.stakeMinor), wager.combo === "parlay" ? "串关" : "单关", WAGER_STATUS[wager.status] ?? wager.status,
      wager.status === "open" ? "" : minorCsv(wager.actualReturnMinor), wager.status === "open" ? "" : minorCsv(wagerResult(wager)),
      wager.status === "open" ? "" : minorCsv(wager.feeMinor), wager.result, (wager.tags ?? []).join("; "), wager.beforeState,
      minorCsv(cashChange), wager.note, wager.source === "image" ? "图片识别" : "手工录入",
    ]);
  }
  for (const record of session.state.records) {
    const legacy = isLegacyBetRecord(record);
    rows.push([
      legacy ? "旧版未关联流水" : "资金流水", record.date, "", "", "", "", "", "", "", minorCsv(record.amountMinor),
      TYPE[record.kind]?.label ?? record.kind, legacy ? "结算状态未知" : "资金记录", "", "", "", "", "", "", minorCsv(record.deltaMinor),
      record.note, legacy ? "旧版记录" : "手工录入",
    ]);
  }
  const content = `\uFEFF${rows.map((row) => row.map((value, index) => csvCell(value, numericColumns.has(index))).join(",")).join("\r\n")}`;
  const file = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = `chouji-records-${localDateInput()}.csv`;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  $("#backup-status").textContent = `已生成明文 CSV（${wagerCount + recordCount} 条）。它未加密，请保存到安全位置。`;
}

forms.create.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = $("#new-password").value;
  if (password.length < 10) return setError("#vault-error", "账本密码至少需要 10 个字符。");
  if (password !== $("#confirm-password").value) return setError("#vault-error", "两次输入的密码不一致。");
  if (!confirm("密码无法重置。忘记密码或清除本浏览器网站数据后，账本和快照都无法恢复。继续创建？")) return;
  const button = forms.create.querySelector("button[type=submit]");
  button.disabled = true;
  $("#new-password").value = "";
  $("#confirm-password").value = "";
  try {
    session = await createVault(password);
    setError("#vault-error");
    showLedger();
  } catch (error) {
    setError("#vault-error", `创建失败：${error.message}`);
  } finally {
    button.disabled = false;
  }
});

forms.unlock.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = forms.unlock.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    session = await unlockVault($("#vault-password").value);
    $("#vault-password").value = "";
    setError("#vault-error");
    showLedger();
  } catch (error) {
    setError("#vault-error", error.message);
  } finally {
    button.disabled = false;
  }
});

forms.entry.addEventListener("submit", saveEntry);
$$(`[data-open-form]`).forEach((button) => button.addEventListener("click", openNewEntry));
$$(`[data-open-wager]`).forEach((button) => button.addEventListener("click", openNewWager));
$$(`[data-page]`).forEach((button) => button.addEventListener("click", () => setPage(button.dataset.page)));
$$(`[data-filter]`).forEach((button) => button.addEventListener("click", () => {
  activeFilter = button.dataset.filter;
  renderRecords();
}));
$$(`[data-period]`).forEach((button) => button.addEventListener("click", () => {
  activeAnalysisPeriod = button.dataset.period;
  if (activeAnalysisPeriod === "custom") {
    const today = localDateInput();
    if (!$("#analysis-end").value) $("#analysis-end").value = today;
    if (!$("#analysis-start").value) $("#analysis-start").value = `${today.slice(0, 8)}01`;
  }
  renderAnalysis();
}));
$$(`[data-date-basis]`).forEach((button) => button.addEventListener("click", () => {
  analysisDateBasis = button.dataset.dateBasis;
  renderAnalysis();
}));
$("#analysis-start").addEventListener("change", renderAnalysis);
$("#analysis-end").addEventListener("change", renderAnalysis);
$("#analysis-dimension").addEventListener("change", renderAnalysis);
$("#wager-search").addEventListener("input", renderRecords);
$("#clear-wager-drilldown").addEventListener("click", () => {
  activeWagerDrilldown = null;
  renderRecords();
});
$$(`[data-wager-filter]`).forEach((button) => button.addEventListener("click", () => {
  activeWagerFilter = button.dataset.wagerFilter;
  renderRecords();
}));
$("#wager-status").addEventListener("change", syncSettlementFields);
$("#wager-form").addEventListener("submit", saveWager);
$("#wager-image-input").addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  selectWagerImage(file);
});
$("#remove-wager-image").addEventListener("click", () => clearWagerImagePreview(true));
$("#close-wager-dialog").addEventListener("click", () => wagerDialog.close());
wagerDialog.addEventListener("close", () => {
  editingWagerId = null;
  wagerOriginalSource = "manual";
  clearWagerImagePreview(false);
  $("#wager-form").reset();
  setError("#wager-error");
});
$("#risk-settings-form").addEventListener("submit", saveRiskSettings);
$("#stop-cycle-button").addEventListener("click", stopCycle);
$("#cooloff-day-button").addEventListener("click", () => startCooloff(24));
$("#cooloff-week-button").addEventListener("click", () => startCooloff(24 * 7));
$("#close-dialog").addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => {
  editingRecordId = null;
  forms.entry.reset();
  $("#entry-date").value = localDateInput();
  $("#entry-title").textContent = "新增记录";
  $("#entry-save-button").textContent = "加密保存";
  setError("#entry-error");
});
$("#backup-import-button").addEventListener("click", () => $("#backup-file-input").click());
$("#backup-file-input").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) {
    setError("#vault-error", "备份文件超过 20 MB，已取消导入。");
    return;
  }
  try {
    pendingBackup = JSON.parse(await file.text());
    if (pendingBackup?.format !== "chouji-encrypted-backup" || pendingBackup?.version !== 1) throw new Error("文件格式不正确。");
    setError("#vault-error");
    setError("#backup-import-error");
    backupDialog.showModal();
    $("#backup-password").focus();
  } catch (error) {
    pendingBackup = null;
    setError("#vault-error", `无法读取加密备份：${error.message}`);
  }
});
$("#close-backup-dialog").addEventListener("click", () => backupDialog.close());
backupDialog.addEventListener("close", () => {
  pendingBackup = null;
  $("#backup-password").value = "";
  setError("#backup-import-error");
});
$("#backup-import-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!pendingBackup) return setError("#backup-import-error", "请先选择备份文件。");
  const button = $("#backup-import-submit");
  button.disabled = true;
  const password = $("#backup-password").value;
  $("#backup-password").value = "";
  try {
    session = await importEncryptedBackup(pendingBackup, password);
    backupDialog.close();
    setError("#vault-error");
    showLedger();
  } catch (error) {
    setError("#backup-import-error", error.message);
  } finally {
    button.disabled = false;
  }
});
screens.ledger.addEventListener("click", (event) => {
  const editButton = event.target.closest("[data-edit-id]");
  const deleteButton = event.target.closest("[data-delete-id]");
  const editWagerButton = event.target.closest("[data-edit-wager-id]");
  const deleteWagerButton = event.target.closest("[data-delete-wager-id]");
  const drillButton = event.target.closest("[data-wager-dimension]");
  if (editButton) openEditEntry(editButton.dataset.editId);
  if (deleteButton) deleteEntry(deleteButton.dataset.deleteId);
  if (editWagerButton) openEditWager(editWagerButton.dataset.editWagerId);
  if (deleteWagerButton) deleteWager(deleteWagerButton.dataset.deleteWagerId);
  if (drillButton) {
    $("#wager-search").value = "";
    activeWagerDrilldown = {
      dimension: drillButton.dataset.wagerDimension,
      value: drillButton.dataset.wagerValue,
      dateBasis: analysisDateBasis,
      range: analysisRange(),
    };
    activeWagerFilter = "all";
    setPage("records");
  }
});
$("#lock-button").addEventListener("click", () => {
  if (!saveBusy) lockApp();
});
$("#backup-export-button").addEventListener("click", async () => {
  if (!session) return;
  const button = $("#backup-export-button");
  button.disabled = true;
  try {
    const backup = await exportEncryptedBackup();
    downloadEncryptedBackup(backup);
    $("#backup-status").textContent = "已导出加密备份。请把文件保存在安全位置，并记住账本密码。";
  } catch (error) {
    $("#backup-status").textContent = `备份导出失败：${error.message}`;
  } finally {
    button.disabled = false;
  }
});
$("#csv-export-button").addEventListener("click", exportCsv);
$("#restore-button").addEventListener("click", async () => {
  if (!session || session.state.sequence <= 1 || saveBusy) return;
  if (!confirm("上一份快照会覆盖当前主账本。将以恢复结果作为新版本，并生成新的加密快照。继续？")) return;
  saveBusy = true;
  try {
    const recovered = await restorePrevious(session.key, session.state.sequence);
    const restoredState = { ...recovered, sequence: session.state.sequence + 1 };
    const health = await commitState(restoredState, session.key);
    session.state = restoredState;
    render();
    updateHealthDisplay(health);
    await refreshHealth();
  } catch (error) {
    alert(`恢复失败，当前主账本未被替换：${error.message}`);
  } finally {
    saveBusy = false;
    render();
    finishPendingLock();
  }
});
$("#install-button").addEventListener("click", async () => {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    $("#install-button").classList.add("hidden");
  } else {
    alert("在 Safari 分享菜单中选择“添加到主屏幕”。");
  }
});

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  $("#install-button").classList.remove("hidden");
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && session) {
    if (saveBusy) lockPending = true;
    else lockApp();
  }
});

if ("serviceWorker" in navigator && (location.protocol === "https:" || ["localhost", "127.0.0.1"].includes(location.hostname))) {
  navigator.serviceWorker.register("./sw.js").catch((error) => console.warn("Offline shell registration failed", error));
}

if (location.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(location.hostname)) {
  setError("#vault-error", "请通过 HTTPS 打开筹记，安全加密和离线安装需要安全来源。");
}

refreshVaultState();

