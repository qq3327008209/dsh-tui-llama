// 把宿主 dsh 自带的运行时包链进本项目的 node_modules，供 tsc 做类型解析。
// 运行时不依赖这些链：插件被宿主加载时，cordis 的 internal.import(specifier,
// bareModuleBaseUrl) 会按宿主基址解析裸包名（见 dsh-app-boot mountRootInclude）。
const fs = require('node:fs');
const path = require('node:path');

const HOST = 'D:/node/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';
const LOCAL = 'C:/Users/John Smish/Desktop/dsh-tui-llama/node_modules/@deepseek-ai';
const PACKAGES = ['dsh-llm', 'dsh-settings', 'schemastery', 'cordis'];

fs.mkdirSync(LOCAL, { recursive: true });
for (const name of PACKAGES) {
  const src = path.join(HOST, name);
  const dst = path.join(LOCAL, name);
  if (!fs.existsSync(src)) { console.log('MISS source', name); continue; }
  try { fs.rmSync(dst, { recursive: true, force: true }); } catch { /* 不存在 */ }
  try {
    fs.symlinkSync(src, dst, 'junction');
    console.log('linked', name, '->', src);
  } catch (err) {
    console.log('FAIL', name, err.message);
  }
}
