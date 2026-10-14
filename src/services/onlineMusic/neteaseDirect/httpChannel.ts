// 原生 HTTP 通道：iOS 上用 CapacitorHttp 绕过 WKWebView 的 CORS 与同源 cookie 限制；
// 非 Capacitor 环境（浏览器调试）回退到 fetch，直连网易域名大概率会被 CORS 拦截，仅用于调试。
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
}

const viaNative = (): boolean => Capacitor.isNativePlatform();

const nativeRequest = async (request: DirectHttpRequest): Promise<DirectHttpResponse> => {
  const response = await CapacitorHttp.request({
    url: request.url,
    method: 'POST',
    headers: request.headers,
    data: request.body,
    // 自己解析 JSON：错误响应同样是 JSON，交给上层按 code 处理。
    responseType: 'text',
    connectTimeout: 20000,
    readTimeout: 20000,
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
