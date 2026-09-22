// JSON 文件存储：落盘防抖；Set 类型序列化兼容
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildSeed } from './seed.js';
import { ensureRuntime } from './engine.js';

export class Store {
  constructor(file) {
    this.file = file;
    this.state = this.#load();
    this.version = 1;
    this.timer = null;
  }

  #load() {
    try {
      if (this.file && existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf8'));
        this.#hydrate(raw);
        return raw;
      }
    } catch (e) {
      console.error('[store] 状态文件读取失败，使用种子数据:', e.message);
    }
    return buildSeed();
  }

  #hydrate(state) {
    // 旧版本无 runtime 也能启动
    state.runtime ??= {};
    for (const r of state.runners) {
      const rt = ensureRuntime(state, r.bib);
      if (Array.isArray(rt.insideZones)) rt.insideZones = new Set(rt.insideZones);
      rt.zoneUntil ??= {};
      rt.active ??= {};
    }
  }

  reset() {
    this.state = buildSeed();
    this.version++;
    this.saveNow();
  }

  bump() {
    this.version++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.saveNow(), 400);
  }

  saveNow() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const clone = structuredClone(this.state);
    if (clone.runtime) {
      for (const rt of Object.values(clone.runtime)) {
        if (rt.insideZones instanceof Set) rt.insideZones = [...rt.insideZones];
      }
    }
    writeFileSync(this.file, JSON.stringify(clone, null, 2));
  }
}
