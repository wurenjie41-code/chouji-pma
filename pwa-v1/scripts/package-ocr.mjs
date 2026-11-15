import { mkdir, copyFile, readdir } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const modules = new URL('ocr-engine/node_modules/', root);
const vendor = new URL('vendor/', root);
await mkdir(new URL('core/', vendor), {recursive:true});
await mkdir(new URL('lang/', vendor), {recursive:true});
for (const name of ['tesseract.min.js','worker.min.js']) await copyFile(new URL('tesseract.js/dist/' + name, modules), new URL(name,vendor));
for (const name of await readdir(new URL('tesseract.js-core/',modules))) {
  if (/\.wasm(\.js)?$/.test(name)) await copyFile(new URL('tesseract.js-core/' + name,modules),new URL('core/' + name,vendor));
}
for (const lang of ['chi_sim','eng']) await copyFile(new URL(`@tesseract.js-data/${lang}/4.0.0/${lang}.traineddata.gz`,modules),new URL(`lang/${lang}.traineddata.gz`,vendor));
await copyFile(new URL('tesseract.js/LICENSE.md',modules),new URL('TESSERACT-LICENSE.md',vendor));
await copyFile(new URL('tesseract.js-core/LICENSE',modules),new URL('CORE-LICENSE',vendor));
console.log('Packaged same-origin OCR engine and Chinese/English models.');

