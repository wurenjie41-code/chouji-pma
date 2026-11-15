import assert from 'node:assert/strict';
import {parseIntake} from '../src/intake.js';
assert.deepEqual(parseIntake('投注金额：50\n赔率：1.85\n平台：本机测试\n玩法：全场大小'), {stake:'50',odds:'1.85',platform:'本机测试',market:'全场大小'});
assert.equal(parseIntake('金额 50 金额 100').stake, undefined, 'ambiguous amounts must not be selected');
assert.equal(parseIntake('账户余额 500 盈利 200').stake, undefined, 'do not infer stake from balance or profit');
assert.equal(parseIntake('金额 0').stake, undefined);
assert.equal(parseIntake('赔率 0.85').odds, undefined, 'do not guess odds format');
assert.equal(parseIntake('已赢，返还：180').status, undefined, 'do not auto-select results');
assert.equal(parseIntake('金额 50.123').stake, undefined);
assert.equal(parseIntake('投注金额五十，赔率一点八五').stake, '50');
assert.equal(parseIntake('投注金额五十，赔率一点八五').odds, '1.85');
console.log('Recognition parser checks passed.');
// Regression: selected files must be read directly without fetching a blob URL.
const {default:loadBrowserImage} = await import('../ocr-engine/node_modules/tesseract.js/src/worker/browser/loadImage.js');
const previousReader = globalThis.FileReader;
const previousFetch = globalThis.fetch;
try {
  globalThis.FileReader = class {
    readAsArrayBuffer(blob) { blob.arrayBuffer().then(buffer => { this.result = buffer; this.onload(); }); }
  };
  globalThis.fetch = () => { throw new Error('Image loading must not use fetch'); };
  const data = await loadBrowserImage(new File([new Uint8Array([1,2,3])],'synthetic.png',{type:'image/png'}));
  assert.deepEqual([...data],[1,2,3]);
  console.log('Browser image adapter reads File directly without fetch.');
} finally { globalThis.FileReader = previousReader; globalThis.fetch = previousFetch; }
if (process.argv.includes('--ocr')) {
  const {createWorker} = await import('../ocr-engine/node_modules/tesseract.js/src/index.js');
  const {fileURLToPath} = await import('node:url');
  const worker = await createWorker(['chi_sim','eng'],1,{ langPath:fileURLToPath(new URL('../vendor/lang-mobile/',import.meta.url)),cacheMethod:'none' });
  try {
    const result = await worker.recognize(fileURLToPath(new URL('../ocr-engine/sample.png',import.meta.url)));
    assert.match(result.data.text,/50[.,]00/);
    assert.match(result.data.text,/1[.,]850/);
    console.log('Real local OCR recognized the synthetic amount and odds.');
  } finally { await worker.terminate(); }
}

