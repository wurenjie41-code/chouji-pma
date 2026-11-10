const storageNamespace = encodeURIComponent(new URL("./", globalThis.location.href).pathname);
const DB_NAME = `chouji-local-v1-${storageNamespace}`;
const DB_VERSION = 1;
const STATE_KEY = "main";
const VAULT_KEY = "vault";
const SNAPSHOT_LIMIT = 5;
const PBKDF2_ITERATIONS = 600_000;

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

async function deriveKey(password, salt) {
  const webCrypto = globalThis.crypto;
  const material = await webCrypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return webCrypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
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
  const state = { sequence: 1, createdAt: new Date().toISOString(), records: [] };
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
    const state = await decryptState(savedState.envelope, key);
    return { key, state };
  } catch {
    throw new Error("密码错误，或本机加密数据已损坏。数据没有被修改。");
  }
}

export async function commitState(nextState, key) {
  const db = await openDatabase();
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
    return await decryptState(previous.envelope, key);
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
