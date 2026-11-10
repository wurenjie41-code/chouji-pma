import { commitState, createVault, hasVault, readStorageHealth, requestPersistentStorage, restorePrevious, unlockVault } from "./storage.js";

const $ = (selector) => document.querySelector(selector);
const screens = { vault: $("#vault-screen"), ledger: $("#ledger-screen") };
const forms = { create: $("#create-vault-form"), unlock: $("#unlock-form"), entry: $("#entry-form") };
const dialog = $("#entry-dialog");
const TYPE = {
  stake: { label: "投注支出", delta: -1, color: "out" },
  payout: { label: "派彩返还", delta: 1, color: "in" },
  deposit: { label: "账户存入", delta: 1, color: "in" },
  withdrawal: { label: "账户取出", delta: -1, color: "out" },
  refund: { label: "退款 / 退回", delta: 1, color: "in" },
};

let session = null;
let deferredInstallPrompt = null;
let saveBusy = false;
let editingRecordId = null;
let persistentStorageRequest;
let lockPending = false;

function formatMoney(minor) {
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" }).format(minor / 100);
}

function formatDate(value) {
  const date = new Date(`${value}T12:00:00`);
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(date);
}

function setError(selector, message = "") {
  $(selector).textContent = message;
}

function showVault(createMode) {
  screens.vault.classList.remove("hidden");
  screens.ledger.classList.add("hidden");
  forms.create.classList.toggle("hidden", !createMode);
  forms.unlock.classList.toggle("hidden", createMode);
  $("#lock-button").classList.add("hidden");
}

function showLedger() {
  screens.vault.classList.add("hidden");
  screens.ledger.classList.remove("hidden");
  $("#lock-button").classList.remove("hidden");
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

function calculate() {
  const records = session.state.records;
  const net = records.filter((record) => ["stake", "payout", "refund"].includes(record.kind)).reduce((sum, record) => sum + record.deltaMinor, 0);
  const stake = records.filter((record) => record.kind === "stake").reduce((sum, record) => sum + record.amountMinor, 0);
  const returned = records.filter((record) => ["payout", "refund"].includes(record.kind)).reduce((sum, record) => sum + record.amountMinor, 0);
  return { net, stake, returned };
}

function render() {
  if (!session) return;
  const totals = calculate();
  $("#net-total").textContent = formatMoney(totals.net);
  $("#net-total").classList.toggle("negative", totals.net < 0);
  $("#stake-total").textContent = formatMoney(totals.stake);
  $("#return-total").textContent = formatMoney(totals.returned);
  $("#entry-count").textContent = String(session.state.records.length);
  const list = $("#entry-list");
  list.replaceChildren();
  const sorted = [...session.state.records].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  $("#empty-state").classList.toggle("hidden", sorted.length !== 0);
  for (const record of sorted) {
    const type = TYPE[record.kind];
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
    subtitle.textContent = `${formatDate(record.date)}${record.note ? ` · ${record.note}` : ""}`;
    details.append(title, subtitle);
    const amount = document.createElement("strong");
    amount.className = `entry-amount ${type.color}`;
    amount.textContent = `${type.delta < 0 ? "−" : "+"}${formatMoney(record.amountMinor)}`;
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
    row.append(mark, details, amount, actions);
    list.append(row);
  }
  $("#restore-button").disabled = session.state.sequence <= 1;
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
  saveBusy = true;
  const kind = $("#entry-kind").value;
  const type = TYPE[kind];
  const current = editingRecordId ? session.state.records.find((item) => item.id === editingRecordId) : null;
  if (editingRecordId && !current) {
    setError("#entry-error", "这条记录已不存在，请关闭后刷新账本。");
    saveBusy = false;
    return;
  }
  const record = {
    id: current?.id ?? crypto.randomUUID(),
    kind,
    amountMinor,
    deltaMinor: amountMinor * type.delta,
    date: $("#entry-date").value,
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

function localDateInput() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

async function refreshVaultState() {
  try {
    const exists = await hasVault();
    showVault(!exists);
  } catch (error) {
    setError("#vault-error", `无法读取本机账本：${error.message}`);
  }
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
$("#add-button").addEventListener("click", openNewEntry);
$("[data-open-form]").addEventListener("click", () => $("#add-button").click());
$("#close-dialog").addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => {
  editingRecordId = null;
  forms.entry.reset();
  $("#entry-date").value = localDateInput();
  $("#entry-title").textContent = "新增记录";
  $("#entry-save-button").textContent = "加密保存";
  setError("#entry-error");
});
$("#entry-list").addEventListener("click", (event) => {
  const editButton = event.target.closest("[data-edit-id]");
  const deleteButton = event.target.closest("[data-delete-id]");
  if (editButton) openEditEntry(editButton.dataset.editId);
  if (deleteButton) deleteEntry(deleteButton.dataset.deleteId);
});
$("#lock-button").addEventListener("click", () => {
  if (!saveBusy) lockApp();
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
