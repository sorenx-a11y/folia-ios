// 原生 HTTP 通道：iOS 上用 CapacitorHttp 绕过 WKWebView 的 CORS 与同源限制（网易直连、AI 直连共用）；
// 非 Capacitor 环境（浏览器调试）回退到 fetch，直连第三方域名大概率会被 CORS 拦截，仅用于调试。
import { Capacitor, CapacitorHttp } from '@capacitor/core';

export interface DirectHttpResponse {
  status: number;
  // 响应头以原始大小写混合存在，调用方按小写键名查找。
  headers: Record<string, unknown>;
  bodyText: string;
}

export interface DirectHttpRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  // 覆盖原生读取超时：AI 生成一条完整回复可能要几十秒，默认的 20s 不够。
  connectTimeoutMs?: number;
  readTimeoutMs?: number;
}

export const DEFAULT_NATIVE_CONNECT_TIMEOUT_MS = 20000;
export const DEFAULT_NATIVE_READ_TIMEOUT_MS = 20000;

const viaNative = (): boolean => Capacitor.isNativePlatform();

const nativeRequest = async (request: DirectHttpRequest): Promise<DirectHttpResponse> => {
  const response = await CapacitorHttp.request({
    url: request.url,
    method: 'POST',
    headers: request.headers,
    data: request.body,
    // 自己解析 JSON：错误响应同样是 JSON，交给上层按 code 处理。
    responseType: 'text',
    connectTimeout: request.connectTimeoutMs ?? DEFAULT_NATIVE_CONNECT_TIMEOUT_MS,
    readTimeout: request.readTimeoutMs ?? DEFAULT_NATIVE_READ_TIMEOUT_MS,
  });
  const bodyText =
    typeof response.data === 'string'
      ? response.data
      : response.data == null
        ? ''
        : JSON.stringify(response.data);
  return {
    status: response.status,
    headers: (response.headers || {}) as Record<string, unknown>,
    bodyText,
  };
};

const webFetchRequest = async (request: DirectHttpRequest): Promise<DirectHttpResponse> => {
  const response = await fetch(request.url, {
    method: 'POST',
    headers: request.headers,
    body: request.body,
    credentials: 'omit',
  });
  return {
    status: response.status,
    // fetch 的 Headers 已小写化。
    headers: Object.fromEntries(response.headers.entries()),
    bodyText: await response.text(),
  };
};

export const directHttpRequest = async (
  request: DirectHttpRequest,
): Promise<DirectHttpResponse> => {
  if (viaNative()) {
    return nativeRequest(request);
  }
  return webFetchRequest(request);
};

export const isNativeHttpRuntime = viaNative;
