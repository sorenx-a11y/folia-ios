// 直连编排：前端端点字符串 -> 路由匹配 -> eapi/weapi 加密 -> CapacitorHttp 原生请求 -> JSON 响应。
// 输出形状与自建 NeteaseCloudMusicApi 服务保持一致，使 src/services/netease.ts 上层无需感知差异。
import { eapiEncrypt, weapiEncrypt } from './crypto';
import {
  buildEapiHeader,
  encodeCookieHeader,
  persistResponseCookies,
  prepareRequestCookie,
  type PreparedCookie,
} from './device';
import { directHttpRequest } from '../../nativeHttpChannel';
import {
  NETEASE_DIRECT_ROUTES,
  type Query,
  type RequestSpec,
} from './endpoints';

const DOMAIN = 'https://music.163.com';
const EAPI_DOMAIN = 'https://interfacepc.music.163.com';
const WEAPI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0';
const EAPI_UA = 'NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)';
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded;charset=utf-8';

const parseEndpointQuery = (endpoint: string): { path: string; query: Query } => {
  const questionIndex = endpoint.indexOf('?');
  const path = questionIndex >= 0 ? endpoint.slice(0, questionIndex) : endpoint;
  const query: Query = {};
  if (questionIndex >= 0) {
    const params = new URLSearchParams(endpoint.slice(questionIndex + 1));
    params.forEach((value, key) => {
      // cookie 与 timestamp 是前端给自建服务准备的参数，直连网易时一律不转发。
      if (key === 'cookie' || key === 'timestamp') return;
      query[key] = value;
    });
  }
  return { path, query };
};

const executeSpecFactory = (target: string, onCookie: (cookie: string) => void) => {
  const execute = async (spec: RequestSpec): Promise<any> => {
    const prepared: PreparedCookie = prepareRequestCookie();
    let url: string;
    let formBody: string;
    const headers: Record<string, string> = {
      'Content-Type': FORM_CONTENT_TYPE,
      Accept: '*/*',
    };

    if (spec.crypto === 'weapi') {
      // csrf_token 放进明文表单字段，URL 走 music.163.com/weapi/...
      const payload = weapiEncrypt({
        ...spec.data,
        csrf_token: prepared.csrfToken,
      });
      url = `${DOMAIN}/weapi/${spec.uri.substring(5)}`;
      const form = new URLSearchParams();
      form.set('params', payload.params);
      form.set('encSecKey', payload.encSecKey);
      formBody = form.toString();
      headers.Cookie = encodeCookieHeader(prepared.map);
      headers.Referer = DOMAIN;
      headers['User-Agent'] = WEAPI_UA;
    } else {
      // eapi 把设备头塞进加密 data.header，URL 走 interfacepc.music.163.com/eapi/...
      const data: Record<string, unknown> = {
        ...spec.data,
        header: buildEapiHeader(prepared),
        // 明确不要加密响应，省掉浏览器侧的 e_r 解密。
        e_r: false,
      };
      const payload = eapiEncrypt(spec.uri, data);
      url = `${EAPI_DOMAIN}/eapi/${spec.uri.substring(5)}`;
      const form = new URLSearchParams();
      form.set('params', payload.params);
      formBody = form.toString();
      // eapi 的 Cookie 只带设备头字段 + MUSIC_U/NMTID（对应 request.js 的 createHeaderCookie(header)）。
      headers.Cookie = encodeCookieHeader(data.header as Record<string, string>);
      headers['User-Agent'] = EAPI_UA;
    }

    let response;
    try {
      response = await directHttpRequest({ url, headers, body: formBody });
    } catch (error) {
      throw Object.assign(
        new Error(
          `NetEase API request ${target} failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        ),
        { networkFailure: true },
      );
    }

    let body: any;
    try {
      body = response.bodyText ? JSON.parse(response.bodyText) : {};
    } catch {
      throw Object.assign(
        new Error(
          `NetEase API ${target} returned HTTP ${response.status} without a JSON body: ${response.bodyText.slice(0, 200) || '(empty)'}`,
        ),
        { httpStatus: response.status },
      );
    }

    const { cookie: mergedCookie, updated } = persistResponseCookies(response.headers);
    if (updated && mergedCookie) onCookie(mergedCookie);
    return body;
  };
  return execute;
};

// 直连入口，签名对齐 fetchWithCreds(endpoint)，忽略 options（直连只发 POST）。
export const neteaseDirectFetch = async (endpoint: string): Promise<any> => {
  const { path, query } = parseEndpointQuery(endpoint);
  const handler = NETEASE_DIRECT_ROUTES[path];
  if (!handler) {
    throw Object.assign(
      new Error(`NetEase direct route unsupported: ${path}`),
      { httpStatus: 404, routeMissing: true },
    );
  }

  let responseCookie = '';
  const execute = executeSpecFactory(path, (cookie) => {
    responseCookie = cookie;
  });
  const body = await handler(query, execute);

  // 扫码确认（803）等场景需要从响应 Set-Cookie 合成 cookie 字段，上层据此写登录态。
  if (responseCookie && body && typeof body === 'object' && !('cookie' in body)) {
    body.cookie = responseCookie;
  }
  return body;
};
