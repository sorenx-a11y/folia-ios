// 直连模式的设备指纹与 cookie 容器。
// 原生 HTTP（CapacitorHttp）不经过 WKWebView 的 cookie jar，所有 cookie 需要自己持久化并在
// 每个请求的 Cookie 头里带上。登录态 MUSIC_U 仍存放在 providerStorage 的既有键中，
// 这里只额外保存设备级指纹与 NMTID。
import {
  readProviderSessionValue,
  writeProviderSessionValue,
} from '../providerStorage';
import { randomNmtid, randomNuid } from './crypto';

const DEVICE_STORAGE_KEY = 'netease_direct_device_v1';

// 与 NeteaseCloudMusicApi util/request.js 的 osMap.pc 一致（eapi 默认设备画像）。
const PC_PROFILE = {
  os: 'pc',
  appver: '3.1.17.204416',
  osver: 'Microsoft-Windows-10-Professional-build-19045-64bit',
  channel: 'netease',
} as const;

export interface DeviceFingerprint {
  deviceId: string;
  nuid: string;
  nnid: string;
  wnmcid: string;
  nmtid: string;
}

const randomLower = (length: number): string => {
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
};

const generateDeviceId = (): string => {
  const hexChars = '0123456789ABCDEF';
  const chars: string[] = [];
  for (let i = 0; i < 52; i += 1) {
    chars.push(hexChars.charAt(Math.floor(Math.random() * hexChars.length)));
  }
  return chars.join('');
};

const generateWnmcid = (): string =>
  `${randomLower(6)}.${Date.now().toString()}.01.0`;

const loadFingerprint = (): DeviceFingerprint => {
  if (typeof localStorage === 'undefined') {
    return {
      deviceId: generateDeviceId(),
      nuid: randomNuid(),
      nnid: '',
      wnmcid: generateWnmcid(),
      nmtid: randomNmtid(),
    };
  }
  const raw = localStorage.getItem(DEVICE_STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<DeviceFingerprint>;
      if (parsed.deviceId && parsed.nuid && parsed.wnmcid) {
        return {
          deviceId: parsed.deviceId,
          nuid: parsed.nuid,
          nnid: parsed.nnid || `${parsed.nuid},${Date.now().toString()}`,
          wnmcid: parsed.wnmcid,
          nmtid: parsed.nmtid || randomNmtid(),
        };
      }
    } catch {
      // 损坏的指纹记录直接重新生成。
    }
  }
  const nuid = randomNuid();
  const fingerprint: DeviceFingerprint = {
    deviceId: generateDeviceId(),
    nuid,
    nnid: `${nuid},${Date.now().toString()}`,
    wnmcid: generateWnmcid(),
    nmtid: randomNmtid(),
  };
  localStorage.setItem(DEVICE_STORAGE_KEY, JSON.stringify(fingerprint));
  return fingerprint;
};

// 解析 cookie 字符串为 map，刻意不做 decode（MUSIC_U 中的 %2B 等序列是 token 的原始形态，
// 与 NeteaseCloudMusicApi 的 cookieToJson 行为保持一致）。
export const parseCookieMap = (cookie: string | null | undefined): Record<string, string> => {
  const map: Record<string, string> = {};
  if (!cookie) return map;
  cookie.split(';').forEach((part) => {
    const index = part.indexOf('=');
    if (index <= 0) return;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) map[key] = value;
  });
  return map;
};

const cookieMapToString = (map: Record<string, string>): string =>
  Object.entries(map)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');

const TRACKED_COOKIE_NAMES = [
  'MUSIC_U',
  'MUSIC_A',
  '__csrf',
  'NMTID',
  'WNMCID',
  'WEVNSM',
  '_ntes_nuid',
  '_ntes_nnid',
  '__remember_me',
  'ntes_kaola_ad',
  'os',
  'osver',
  'appver',
  'channel',
  'deviceId',
  'JSESSIONID-WYYY',
  'vipType',
  'userId',
  'isRefresh',
];

// 从可能被逗号拼接的 Set-Cookie 头里提取关心的 cookie 值。
// CapacitorHttp 在 iOS 上可能把多个 Set-Cookie 合并成一个逗号分隔字符串，且 Expires 属性自带逗号，
// 因此只按白名单名字精确匹配，且只取到第一个分号为止。
export const extractSetCookies = (rawHeaders: Record<string, unknown>): Record<string, string> => {
  const picked: Record<string, string> = {};
  const entries = Object.entries(rawHeaders || {});
  for (const [headerName, headerValue] of entries) {
    if (headerName.toLowerCase() !== 'set-cookie') continue;
    const segments = Array.isArray(headerValue)
      ? headerValue.map(String)
      : [String(headerValue)];
    const raw = segments.join(',');
    TRACKED_COOKIE_NAMES.forEach((name) => {
      const matcher = new RegExp(`(?:^|[;,]\\s*)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^;]+)`);
      const match = raw.match(matcher);
      if (match) picked[name] = match[1].trim();
    });
  }
  return picked;
};

