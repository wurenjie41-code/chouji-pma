// Recognition is a draft. Nothing here writes to the ledger or selects a bet.
export function parseIntake(text) {
  const chineseNumber = token => {
    const digits = {零:0,〇:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
    const [whole,fraction] = token.split('点');
    let total = 0, part = 0, digit = 0;
    if (!/[十百千万]/.test(whole)) total = Number([...whole].map(c => digits[c]).join(''));
    else {
      for (const c of whole) {
        if (c in digits) digit = digits[c];
        else if (c === '万') { total += (part + digit) * 10000; part = 0; digit = 0; }
        else { part += (digit || 1) * ({十:10,百:100,千:1000}[c]); digit = 0; }
      }
      total += part + digit;
    }
    return String(total) + (fraction ? '.' + [...fraction].map(c => digits[c]).join('') : '');
  };
  const clean = text.normalize('NFKC').replace(/[，；;]+/g, '\n').replace(/((?:投注金额|下注金额|金额|本金|赔率|返还|手续费)\s*[:：]?\s*)([零〇一二两三四五六七八九十百千万]+(?:点[零〇一二三四五六七八九]+)?)/g, (_,label,token) => label + chineseNumber(token));
  const fields = {};
  const numeric = (labels, key) => {
    const matches = [...clean.matchAll(new RegExp('(?:' + labels + ')\\s*[:：]?\\s*[¥￥]?\\s*(\\d+(?:[.,]\\d+)?)', 'gi'))];
    const values = [...new Set(matches.map(m => m[1].replace(',', '.')))];
    if (values.length === 1) fields[key] = values[0];
  };
  numeric('投注金额|下注金额|本金|投注额|金额|stake', 'stake');
  numeric('十进制赔率|赔率|odds', 'odds');
  numeric('实际返还|返还金额|返还|payout', 'return');
  numeric('手续费|fee', 'fee');
  for (const [label, key] of [['比赛|事件','event'],['运动|类别','sport'],['联赛','league'],['玩法|选择','market'],['平台','platform']]) {
    const match = clean.match(new RegExp('(?:^|\\n)\\s*(?:' + label + ')\\s*[:：]\\s*([^\\n]+)', 'i'));
    if (match) fields[key] = match[1].trim();
  }
  // Do not infer settlement status, result, dates or decimal odds from net profit.
  if (fields.stake && !(Number(fields.stake) > 0 && /^\d{1,9}(\.\d{1,2})?$/.test(fields.stake))) delete fields.stake;
  if (fields.odds && !(Number(fields.odds) >= 1 && Number(fields.odds) <= 1000)) delete fields.odds;
  return fields;
}

export function setupIntake({ getImage, isUnlocked, apply }) {
  const el = id => document.getElementById(id);
  let worker, recognition, generation = 0, candidates = {}, modelDownload;
  const base = new URL('../vendor/', import.meta.url).href;
  const assets = ['tesseract.min.js','worker.min.js','core/tesseract-core-lstm.wasm.js','core/tesseract-core-simd-lstm.wasm.js','lang/chi_sim.traineddata.gz','lang/eng.traineddata.gz'];
  async function downloadModels() {
    if (modelDownload) throw new Error('模型下载尚在结束，请稍后重试');
    const abort = new AbortController();
    modelDownload = abort;
    el('intake-download').disabled = true;
    try {
      const cache = await caches.open('chouji-ocr-models-v1');
      for (let index = 0; index < assets.length; index++) {
        const url = base + assets[index];
        el('intake-model-status').textContent = `下载 / 检查 ${index+1}/${assets.length}：${assets[index]}，请保持前台…`;
        const existing = await cache.match(url);
        if (existing) continue;
        const response = await fetch(url, {signal:abort.signal});
        if (!response.ok) throw new Error(`资源下载失败 HTTP ${response.status}：${assets[index]}`);
        await cache.put(url,response);
      }
      el('intake-model-status').textContent = '模型文件已就绪，保存在当前浏览器本机缓存。可选择图片并开始识别；这不是照片识别准确率的保证。';
    } catch (error) {
      el('intake-model-status').textContent = '模型未准备好：' + (error.name === 'AbortError' ? '已取消下载' : error.message) + '。可联网后重试；不要清除网站数据。';
      throw error;
    } finally { modelDownload = null; el('intake-download').disabled = false; }
  }
  const status = message => { el('intake-status').textContent = message; };
  function cancel() {
    modelDownload?.abort();
    generation++;
    if (worker) { void worker.terminate(); worker = null; }
    if (recognition) { recognition.abort(); recognition = null; }
    el('intake-ocr').disabled = false;
    el('intake-voice').disabled = false;
  }
  function clear() {
    cancel();
    el('intake-text').value = '';
    el('intake-fields').replaceChildren();
    candidates = {};
    el('intake-confirm').checked = false;
    status('识别结果只作草稿；金额、赔率、玩法、赛果需逐项核对。');
  }
  function review() {
    candidates = parseIntake(el('intake-text').value);
    const names = { event:'事件',sport:'类别',league:'联赛',market:'玩法',platform:'平台',stake:'投注金额',odds:'十进制赔率',return:'实际返还（含本金）',fee:'手续费' };
    el('intake-fields').replaceChildren(...Object.entries(candidates).map(([key,value]) => {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox'; box.value = key; // Deliberately unchecked.
      label.append(box, document.createTextNode(`${names[key]}：${value}`));
      return label;
    }));
    el('intake-confirm').checked = false;
    status(Object.keys(candidates).length ? '勾选核对过的字段，再确认带入；日期和赛果不会自动推断。' : '未找到明确标注的字段。可修改文字，例如“投注金额：50”“赔率：1.85”，再解析。');
  }
  el('intake-parse').addEventListener('click', review);
  el('intake-apply').addEventListener('click', () => {
    if (!isUnlocked()) return clear();
    if (!el('intake-confirm').checked) return status('请先核对金额、赔率、玩法和赛果，并勾选确认。');
    const selected = {};
    el('intake-fields').querySelectorAll('input:checked').forEach(box => { selected[box.value] = candidates[box.value]; });
    if (!Object.keys(selected).length) return status('请至少勾选一个已核对字段。');
    apply(selected);
    status('已带入选中字段，尚未保存。请核对表单后加密保存。');
  });
  el('intake-cancel').addEventListener('click', () => { cancel(); status('已停止识别。'); });
  el('intake-download').addEventListener('click', () => { void downloadModels().catch(() => {}); });
  el('intake-ocr').addEventListener('click', async () => {
    const image = getImage();
    if (!image) return status('请先选择截图或照片。');
    cancel(); const ticket = generation;
    el('intake-ocr').disabled = true;
    status('正在准备本机中英文识别；首次需要下载引擎和模型。');
    try {
      await downloadModels();
      if (ticket !== generation || !isUnlocked()) return;
      if (!window.Tesseract) await new Promise((resolve,reject) => {
        const script = document.createElement('script');
        script.src = new URL('../vendor/tesseract.min.js', import.meta.url).href;
        script.onload = resolve; script.onerror = () => { script.remove(); reject(new Error('识别引擎未加载，请联网后重试。')); };
        document.head.append(script);
      });
      if (ticket !== generation || !isUnlocked()) return;
      const created = await window.Tesseract.createWorker(['chi_sim','eng'], 1, {
        workerPath: base + 'worker.min.js', corePath: base + 'core/', langPath: base + 'lang', workerBlobURL:false,
        logger: m => { if (ticket === generation) {
          const stage = {'loading tesseract core':'正在加载识别引擎','initializing tesseract':'正在初始化引擎','loading language traineddata':'正在载入中英文模型','initializing api':'正在准备识别','recognizing text':'正在识别图片文字'}[m.status] || '正在准备本机识别';
          status(`${stage} ${Math.round((m.progress || 0) * 100)}%`);
        } }
      });
      if (ticket !== generation || !isUnlocked()) { await created.terminate(); return; }
      worker = created;
      const result = await created.recognize(image);
      if (ticket !== generation || !isUnlocked()) return;
      el('intake-text').value = result.data.text.slice(0,12000);
      review();
    } catch (error) { if (ticket === generation) status(`识别未完成：${error.message}。可手工录入。`); }
    finally { if (ticket === generation) cancel(); }
  });
  el('intake-voice').addEventListener('click', async () => {
    cancel(); const ticket = generation;
    const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Speech || !('processLocally' in Speech.prototype) || typeof Speech.available !== 'function') {
      return status('此浏览器无法明确提供本机语音识别。请在下方文字框使用系统键盘听写，再点“解析文字”。系统听写的处理方式由设备设置决定。');
    }
    try {
      const availability = await Speech.available({langs:['zh-CN'],processLocally:true});
      if (ticket !== generation || !isUnlocked()) return;
      if (availability !== 'available') return status('设备端中文语音包不可用，请使用键盘听写或手工输入；未启动远程识别。');
      recognition = new Speech(); recognition.lang = 'zh-CN'; recognition.processLocally = true;
      recognition.onresult = event => {
        if (ticket !== generation || !isUnlocked()) return;
        el('intake-text').value = event.results[0][0].transcript;
        review();
      };
      recognition.onerror = () => status('语音识别未完成，请检查麦克风权限或使用键盘听写。');
      recognition.onend = () => { el('intake-voice').disabled = false; };
      recognition.start(); el('intake-voice').disabled = true;
      status('正在设备端听写，可说“投注金额50，赔率1.85”。结束后仍需核对。');
    } catch { status('此设备未能启动本机语音识别，请使用系统键盘听写。'); }
  });
  return { clear, cancel };
}

