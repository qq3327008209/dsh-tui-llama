/**
 * 环境自动发现：找 llama-server 可执行文件与 GGUF 模型目录。
 *
 * 发现结果只进 settings 的 base 层作默认值——用户保存的值永远优先。
 * 目的：装完不用手填路径就能用。
 */
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { DISCOVERY_TIMEOUT_MS, expandPath } from './config.js';

export interface DiscoveryReport {
  executables: { path: string; source: string }[];
  modelsDirs: { dir: string; ggufCount: number }[];
  models: string[];
  updatedAt: string;
}

const EMPTY: DiscoveryReport = { executables: [], modelsDirs: [], models: [], updatedAt: '' };

/** 可执行文件候选。release zip 解压式布局放在前面（本机实际就是这样）。 */
const EXE_ROOTS = (): string[] => {
  const home = homedir();
  const roots = [
    'D:/llama',
    `${home}/llama`,
    'D:/llama.cpp',
    `${home}/llama.cpp/build`,
    `${home}/llama.cpp/build/bin`,
    `${home}/llama.cpp/build/bin/release`,
    `${home}/Desktop/llama`,
    `${home}/Desktop/llama.cpp`,
  ];
  for (const dir of (process.env.PATH ?? '').split(':').filter(Boolean)) roots.push(dir);
  return roots;
};

const MODEL_ROOTS = (): string[] => {
  const home = homedir();
  return [
    'D:/llama/models',
    `${home}/llama/models`,
    `${home}/llama.cpp/models`,
    'D:/llama.cpp/models',
    `${home}/models`,
    `${home}/Desktop`,
  ];
};

const EXE_NAMES = ['llama-server.exe', 'llama-server', 'llama.exe', 'llama'];

function candidateFiles(): { path: string; source: string }[] {
  const found: { path: string; source: string }[] = [];
  const seen = new Set<string>();
  for (const root of EXE_ROOTS()) {
    for (const name of EXE_NAMES) {
      const p = isAbsolute(root) ? join(root, name) : root;
      if (seen.has(p)) continue;
      seen.add(p);
      try {
        if (statSync(p).isFile()) found.push({ path: p, source: root });
      } catch { /* 不存在 */ }
    }
  }
  return found;
}

function countGguf(dir: string): number {
  try {
    return readdirSync(dir, 'utf8').filter((n) => n.toLowerCase().endsWith('.gguf')).length;
  } catch {
    return 0;
  }
}

function candidateDirs(): { dir: string; ggufCount: number }[] {
  const found: { dir: string; ggufCount: number }[] = [];
  const seen = new Set<string>();
  for (const dir of MODEL_ROOTS()) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    try {
      if (!statSync(dir).isDirectory()) continue;
      const n = countGguf(dir);
      if (n > 0) found.push({ dir, ggufCount: n });
    } catch { /* 不存在 */ }
  }
  return found;
}

function modelsOf(dir: string): string[] {
  try {
    return readdirSync(dir, 'utf8')
      .filter((n) => n.toLowerCase().endsWith('.gguf'))
      .sort()
      .map((n) => join(dir, n));
  } catch {
    return [];
  }
}

export function discoverEnvironment(): DiscoveryReport {
  const executables = candidateFiles();
  const modelsDirs = candidateDirs();
  const models = modelsDirs.length > 0 ? modelsOf(modelsDirs[0]!.dir) : [];
  return {
    executables,
    modelsDirs,
    models,
    updatedAt: new Date().toISOString(),
  };
}

/** 发现阶段超时包裹：绝不让它卡住 apply()。 */
export async function discoverEnvironmentSafe(timeoutMs = DISCOVERY_TIMEOUT_MS): Promise<DiscoveryReport> {
  const work = Promise.resolve().then(discoverEnvironment);
  const timeout = new Promise<DiscoveryReport>((resolve) => {
    setTimeout(() => resolve(EMPTY), timeoutMs).unref();
  });
  return (await Promise.race([work, timeout])) ?? EMPTY;
}

/** 挑最佳可执行文件：展开用户填写值，否则取发现的第一个。 */
export function bestExecutable(userValue: string, report: DiscoveryReport): string {
  const own = expandPath(userValue).trim();
  if (own) return own;
  return report.executables[0]?.path ?? '';
}

/** 挑最佳模型目录：用户填写值优先，否则取 GGUF 最多的。 */
export function bestModelsDir(userValue: string, report: DiscoveryReport): string {
  const own = expandPath(userValue).trim();
  if (own) return own;
  const best = [...report.modelsDirs].sort((a, b) => b.ggufCount - a.ggufCount)[0];
  return best?.dir ?? '';
}
