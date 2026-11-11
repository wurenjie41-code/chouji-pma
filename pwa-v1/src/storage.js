const storageNamespace = encodeURIComponent(new URL("./", globalThis.location.href).pathname);
const DB_NAME = `chouji-local-v1-${storageNamespace}`;
const DB_VERSION = 1;
const STATE_KEY = "main";
const VAULT_KEY = "vault";
const SNAPSHOT_LIMIT = 5;
const PBKDF2_ITERATIONS = 600_000;
const AUDIT_LIMIT = 500;

function defaultRiskSettings() {
  return { period: "monthly", budgetMinor: null, lossLimitMinor: null, maxStakeMinor: null, allowedStart: "", allowedEnd: "", cooloffUntil: null, stoppedPeriodKey: null };
}

function normalizeState(state) {
  return {
    ...state,
    schemaVersion: 2,
    records: Array.isArray(state.records) ? state.records : [],
    wagers: Array.isArray(state.wagers) ? state.wagers : [],
    auditLog: Array.isArray(state.auditLog) ? state.auditLog.slice(-AUDIT_LIMIT) : [],
    riskSettings: { ...defaultRiskSettings(), ...(state.riskSettings ?? {}) },
  };
}

let databasePromise;

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    let blocked = false;
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "id" });
      if (!db.objectStoreNames.contains("state")) db.createObjectStore("state", { keyPath: "id" });
      if (!db.objectStoreNames.contains("snapshots")) db.createObjectStore("snapshots", { keyPath: "id" });
    };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) {
        db.close();
        return;
      }
      db.onversionchange = () => {
        db.close();
        databasePromise = undefined;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error("无法打开本机数据库"));
    request.onblocked = () => {
      blocked = true;
      reject(new Error("另一个筹记窗口正在更新数据库，请关闭重复页面后重试。"));
    };
  });
  databasePromise.catch(() => { databasePromise = undefined; });
  return databasePromise;
}

function createTransaction(db, stores, mode) {
  try {
    return db.transaction(stores, mode, { durability: "strict" });
  } catch {
    // Older Safari versions do not accept the optional durability argument.
    return db.transaction(stores, mode);
  }
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("数据库操作失败"));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("保存中断，数据没有确认写入。"));
    transaction.onerror = () => reject(transaction.error ?? new Error("本机存储发生错误。"));
  });
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveKey(password, salt, iterations = PBKDF2_ITERATIONS) {
  const webCrypto = globalThis.crypto;
  const material = await webCrypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return webCrypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptState(state, key) {
  const webCrypto = globalThis.crypto;
  const iv = webCrypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(state));
  const additionalData = new TextEncoder().encode(`chouji-local-v1:${state.sequence}`);
  const cipher = await webCrypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData }, key, plain);
  return { v: 1, sequence: state.sequence, updatedAt: new Date().toISOString(), iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(cipher)) };
}

async function decryptState(envelope, key) {
  const additionalData = new TextEncoder().encode(`chouji-local-v1:${envelope.sequence}`);
  const plain = await globalThis.crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(envelope.iv), additionalData },
    key,
    base64ToBytes(envelope.ciphertext)
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

export async function hasVault() {
  const db = await openDatabase();
  const tx = db.transaction("meta", "readonly");
  const value = await requestResult(tx.objectStore("meta").get(VAULT_KEY));
  return Boolean(value);
}

export async function createVault(password) {
  if (!globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues) throw new Error("此浏览器不支持安全加密，请使用最新版 Safari 或 Chrome 并通过 HTTPS 打开。 ");
  const db = await openDatabase();
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(password, salt);
  const state = normalizeState({ sequence: 1, createdAt: new Date().toISOString(), records: [] });
  const envelope = await encryptState(state, key);
  const tx = createTransaction(db, ["meta", "state", "snapshots"], "readwrite");
  tx.objectStore("meta").put({ id: VAULT_KEY, version: 1, salt: bytesToBase64(salt), kdf: "PBKDF2-SHA256", iterations: PBKDF2_ITERATIONS, createdAt: state.createdAt });
  tx.objectStore("state").put({ id: STATE_KEY, envelope });
  tx.objectStore("snapshots").put({ id: `snapshot-${state.sequence}`, sequence: state.sequence, createdAt: envelope.updatedAt, envelope });
  await transactionDone(tx);
  return { key, state };
}

