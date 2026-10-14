// 网易云 EAPI/WEAPI 请求加密（浏览器可用版）。
// 算法与常量移植自 @neteasecloudmusicapienhanced/api/util/crypto.js，
// 仅保留手机直连需要的 weapi 与 eapi；xeapi/neapi 依赖 Node crypto/x25519/chacha20/zstd，无法在浏览器运行。
import CryptoJS from 'crypto-js';
import forge from 'node-forge';

const IV = '0102030405060708';
const PRESET_KEY = '0CoJUm6Qyw8W8jud';
const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`;
const EAPI_KEY = 'e82ckenh8dichen8';

const aesCbcBase64 = (text: string, key: string): string => {
  const encrypted = CryptoJS.AES.encrypt(
    CryptoJS.enc.Utf8.parse(text),
    CryptoJS.enc.Utf8.parse(key),
    {
      iv: CryptoJS.enc.Utf8.parse(IV),
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    },
  );
  return encrypted.toString();
};

const rsaEncrypt = (text: string): string => {
  const publicKey = forge.pki.publicKeyFromPem(PUBLIC_KEY_PEM);
  // 与 Node 原版一致：RSA 无填充裸模幂，输出 hex。
  const encrypted = publicKey.encrypt(text, 'NONE' as never);
  return forge.util.bytesToHex(encrypted);
};

const randomSecretKey = (): string => {
  let secretKey = '';
  for (let i = 0; i < 16; i += 1) {
    secretKey += BASE62.charAt(Math.round(Math.random() * 61));
  }
  return secretKey;
};

export interface WeapiPayload {
  params: string;
  encSecKey: string;
}

// weapi：JSON 先用 presetKey 做 AES-CBC，再用随机 secretKey 做第二次 AES-CBC；
// secretKey 反转后 RSA 加密为 encSecKey。
export const weapiEncrypt = (object: unknown): WeapiPayload => {
  const text = JSON.stringify(object);
  const secretKey = randomSecretKey();
  const params = aesCbcBase64(aesCbcBase64(text, PRESET_KEY), secretKey);
  const encSecKey = rsaEncrypt(secretKey.split('').reverse().join(''));
  return { params, encSecKey };
};

export interface EapiPayload {
  params: string;
}

// eapi：digest = MD5(`nobody${uri}use${json}md5forencrypt`)，
// data = `${uri}-36cd479b6b5-${json}-36cd479b6b5-${digest}`，AES-ECB 后输出大写 hex。
// uri 必须是原始 /api/... 路径（不是 /eapi/... 实际请求路径）。
export const eapiEncrypt = (uri: string, object: unknown): EapiPayload => {
  const text = typeof object === 'string' ? object : JSON.stringify(object);
  const message = `nobody${uri}use${text}md5forencrypt`;
  const digest = CryptoJS.MD5(message).toString();
  const data = `${uri}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;
  const encrypted = CryptoJS.AES.encrypt(
    CryptoJS.enc.Utf8.parse(data),
    CryptoJS.enc.Utf8.parse(EAPI_KEY),
    {
      mode: CryptoJS.mode.ECB,
      padding: CryptoJS.pad.Pkcs7,
    },
  );
  return { params: encrypted.ciphertext.toString().toUpperCase() };
};

// 生成 NMTID 兜底值：'00O' + 19 字节随机 hex（与 request.js 一致）。
export const randomNmtid = (): string =>
  `00O${CryptoJS.lib.WordArray.random(19).toString()}`;

// 32 字节随机 hex，用作 _ntes_nuid。
export const randomNuid = (): string =>
  CryptoJS.lib.WordArray.random(32).toString();
