import { Capacitor } from '@capacitor/core';

// src/services/ai/nativeAiSettings.ts
// 移动端（Capacitor 原生壳）的 AI 配置。
//
// 三端拿密钥的方式各不相同：桌面端由 Electron 主进程加密保管，网页/自部署版由服务端环境变量提供，
// 原生壳两者都没有——没有主进程，也没有可请求的 /api/generate-theme 后端。所以这里在本地持久化一份
// 配置，由 App 直接调用 AI 服务商（见 nativeAiClient.ts），设置页的「AI 主题设置」就是编辑它。

export type NativeAiProvider = 'gemini' | 'openai';

export interface NativeAiSettings {
    provider: NativeAiProvider;
    geminiApiKey: string;
    openaiApiKey: string;
    openaiApiUrl: string;
    openaiApiModel: string;
    openaiApiTemperature: string;
}

export const NATIVE_AI_SETTINGS_STORAGE_KEY = 'native_ai_settings_v1';

export const DEFAULT_NATIVE_AI_SETTINGS: NativeAiSettings = {
    provider: 'gemini',
    geminiApiKey: '',
    openaiApiKey: '',
    openaiApiUrl: '',
    openaiApiModel: '',
    openaiApiTemperature: '',
};

/** 原生壳（iOS/Android）才需要本地 AI 配置；Electron 与网页版沿用各自既有的通道。 */
export const isNativeAiRuntime = (): boolean => Capacitor.isNativePlatform();

const readString = (value: unknown): string => (typeof value === 'string' ? value : '');

/** 存储里的值可能是旧版本或被外部改坏的，逐字段收敛，不认识的一律退回默认值。 */
const normalize = (raw: unknown): NativeAiSettings => {
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_NATIVE_AI_SETTINGS };
    const record = raw as Record<string, unknown>;
    return {
        provider: record.provider === 'openai' ? 'openai' : 'gemini',
        geminiApiKey: readString(record.geminiApiKey),
        openaiApiKey: readString(record.openaiApiKey),
        openaiApiUrl: readString(record.openaiApiUrl),
        openaiApiModel: readString(record.openaiApiModel),
        openaiApiTemperature: readString(record.openaiApiTemperature),
    };
};

export const loadNativeAiSettings = (): NativeAiSettings => {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_NATIVE_AI_SETTINGS };
    const stored = localStorage.getItem(NATIVE_AI_SETTINGS_STORAGE_KEY);
    if (!stored) return { ...DEFAULT_NATIVE_AI_SETTINGS };
    try {
        return normalize(JSON.parse(stored));
    } catch {
        return { ...DEFAULT_NATIVE_AI_SETTINGS };
    }
};

export const saveNativeAiSettings = (settings: NativeAiSettings): void => {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(NATIVE_AI_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
};

/** 当前选中的服务商是否已经填了密钥：设置页据此判断「AI 推断」能不能选。 */
export const hasNativeAiApiKey = (settings: NativeAiSettings): boolean => (
    settings.provider === 'openai'
        ? settings.openaiApiKey.trim().length > 0
        : settings.geminiApiKey.trim().length > 0
);
