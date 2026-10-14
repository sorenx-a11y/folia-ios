// 前端 /xxx?query 风格端点到网易真实 /api/... POST 端点的映射。
// 字段构造逐一对照 @neteasecloudmusicapienhanced/api/module 下对应模块；xeapi 端点（歌曲链接 v1、
// 游客注册、NCBL 打卡）在浏览器无法实现，分别降级到 eapi 老接口或本地空响应。
import QRCode from 'qrcode';

export type Query = Record<string, string>;

export type CryptoKind = 'eapi' | 'weapi';

export interface RequestSpec {
  // 参与 eapi 摘要、也是 /eapi|/weapi 路径拼接基准的原始 /api/... URI。
  uri: string;
  crypto: CryptoKind;
  data: Record<string, unknown>;
}

export type EndpointHandler = (
  query: Query,
  call: (spec: RequestSpec) => Promise<any>,
) => Promise<any>;

const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const eapi = (uri: string, data: Record<string, unknown>): RequestSpec => ({
  uri,
  crypto: 'eapi',
  data,
});

const weapi = (uri: string, data: Record<string, unknown>): RequestSpec => ({
  uri,
  crypto: 'weapi',
  data,
});

// /song/url/v1 原模块走 xeapi（浏览器无法实现），降级到同样返回 {code,data:[...]} 的
// /api/song/enhance/player/url（eapi），按 level 换算 br。
const levelToBr = (level: string | undefined): number => {
  switch (level) {
    case 'standard':
      return 128000;
    case 'exhigh':
      return 320000;
    case 'lossless':
      return 740000;
    case 'hires':
    case 'jyeffect':
    case 'jymaster':
    case 'vivid':
    case 'sky':
      return 999000;
    default:
      return 320000;
  }
};

