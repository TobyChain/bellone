import fs from "node:fs";
import path from "node:path";
import { config, setLlmOverride, isMaskedKey } from "./config.js";

export const THEME_KEYS = ["water", "stand", "eyes", "stretch"] as const;
export type ThemeKey = (typeof THEME_KEYS)[number];

export function parseTheme(v: unknown): ThemeKey | null {
  return typeof v === "string" && (THEME_KEYS as readonly string[]).includes(v)
    ? (v as ThemeKey)
    : null;
}

export interface ThemeSetting {
  enabled: boolean;
  intervalMin: number;
}

export interface Settings {
  workDays: number[];
  workStart: string;
  workEnd: string;
  lunchStart: string;
  lunchEnd: string;
  themes: Record<ThemeKey, ThemeSetting>;
  soundEnabled: boolean;
  llm: { baseUrl: string; apiKey: string; model: string };
  noteoneMcp: { enabled: boolean };
}

export interface Checkin {
  ts: number;
  theme: ThemeKey;
  source: string;
}

export interface FiredReminder {
  ts: number;
  theme: ThemeKey;
}

export interface Settings {
  workDays: number[];
  workStart: string;
  workEnd: string;
  lunchStart: string;
  lunchEnd: string;
  reminderIntervalMin: number;
  themes: Record<ThemeKey, ThemeSetting>;
  soundEnabled: boolean;
  petHidden: boolean;
  llm: { baseUrl: string; apiKey: string; model: string };
  noteoneMcp: { enabled: boolean };
}

export interface PendingCopy {
  body: string;
  tip: string;
  ts: number;
}

export interface RuntimeState {
  lastFired: Partial<Record<ThemeKey, number>>;
  snoozedUntil: Partial<Record<ThemeKey, number>>;
  mutedTodayDate: string | null;
  mutedThemes: ThemeKey[];
  dndUntil: number | null;
  recentTips: Partial<Record<ThemeKey, number[]>>;
  pendingCopy: Partial<Record<ThemeKey, PendingCopy>>;
  lastReminderAt: number;
  nextGapMs: number;
  lastTheme: ThemeKey | null;
  globalSnoozeUntil: number | null;
}

export interface MemoryEntry {
  ts: number;
  text: string;
}

export const DEFAULT_SETTINGS: Settings = {
  workDays: [1, 2, 3, 4, 5],
  workStart: "10:00",
  workEnd: "19:00",
  lunchStart: "12:00",
  lunchEnd: "13:30",
  reminderIntervalMin: 45,
  themes: {
    water: { enabled: true, intervalMin: 45 },
    stand: { enabled: true, intervalMin: 60 },
    eyes: { enabled: true, intervalMin: 90 },
    stretch: { enabled: false, intervalMin: 120 },
  },
  soundEnabled: true,
  petHidden: true,
  llm: { baseUrl: "", apiKey: "", model: "" },
  noteoneMcp: { enabled: true },
};

const DEFAULT_STATE: RuntimeState = {
  lastFired: {},
  snoozedUntil: {},
  mutedTodayDate: null,
  mutedThemes: [],
  dndUntil: null,
  recentTips: {},
  pendingCopy: {},
  lastReminderAt: 0,
  nextGapMs: 0,
  lastTheme: null,
  globalSnoozeUntil: null,
};

const RETENTION_MS = 90 * 24 * 3600_000;

function isValidHm(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = v.match(/^(\d{1,2}):(\d{2})$/);
  return m !== null && Number(m[1]) <= 23 && Number(m[2]) <= 59;
}

export interface SettingsPatch {
  workStart?: unknown;
  workEnd?: unknown;
  lunchStart?: unknown;
  lunchEnd?: unknown;
  workDays?: unknown;
  reminderIntervalMin?: unknown;
  soundEnabled?: unknown;
  petHidden?: unknown;
  themes?: unknown;
  llm?: unknown;
  noteoneMcp?: unknown;
}

