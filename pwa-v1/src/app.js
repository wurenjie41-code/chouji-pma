import { commitState, createVault, exportEncryptedBackup, hasVault, importEncryptedBackup, readStorageHealth, requestPersistentStorage, restorePrevious, unlockVault } from "./storage.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const screens = { vault: $("#vault-screen"), ledger: $("#ledger-screen") };
const forms = { create: $("#create-vault-form"), unlock: $("#unlock-form"), entry: $("#entry-form") };
const dialog = $("#entry-dialog");
const backupDialog = $("#backup-import-dialog");
const TYPE = {
  stake: { label: "投注支出", delta: -1, color: "out", group: "bet" },
  payout: { label: "派彩返还", delta: 1, color: "in", group: "bet" },
  deposit: { label: "账户存入", delta: 1, color: "in", group: "movement" },
  withdrawal: { label: "账户取出", delta: -1, color: "out", group: "movement" },
  refund: { label: "退款 / 退回", delta: 1, color: "in", group: "bet" },
};
const PAGES = ["overview", "records", "analysis"];

let session = null;
let deferredInstallPrompt = null;
let saveBusy = false;
let editingRecordId = null;
let persistentStorageRequest;
let lockPending = false;
let activePage = "overview";
let activeFilter = "all";
let activePeriod = "7";
let pendingBackup = null;

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

function calculate(records) {
  const betRecords = records.filter((record) => TYPE[record.kind]?.group === "bet");
  const net = betRecords.reduce((sum, record) => sum + record.deltaMinor, 0);
  const stake = betRecords.filter((record) => record.kind === "stake").reduce((sum, record) => sum + record.amountMinor, 0);
  const returned = betRecords.filter((record) => ["payout", "refund"].includes(record.kind)).reduce((sum, record) => sum + record.amountMinor, 0);
  return { net, stake, returned, count: records.length };
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

function renderOverview() {
  const allRecords = session.state.records;
  const totals = calculate(allRecords);
  $("#net-total").textContent = formatMoney(totals.net);
  $("#net-total").classList.toggle("negative", totals.net < 0);
  $("#stake-total").textContent = formatMoney(allRecords.filter((r) => r.kind === "stake").reduce((sum, r) => sum + r.amountMinor, 0));
  $("#return-total").textContent = formatMoney(allRecords.filter((r) => ["payout", "refund"].includes(r.kind)).reduce((sum, r) => sum + r.amountMinor, 0));
  $("#entry-count").textContent = String(allRecords.length);

  const weekRecords = recordsInPeriod("7");
  const weekTotals = calculate(weekRecords);
  $("#week-net").textContent = formatMoney(weekTotals.net);
  $("#week-net").classList.toggle("negative", weekTotals.net < 0);
  $("#week-stake").textContent = formatMoney(weekTotals.stake);
  $("#week-return").textContent = formatMoney(weekTotals.returned);
  renderTrend($("#week-chart"), weekRecords, "7", true);

  const sorted = [...allRecords].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  $("#overview-empty-state").classList.toggle("hidden", sorted.length !== 0);
  const recent = $("#overview-recent-list");
  recent.replaceChildren(...sorted.slice(0, 4).map((record) => createEntryRow(record)));
}

function renderRecords() {
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

function renderAnalysis() {
  const records = recordsInPeriod(activePeriod);
  const totals = calculate(records);
  $("#analysis-net").textContent = formatMoney(totals.net);
  $("#analysis-net").classList.toggle("negative", totals.net < 0);
  $("#analysis-stake").textContent = formatMoney(totals.stake);
  $("#analysis-return").textContent = formatMoney(totals.returned);
  $("#analysis-rate").textContent = totals.stake === 0 ? "—" : `${(totals.net / totals.stake * 100).toFixed(1)}%`;
  $("#analysis-rate").classList.toggle("negative", totals.net < 0);
  const periodLabel = activePeriod === "all" ? "全部记录" : `近 ${activePeriod} 天`;
  $("#trend-title").textContent = activePeriod === "all" ? "每月净结果" : "每日净结果";
  $("#analysis-trend").classList.toggle("hidden", !records.some((record) => TYPE[record.kind]?.group === "bet"));
  $("#analysis-no-trend").classList.toggle("hidden", records.some((record) => TYPE[record.kind]?.group === "bet"));
  renderTrend($("#analysis-trend"), records, activePeriod, false);
  renderBreakdown(records);
  $("#analysis-period-label").textContent = `${periodLabel} · ${records.length} 笔流水`;
  $$(`[data-period]`).forEach((button) => {
    const selected = button.dataset.period === activePeriod;
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
    if (TYPE[record.kind]?.group !== "bet") continue;
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
  const record = {
    id: current?.id ?? crypto.randomUUID(),
    kind,
    amountMinor,
    deltaMinor: amountMinor * type.delta,
    date,
    note: $("#entry-note").value.trim(),
    createdAt: current?.createdAt ?? new Date().toISOString(),
    ...(current ? { updatedAt: new Date().toISOString() } : {}),
  };
  const records = current
    ? session.state.records.map((item) => item.id === current.id ? record : item)
    : [record, ...session.state.records];
  const nextState = { ...session.state, sequence: session.state.sequence + 1, records };
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
$$(`[data-page]`).forEach((button) => button.addEventListener("click", () => setPage(button.dataset.page)));
$$(`[data-filter]`).forEach((button) => button.addEventListener("click", () => {
  activeFilter = button.dataset.filter;
  renderRecords();
}));
$$(`[data-period]`).forEach((button) => button.addEventListener("click", () => {
  activePeriod = button.dataset.period;
  renderAnalysis();
}));
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
  if (editButton) openEditEntry(editButton.dataset.editId);
  if (deleteButton) deleteEntry(deleteButton.dataset.deleteId);
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