export interface PreparedCookie {
  // eapi data.header / weapi 请求都要带上的完整 cookie map。
  map: Record<string, string>;
  csrfToken: string;
  musicU: string;
  musicA: string;
  nmtid: string;
}

// 合并登录 cookie、设备指纹与默认字段，产出请求所需 cookie 容器。
export const prepareRequestCookie = (): PreparedCookie => {
  const fingerprint = loadFingerprint();
  const session = parseCookieMap(
    readProviderSessionValue('netease', 'cookie', ['netease_cookie']),
  );

  const map: Record<string, string> = {
    __remember_me: 'true',
    ntes_kaola_ad: '1',
    _ntes_nuid: fingerprint.nuid,
    _ntes_nnid: fingerprint.nnid,
    WNMCID: fingerprint.wnmcid,
    WEVNSM: '1.0.0',
    osver: PC_PROFILE.osver,
    deviceId: fingerprint.deviceId,
    os: PC_PROFILE.os,
    channel: PC_PROFILE.channel,
    appver: PC_PROFILE.appver,
    NMTID: fingerprint.nmtid,
    ...session,
  };
  // xeapi 的游客注册无法移植，没有 MUSIC_U 时就不携带 MUSIC_A，以未登录游客身份请求。
  delete map.MUSIC_A;

  return {
    map,
    csrfToken: map.__csrf || '',
    musicU: map.MUSIC_U || '',
    musicA: '',
    nmtid: map.NMTID || '',
  };
};

const generateRequestId = (): string =>
  `${Date.now()}_${Math.floor(Math.random() * 1000)
    .toString()
    .padStart(4, '0')}`;

// eapi 放进加密 data.header 的设备头（结构对应 request.js 的 header 对象）。
export const buildEapiHeader = (cookie: PreparedCookie): Record<string, string> => {
  const header: Record<string, string> = {
    osver: cookie.map.osver,
    deviceId: cookie.map.deviceId,
    os: cookie.map.os,
    appver: cookie.map.appver,
    versioncode: '140',
    mobilename: '',
    buildver: String(Date.now()).substring(0, 10),
    resolution: '1920x1080',
    __csrf: cookie.csrfToken,
    channel: cookie.map.channel,
    requestId: generateRequestId(),
  };
  if (cookie.musicU) header.MUSIC_U = cookie.musicU;
  if (cookie.nmtid) header.NMTID = cookie.nmtid;
  return header;
};

// 与 util/index.js cookieObjToString 一致：键值全部 encodeURIComponent。
export const encodeCookieHeader = (map: Record<string, string>): string =>
  Object.entries(map)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('; ');

// 把响应里的 Set-Cookie 合并回存储。MUSIC_U 出现代表扫码登录完成，整个 cookie 串写回
// providerStorage 的既有登录键；设备级字段同步进指纹记录。
// updated 表示本次响应是否真的带了 Set-Cookie；cookie 始终返回当前完整登录串（可能为空）。
export const persistResponseCookies = (
  rawHeaders: Record<string, unknown>,
): { cookie: string; updated: boolean } => {
  const picked = extractSetCookies(rawHeaders);
  const sessionMap = parseCookieMap(
    readProviderSessionValue('netease', 'cookie', ['netease_cookie']),
  );
  const merged: Record<string, string> = { ...sessionMap, ...picked };

  if (picked.MUSIC_U) {
    writeProviderSessionValue('netease', 'cookie', cookieMapToString(merged));
  }

  if (typeof localStorage !== 'undefined' && picked.NMTID) {
    const raw = localStorage.getItem(DEVICE_STORAGE_KEY);
    if (raw) {
      try {
        const fingerprint = JSON.parse(raw) as DeviceFingerprint;
        fingerprint.nmtid = picked.NMTID;
        localStorage.setItem(DEVICE_STORAGE_KEY, JSON.stringify(fingerprint));
      } catch {
        // 指纹损坏时忽略，下次请求会重新生成。
      }
    }
  }

  return {
    cookie: cookieMapToString(merged),
    updated: Object.keys(picked).length > 0,
  };
};