export async function unlockVault(password) {
  const db = await openDatabase();
  const tx = createTransaction(db, ["meta", "state"], "readonly");
  const metaRequest = tx.objectStore("meta").get(VAULT_KEY);
  const stateRequest = tx.objectStore("state").get(STATE_KEY);
  const [meta, savedState] = await Promise.all([requestResult(metaRequest), requestResult(stateRequest)]);
  if (!meta || !savedState) throw new Error("账本信息不完整，当前数据可能已被清理。请勿重复创建新账本。 ");
  const key = await deriveKey(password, base64ToBytes(meta.salt));
  try {
    const state = normalizeState(await decryptState(savedState.envelope, key));
    return { key, state };
  } catch {
    throw new Error("密码错误，或本机加密数据已损坏。数据没有被修改。");
  }
}

export async function commitState(nextState, key) {
  const db = await openDatabase();
  nextState = normalizeState(nextState);
  const envelope = await encryptState(nextState, key);
  const tx = createTransaction(db, ["state", "snapshots"], "readwrite");
  const snapshots = tx.objectStore("snapshots");
  snapshots.put({ id: `snapshot-${nextState.sequence}`, sequence: nextState.sequence, createdAt: envelope.updatedAt, envelope });
  tx.objectStore("state").put({ id: STATE_KEY, envelope });
  const existingRequest = snapshots.getAll();
  existingRequest.onsuccess = () => {
    const rows = existingRequest.result.sort((a, b) => b.sequence - a.sequence);
    for (const stale of rows.slice(SNAPSHOT_LIMIT)) snapshots.delete(stale.id);
  };
  await transactionDone(tx);
  return readStorageHealth();
}

export async function restorePrevious(key, currentSequence) {
  const db = await openDatabase();
  const readTx = createTransaction(db, "snapshots", "readonly");
  const rows = await requestResult(readTx.objectStore("snapshots").getAll());
  const previous = rows.filter((row) => row.sequence < currentSequence).sort((a, b) => b.sequence - a.sequence)[0];
  if (!previous) throw new Error("还没有可恢复的上一份加密快照。 ");
  try {
    return normalizeState(await decryptState(previous.envelope, key));
  } catch {
    throw new Error("上一份快照无法解密，原账本保持不变。 ");
  }
}

export async function readStorageHealth() {
  const health = { persisted: null, usage: null, quota: null, ratio: null };
  try {
    if (navigator.storage?.persisted) health.persisted = await navigator.storage.persisted();
    if (navigator.storage?.estimate) {
      const estimate = await navigator.storage.estimate();
      health.usage = estimate.usage ?? null;
      health.quota = estimate.quota ?? null;
      health.ratio = health.quota ? health.usage / health.quota : null;
    }
  } catch {
    // Storage health is advisory; data writes still report IndexedDB errors.
  }
  return health;
}

export async function requestPersistentStorage() {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch {
    // The user agent can deny persistent storage without throwing.
  }
  return false;
}

export async function exportEncryptedBackup() {
  const db = await openDatabase();
  const tx = createTransaction(db, ["meta", "state", "snapshots"], "readonly");
  const [meta, savedState, snapshots] = await Promise.all([
    requestResult(tx.objectStore("meta").get(VAULT_KEY)),
    requestResult(tx.objectStore("state").get(STATE_KEY)),
    requestResult(tx.objectStore("snapshots").getAll()),
  ]);
  if (!meta || !savedState?.envelope) throw new Error("本机账本不完整，无法生成备份。");
  return {
    format: "chouji-encrypted-backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    meta,
    state: savedState.envelope,
    snapshots: snapshots.sort((a, b) => b.sequence - a.sequence).map(({ sequence, createdAt, envelope }) => ({ sequence, createdAt, envelope })),
  };
}

function isValidDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function validateState(state, expectedSequence) {
  if (!state || state.schemaVersion !== 2 || !Number.isSafeInteger(state.sequence) || state.sequence < 1 || state.sequence !== expectedSequence || !Array.isArray(state.records) || state.records.length > 100_000) {
    throw new Error("备份账本结构无效。");
  }
  const ids = new Set();
  for (const record of state.records) {
    const sign = { stake: -1, payout: 1, deposit: 1, withdrawal: -1, refund: 1, bonus: 1 }[record?.kind];
    if (!record || typeof record.id !== "string" || !record.id || record.id.length > 128 || ids.has(record.id)
      || !sign || !Number.isSafeInteger(record.amountMinor) || record.amountMinor <= 0
      || record.deltaMinor !== record.amountMinor * sign || !isValidDate(record.date)
      || typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))
      || typeof record.note !== "string" || record.note.length > 120
      || (record.legacyType != null && typeof record.legacyType !== "boolean")) {
      throw new Error("备份中存在无效流水，导入已取消。");
    }
    ids.add(record.id);
  }
  if (state.wagers != null && !Array.isArray(state.wagers)) throw new Error("备份投注数据结构无效。");
  if ((state.wagers?.length ?? 0) > 100_000) throw new Error("备份投注数量超出支持范围。");
  for (const wager of state.wagers ?? []) {
    const validStatus = ["open", "won", "lost", "void", "cashout"].includes(wager?.status);
    const settled = wager?.status !== "open";
    if (!wager || typeof wager.id !== "string" || !wager.id || ids.has(wager.id)
      || !Number.isSafeInteger(wager.stakeMinor) || wager.stakeMinor <= 0
      || !Number.isSafeInteger(wager.feeMinor) || wager.feeMinor < 0
      || !Number.isFinite(Date.parse(wager.placedAt)) || !validStatus
      || typeof wager.event !== "string" || !wager.event || wager.event.length > 160
      || !["sport", "league", "market", "platform", "result", "note", "beforeState", "source"].every((key) => typeof wager[key] === "string")
      || wager.sport.length > 60 || wager.league.length > 80 || wager.market.length > 120 || wager.platform.length > 80
      || wager.result.length > 160 || wager.note.length > 500 || wager.beforeState.length > 500
      || !["manual", "image"].includes(wager.source)
      || !Array.isArray(wager.tags) || wager.tags.length > 8 || wager.tags.some((tag) => typeof tag !== "string" || tag.length > 200)
      || typeof wager.createdAt !== "string" || !Number.isFinite(Date.parse(wager.createdAt))
      || (wager.updatedAt != null && (typeof wager.updatedAt !== "string" || !Number.isFinite(Date.parse(wager.updatedAt))))
      || !["single", "parlay"].includes(wager.combo ?? "single")
      || (wager.oddsMilli != null && (!Number.isSafeInteger(wager.oddsMilli) || wager.oddsMilli < 1000 || wager.oddsMilli > 1_000_000))
      || (settled && (!Number.isSafeInteger(wager.actualReturnMinor) || wager.actualReturnMinor < 0 || !Number.isFinite(Date.parse(wager.settledAt)) || Date.parse(wager.settledAt) < Date.parse(wager.placedAt)))
      || (!settled && (wager.actualReturnMinor != null || wager.settledAt != null))) {
      throw new Error("备份中存在无效投注，导入已取消。");
    }
    ids.add(wager.id);
  }
  if (state.riskSettings != null && (typeof state.riskSettings !== "object" || !["monthly", "weekly"].includes(state.riskSettings.period ?? "monthly"))) {
    throw new Error("备份风险设置结构无效。");
  }
  if (state.riskSettings) {
    for (const key of ["budgetMinor", "lossLimitMinor", "maxStakeMinor"]) {
      const value = state.riskSettings[key];
      if (value != null && (!Number.isSafeInteger(value) || value <= 0)) throw new Error("备份风险额度无效。");
    }
    for (const key of ["allowedStart", "allowedEnd"]) {
      const value = state.riskSettings[key] ?? "";
      if (value && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error("备份允许时段无效。");
    }
    const { cooloffUntil, stoppedPeriodKey } = state.riskSettings;
    if (cooloffUntil != null && (typeof cooloffUntil !== "string" || !Number.isFinite(Date.parse(cooloffUntil)))) throw new Error("备份冷静期无效。");
    if (stoppedPeriodKey != null && (typeof stoppedPeriodKey !== "string" || stoppedPeriodKey.length > 16)) throw new Error("备份周期锁无效。");
  }
  if (state.auditLog != null && (!Array.isArray(state.auditLog) || state.auditLog.length > AUDIT_LIMIT
    || state.auditLog.some((entry) => !entry || typeof entry.id !== "string" || typeof entry.entity !== "string"
      || typeof entry.entityId !== "string" || typeof entry.action !== "string" || !Number.isFinite(Date.parse(entry.at))))) {
    throw new Error("备份修改记录结构无效。");
  }
}