export const NETEASE_DIRECT_ROUTES: Record<string, EndpointHandler> = {
  // --- 登录 ---
  '/logout': async (_q, call) => call(eapi('/api/logout', {})),

  // 模块包装：{ code: 200, data: <上游响应> }，前端读 data.unikey。
  '/login/qr/key': async (_q, call) => {
    const body = await call(eapi('/api/login/qrcode/unikey', { type: 3 }));
    return { code: 200, data: body };
  },

  // 纯本地模块：二维码内容固定，图片本地生成。
  '/login/qr/create': async (q) => {
    const url = `https://music.163.com/login?codekey=${q.key ?? ''}`;
    const qrimg = q.qrimg === 'true' ? await QRCode.toDataURL(url) : '';
    return { code: 200, data: { qrurl: url, qrimg } };
  },

  '/login/qr/check': async (q, call) =>
    call(eapi('/api/login/qrcode/client/login', { key: q.key ?? '', type: 3 })),

  // 模块在 code=200 时包装成 { data: body }（无顶层 code）。
  '/login/status': async (_q, call) => {
    const body = await call(weapi('/api/w/nuser/account/get', {}));
    return body.code === 200 ? { data: body } : body;
  },

  '/user/account': async (_q, call) => call(weapi('/api/nuser/account/get', {})),

  // 游客注册走 xeapi，无法直连；fetchWithCreds 在直连模式本来就不会调用它，
  // 这里兜底返回空成功，避免误请求。
  '/register/anonimous': async () => ({ code: 200 }),

  // --- 用户数据 ---
  '/like': async (q, call) =>
    call(
      weapi('/api/radio/like', {
        alg: 'itembased',
        trackId: q.id ?? '',
        like: q.like !== 'false',
        time: '3',
      }),
    ),

  // NCBL 加密打卡依赖 chacha20/自定义 RSA/分片上传，且只是听歌计数上报，直连模式降级为成功空响应。
  '/scrobble/v1': async () => ({ code: 200, data: 'scrobble skipped in direct mode' }),

  '/likelist': async (q, call) => call(eapi('/api/song/like/get', { uid: q.uid ?? '' })),

  '/user/playlist': async (q, call) =>
    call(
      weapi('/api/user/playlist', {
        uid: q.uid ?? '',
        limit: num(q.limit, 30),
        offset: num(q.offset, 0),
        includeVideo: true,
      }),
    ),

  // --- 歌单/专辑/歌手 ---
  '/playlist/track/all': async (q, call) => {
    const detail = await call(
      eapi('/api/v6/playlist/detail', { id: q.id ?? '', n: 100000, s: Number(q.s) || 8 }),
    );
    const limit = num(q.limit, 1000);
    const offset = num(q.offset, 0);
    const trackIds: Array<{ id: unknown }> = Array.isArray(detail?.playlist?.trackIds)
      ? detail.playlist.trackIds
      : [];
    const c = `[${trackIds
      .slice(offset, offset + limit)
      .map((item) => `{"id":${item.id}}`)
      .join(',')}]`;
    return call(eapi('/api/v3/song/detail', { c }));
  },

  '/playlist/detail': async (q, call) =>
    call(eapi('/api/v6/playlist/detail', { id: q.id ?? '', n: 100000, s: Number(q.s) || 8 })),

  '/playlist/tracks': async (q, call) => {
    const tracks = (q.tracks ?? '').split(',');
    return call(
      eapi('/api/playlist/manipulate/tracks', {
        op: q.op ?? '',
        pid: q.pid ?? '',
        trackIds: JSON.stringify(tracks),
        imme: 'true',
      }),
    );
  },

  '/album': async (q, call) => call(weapi(`/api/v1/album/${q.id ?? ''}`, {})),

  '/album/sublist': async (q, call) =>
    call(
      weapi('/api/album/sublist', {
        limit: num(q.limit, 25),
        offset: num(q.offset, 0),
        total: true,
      }),
    ),

  '/artist/detail': async (q, call) =>
    call(eapi('/api/artist/head/info/get', { id: q.id ?? '' })),

  '/artist/album': async (q, call) =>
    call(
      weapi(`/api/artist/albums/${q.id ?? ''}`, {
        limit: num(q.limit, 30),
        offset: num(q.offset, 0),
        total: true,
      }),
    ),

  '/artist/top/song': async (q, call) =>
    call(weapi('/api/artist/top/song', { id: q.id ?? '' })),

  '/artist/songs': async (q, call) =>
    call(
      eapi('/api/v1/artist/songs', {
        id: q.id ?? '',
        private_cloud: 'true',
        work_type: 1,
        order: q.order || 'hot',
        offset: num(q.offset, 0),
        limit: num(q.limit, 100),
      }),
    ),

  // --- 歌曲/歌词 ---
  '/song/url/v1': async (q, call) =>
    call(
      eapi('/api/song/enhance/player/url', {
        ids: `[${q.id ?? ''}]`,
        br: levelToBr(q.level),
      }),
    ),

  '/lyric/new': async (q, call) =>
    call(
      eapi('/api/song/lyric/v1', {
        id: q.id ?? '',
        cp: false,
        tv: 0,
        lv: 0,
        rv: 0,
        kv: 0,
        yv: 0,
        ytv: 0,
        yrv: 0,
      }),
    ),

  '/song/chorus': async (q, call) =>
    call(eapi('/api/song/chorus', { ids: JSON.stringify([q.id ?? '']) })),

  // --- 云盘 ---
  '/cloud/lyric/get': async (q, call) =>
    call(
      eapi('/api/cloud/lyric/get', {
        userId: q.uid ?? '',
        songId: q.sid ?? '',
        lv: -1,
        kv: -1,
      }),
    ),

  '/user/cloud': async (q, call) =>
    call(
      weapi('/api/v1/cloud/get', {
        limit: num(q.limit, 30),
        offset: num(q.offset, 0),
      }),
    ),

  '/user/cloud/detail': async (q, call) =>
    call(weapi('/api/v1/cloud/get/byids', { songIds: (q.id ?? '').split(',') })),

  // --- 搜索/推荐 ---
  '/cloudsearch': async (q, call) =>
    call(
      eapi('/api/cloudsearch/pc', {
        s: q.keywords ?? '',
        type: Number(q.type) || 1,
        limit: num(q.limit, 30),
        offset: num(q.offset, 0),
        total: true,
      }),
    ),

  '/personal_fm': async (_q, call) => call(weapi('/api/v1/radio/get', {})),

  '/personal/fm/mode': async (q, call) =>
    call(
      eapi('/api/v1/radio/get', {
        mode: q.mode ?? '',
        subMode: q.submode ?? '',
        limit: num(q.limit, 3),
      }),
    ),

  '/recommend/songs': async (q, call) =>
    call(weapi('/api/v3/discovery/recommend/songs', { afresh: q.afresh ?? '' })),

  '/recommend/songs/dislike': async (q, call) =>
    call(
      weapi('/api/v2/discovery/recommend/dislike', {
        resId: q.id ?? '',
        resType: 4,
        sceneType: 1,
      }),
    ),

  '/history/recommend/songs': async (_q, call) =>
    call(weapi('/api/discovery/recommend/songs/history/recent', {})),

  '/history/recommend/songs/detail': async (q, call) =>
    call(
      weapi('/api/discovery/recommend/songs/history/detail', {
        date: q.date || '',
      }),
    ),

  '/personalized': async (q, call) =>
    call(
      weapi('/api/personalized/playlist', {
        limit: num(q.limit, 30),
        total: true,
        n: 1000,
      }),
    ),

  '/fm_trash': async (q, call) =>
    call(
      weapi('/api/radio/trash/add', {
        songId: q.id ?? '',
        alg: 'RT',
        time: Number(q.time) || 25,
      }),
    ),

  '/playlist/subscribe': async (q, call) => {
    const path = q.t === '1' ? 'subscribe' : 'unsubscribe';
    const data: Record<string, unknown> = { id: q.id ?? '' };
    return call(eapi(`/api/playlist/${path}`, data));
  },

  '/album/sub': async (q, call) => {
    const path = q.t === '1' ? 'sub' : 'unsub';
    return call(weapi(`/api/album/${path}`, { id: q.id ?? '' }));
  },

  '/playlist/detail/dynamic': async (q, call) =>
    call(
      eapi('/api/playlist/detail/dynamic', { id: q.id ?? '', n: 100000, s: Number(q.s) || 8 }),
    ),

  '/album/detail/dynamic': async (q, call) =>
    call(weapi('/api/album/detail/dynamic', { id: q.id ?? '' })),

  '/song/detail': async (q, call) => {
    const ids = (q.ids ?? '').split(/\s*,\s*/);
    const c = `[${ids.map((id) => `{"id":${id}}`).join(',')}]`;
    return call(weapi('/api/v3/song/detail', { c }));
  },

  '/song/copyright/rcmd': async (q, call) =>
    call(eapi('/api/song/copyright/rcmd', { songid: q.songid || q.id || '' })),
};
