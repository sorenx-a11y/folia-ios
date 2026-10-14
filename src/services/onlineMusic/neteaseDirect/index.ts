// 网易云手机直连入口：Capacitor 原生平台默认启用（无需自建 API）；
// 浏览器调试可用 localStorage['netease_direct_force']='1' 强制启用（会受 CORS 限制）。
import { Capacitor } from '@capacitor/core';
import { neteaseDirectFetch } from './directClient';

const FORCE_FLAG_STORAGE_KEY = 'netease_direct_force';

export const isNeteaseDirectEnabled = (): boolean => {
  if (Capacitor.isNativePlatform()) return true;
  if (typeof localStorage !== 'undefined') {
    return localStorage.getItem(FORCE_FLAG_STORAGE_KEY) === '1';
  }
  return false;
};

export { neteaseDirectFetch };
