// 网页版 / iOS 封装版没有桌面端的内嵌音乐后端，API 地址原本只能在构建期通过
// VITE_NETEASE_API_BASE / VITE_QQ_API_BASE / VITE_KUGOU_API_BASE 注入，云打包后用户
// 无法填写自己部署的服务地址。这里提供 localStorage 运行时覆盖：账户页可直接保存地址，
// 优先级高于构建期环境变量；桌面 Electron 运行时仍走内嵌后端，不受影响。

const STORAGE_KEY = 'online_provider_runtime_api_base_v1';

// 只有需要自建 Node 后端的三个平台走这套配置；Navidrome 等另有独立的服务器配置。
// OnlineProviderId 被声明为 'netease' | (string & {})，无法用 Extract 取出 qq/kugou，这里独立声明。
export type RuntimeApiBaseProviderId = 'netease' | 'qq' | 'kugou';

export const RUNTIME_API_BASE_PROVIDERS: readonly RuntimeApiBaseProviderId[] = ['netease', 'qq', 'kugou'];

const readAll = (): Partial<Record<RuntimeApiBaseProviderId, string>> => {
    if (typeof localStorage === 'undefined') return {};
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? (JSON.parse(raw) as Partial<Record<RuntimeApiBaseProviderId, string>>) : {};
    } catch {
        return {};
    }
};

const normalize = (value: string): string => value.trim().replace(/\/+$/, '');

/** 读取某平台的运行时 API 地址覆盖；未设置或在 Electron 内时返回空串。 */
export const readRuntimeApiBase = (providerId: RuntimeApiBaseProviderId): string => {
    if (typeof window !== 'undefined' && (window as any)?.electron?.getNeteasePort) return '';
    const value = readAll()[providerId];
    return typeof value === 'string' ? normalize(value) : '';
};

/** 保存（空串等价于删除）运行时 API 地址覆盖。 */
export const writeRuntimeApiBase = (providerId: RuntimeApiBaseProviderId, value: string): void => {
    if (typeof localStorage === 'undefined') return;
    const all = readAll();
    const normalized = normalize(value);
    if (normalized) {
        all[providerId] = normalized;
    } else {
        delete all[providerId];
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
};
