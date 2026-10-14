// capacitor.config.ts
// Folia for iOS (iPad) — Capacitor 原生壳配置。
// Web 层保持 Vite 构建产物 dist/ 原样，不改动任何业务源码。
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'top.izuna.foliamajor',
  appName: 'Folia',
  webDir: 'dist',
  backgroundColor: '#09090b',
  ios: {
    // WebView 由 FoliaContainerViewController 约束到 safeAreaLayoutGuide，
    // 内容不进入状态栏/主指示条区域，因此关闭 UIScrollView 的二次 inset，避免双重留白。
    contentInset: 'never',
    backgroundColor: '#09090b',
  },
};

export default config;