function validateEnvelope(envelope) {
  if (!envelope || envelope.v !== 1 || !Number.isSafeInteger(envelope.sequence) || envelope.sequence < 1
    || typeof envelope.iv !== "string" || typeof envelope.ciphertext !== "string") {
    throw new Error("加密备份格式无效。");
  }
}

export async function importEncryptedBackup(bundle, password) {
  if (!bundle || bundle.format !== "chouji-encrypted-backup" || bundle.version !== 1) {
    throw new Error("这不是受支持的筹记加密备份文件。");
  }
  const meta = bundle.meta;
  if (!meta || meta.id !== VAULT_KEY || meta.version !== 1 || meta.kdf !== "PBKDF2-SHA256"
    || !Number.isSafeInteger(meta.iterations) || meta.iterations < 100_000 || meta.iterations > 2_000_000) {
    throw new Error("备份的加密参数无效或版本不受支持。");
  }
  let salt;
  try { salt = base64ToBytes(meta.salt); } catch { throw new Error("备份的密钥盐值无效。"); }
  if (salt.length < 16 || salt.length > 64) throw new Error("备份的密钥盐值无效。");
  validateEnvelope(bundle.state);
  const snapshots = Array.isArray(bundle.snapshots) ? bundle.snapshots : [];
  if (snapshots.length > SNAPSHOT_LIMIT) throw new Error("备份快照数量超出支持范围。");

  const key = await deriveKey(password, salt, meta.iterations);
  let state;
  try {
    state = normalizeState(await decryptState(bundle.state, key));
    validateState(state, bundle.state.sequence);
  } catch (error) {
    if (error.message === "备份账本结构无效。" || error.message === "备份中存在无效流水，导入已取消。") throw error;
    throw new Error("密码不正确，或备份主账本已损坏。没有写入数据。");
  }

  const snapshotRows = [];
  for (const snapshot of snapshots) {
    validateEnvelope(snapshot.envelope);
    if (snapshot.sequence !== snapshot.envelope.sequence || snapshot.sequence > state.sequence) throw new Error("备份快照序号不匹配。");
    let snapshotState;
    try {
      snapshotState = normalizeState(await decryptState(snapshot.envelope, key));
      validateState(snapshotState, snapshot.envelope.sequence);
    } catch {
      throw new Error("备份中有快照无法验证，导入已取消。");
    }
    snapshotRows.push({ id: `snapshot-${snapshot.sequence}`, sequence: snapshot.sequence, createdAt: snapshot.createdAt, envelope: snapshot.envelope });
  }
  if (!snapshotRows.some((row) => row.sequence === state.sequence)) {
    snapshotRows.push({ id: `snapshot-${state.sequence}`, sequence: state.sequence, createdAt: bundle.state.updatedAt, envelope: bundle.state });
  }
  snapshotRows.sort((a, b) => b.sequence - a.sequence);
  snapshotRows.splice(SNAPSHOT_LIMIT);

  const db = await openDatabase();
  const tx = createTransaction(db, ["meta", "state", "snapshots"], "readwrite");
  const metaStore = tx.objectStore("meta");
  const checks = [metaStore.get(VAULT_KEY), tx.objectStore("state").get(STATE_KEY), tx.objectStore("snapshots").getAll()];
  let existingVault = false;
  let checksPending = checks.length;
  const checkExisting = (request, occupied) => {
    request.onsuccess = () => {
      existingVault ||= occupied(request.result);
      checksPending -= 1;
      if (checksPending > 0) return;
      if (existingVault) {
        tx.abort();
        return;
      }
      metaStore.put(meta);
      tx.objectStore("state").put({ id: STATE_KEY, envelope: bundle.state });
      const store = tx.objectStore("snapshots");
      for (const row of snapshotRows) store.put(row);
    };
  };
  checkExisting(checks[0], Boolean);
  checkExisting(checks[1], Boolean);
  checkExisting(checks[2], (rows) => rows.length > 0);
  await transactionDone(tx).catch((error) => {
    if (existingVault) throw new Error("本机已经存在账本，导入已取消；现有账本没有被修改。");
    throw error;
  });
  return { key, state };
}