/** 统一的设置补丁校验与应用；strict 模式下非法字段抛错；llm 字段仅 allowLlm（HTTP 路径）可写 */
export function applySettingsPatch(
  patch: SettingsPatch,
  opts: { strict?: boolean; allowLlm?: boolean } = {}
): Settings {
  const s = store.settings;
  const fail = (msg: string) => {
    if (opts.strict) throw new Error(msg);
  };
  for (const key of ["workStart", "workEnd", "lunchStart", "lunchEnd"] as const) {
    const v = patch[key];
    if (v === undefined) continue;
    if (isValidHm(v)) s[key] = v;
    else fail(`${key} 需为 HH:MM（00:00-23:59）`);
  }
  if (patch.reminderIntervalMin !== undefined) {
    const n = Number(patch.reminderIntervalMin);
    if (Number.isFinite(n) && n >= 5 && n <= 480) s.reminderIntervalMin = Math.round(n);
    else fail("reminderIntervalMin 需在 5-480 分钟之间");
  }
  if (patch.workDays !== undefined) {
    if (Array.isArray(patch.workDays)) {
      s.workDays = patch.workDays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    } else fail("workDays 需为 0-6 数组");
  }
  if (typeof patch.soundEnabled === "boolean") s.soundEnabled = patch.soundEnabled;
  if (typeof patch.petHidden === "boolean") s.petHidden = patch.petHidden;
  if (patch.themes !== undefined) {
    if (patch.themes && typeof patch.themes === "object") {
      for (const [k, v] of Object.entries(patch.themes as Record<string, Partial<ThemeSetting>>)) {
        const theme = parseTheme(k);
        if (!theme) {
          fail(`无效的主题: ${k}`);
          continue;
        }
        if (!v) continue;
        if (typeof v.enabled === "boolean") s.themes[theme].enabled = v.enabled;
        if (v.intervalMin !== undefined) {
          const n = Number(v.intervalMin);
          if (Number.isFinite(n) && n >= 5 && n <= 480) s.themes[theme].intervalMin = Math.round(n);
          else fail("intervalMin 需在 5-480 分钟之间");
        }
      }
    } else fail("themes 需为对象");
  }
  if (opts.allowLlm && patch.llm && typeof patch.llm === "object") {
    const llm = patch.llm as Partial<Settings["llm"]>;
    if (typeof llm.baseUrl === "string") s.llm.baseUrl = llm.baseUrl.trim().replace(/\/$/, "");
    if (typeof llm.model === "string") s.llm.model = llm.model.trim();
    if (typeof llm.apiKey === "string" && llm.apiKey && !isMaskedKey(llm.apiKey)) {
      s.llm.apiKey = llm.apiKey.trim();
    }
    setLlmOverride(s.llm);
  }
  if (patch.noteoneMcp && typeof patch.noteoneMcp === "object") {
    const m = patch.noteoneMcp as Partial<Settings["noteoneMcp"]>;
    if (typeof m.enabled === "boolean") s.noteoneMcp.enabled = m.enabled;
  }
  store.saveSettings();
  return s;
}

function deepMergeDefaults<T extends Record<string, unknown>>(fallback: T, loaded: unknown): T {
  if (!loaded || typeof loaded !== "object" || Array.isArray(loaded)) return structuredClone(fallback);
  const out = structuredClone(fallback) as Record<string, unknown>;
  for (const [k, v] of Object.entries(loaded as Record<string, unknown>)) {
    const base = out[k];
    if (base && typeof base === "object" && !Array.isArray(base) && v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = deepMergeDefaults(base as Record<string, unknown>, v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

function readJson<T extends Record<string, unknown>>(file: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(file, "utf-8");
    return deepMergeDefaults(fallback, JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`[store] ${path.basename(file)} 读取失败，使用默认值:`, err);
      try {
        fs.copyFileSync(file, `${file}.corrupt`);
      } catch {}
    }
    return structuredClone(fallback);
  }
}

function readJsonArray<T>(file: string): T[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function atomicWrite(file: string, data: string): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

class Store {
  settings: Settings;
  state: RuntimeState;
  checkins: Checkin[];
  fired: FiredReminder[];
  memory: MemoryEntry[];

  private files: Record<string, string>;

  constructor() {
    fs.mkdirSync(config.dataDir, { recursive: true });
    this.files = {
      settings: path.join(config.dataDir, "settings.json"),
      state: path.join(config.dataDir, "state.json"),
      checkins: path.join(config.dataDir, "checkins.json"),
      fired: path.join(config.dataDir, "fired.json"),
      memory: path.join(config.dataDir, "memory.json"),
    };
    this.settings = readJson(this.files.settings, DEFAULT_SETTINGS as unknown as Record<string, unknown>) as unknown as Settings;
    this.state = readJson(this.files.state, DEFAULT_STATE as unknown as Record<string, unknown>) as unknown as RuntimeState;
    this.checkins = readJsonArray<Checkin>(this.files.checkins);
    this.fired = readJsonArray<FiredReminder>(this.files.fired);
    this.memory = readJsonArray<MemoryEntry>(this.files.memory);
    this.pruneOld();
    setLlmOverride(this.settings.llm);
  }

  /** 保留 90 天数据，防止无限增长（周报只需近一周） */
  pruneOld(): void {
    const cutoff = Date.now() - RETENTION_MS;
    if (this.checkins.length && this.checkins[0].ts < cutoff) {
      this.checkins = this.checkins.filter((c) => c.ts >= cutoff);
      this.saveCheckins();
    }
    if (this.fired.length && this.fired[0].ts < cutoff) {
      this.fired = this.fired.filter((f) => f.ts >= cutoff);
      this.saveFired();
    }
  }

  saveMemory(): void {
    atomicWrite(this.files.memory, JSON.stringify(this.memory, null, 2));
  }

  saveSettings(): void {
    atomicWrite(this.files.settings, JSON.stringify(this.settings, null, 2));
  }

  saveState(): void {
    atomicWrite(this.files.state, JSON.stringify(this.state, null, 2));
  }

  saveCheckins(): void {
    atomicWrite(this.files.checkins, JSON.stringify(this.checkins));
  }

  saveFired(): void {
    atomicWrite(this.files.fired, JSON.stringify(this.fired));
  }
}

export const store = new Store();
