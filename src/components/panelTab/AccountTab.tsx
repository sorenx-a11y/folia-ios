import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { LogOut, SlidersHorizontal, HardDrive, Trash2, RefreshCw, Crown, Server } from 'lucide-react';
import {
    RUNTIME_API_BASE_PROVIDERS,
    readRuntimeApiBase,
    writeRuntimeApiBase,
    type RuntimeApiBaseProviderId,
} from '../../services/onlineMusic/runtimeApiBase';
import { useTranslation } from 'react-i18next';
import type { AudioQualityPreference, ProviderUser } from '../../types/onlineMusic';
import type { LibraryAccountController } from '../../library/core/contracts/account';
import type { LibraryAccountSnapshot } from '../../library/core/contracts/account';
import { useLibraryAccountProviders, useLibraryAccountSelector } from '../../library/core/bindings/useLibraryAccount';
import { canLogoutProvider } from '../../library/core/model/accountRules';
import { useOnlineProviderAccountStore } from '../../stores/useOnlineProviderAccountStore';
import { omni } from '../../services/onlineMusic/omni';

interface AccountTabProps {
    user: ProviderUser | null;
    /** 在线账户 controller：登出走它（各 provider 自己的登出，与首页切换器同一条路径）。 */
    accountController: LibraryAccountController;
    audioQuality: AudioQualityPreference;
    onAudioQualityChange: (quality: AudioQualityPreference) => void;
    cacheSize: string;
    onClearCache: () => void;
    onSyncData: () => void;
    isSyncing: boolean;
    onNavigateHome: () => void;
}

const AUDIO_QUALITY_OPTIONS: Array<{
    value: AudioQualityPreference;
    labelKey: string;
}> = [
    { value: 'standard', labelKey: 'account.qualityStandard' },
    { value: 'high', labelKey: 'account.qualityExhigh' },
    { value: 'lossless', labelKey: 'account.qualityLossless' },
    { value: 'hires', labelKey: 'account.qualityHires' },
];

const selectLogoutPending = (snapshot: LibraryAccountSnapshot) => snapshot.logout.status === 'pending';

// 桌面端有内嵌后端，无需配置；网页与 iOS 封装版在此填写自建音乐 API 地址。
const isWebRuntime = () =>
    !(typeof window !== 'undefined' && typeof (window as any)?.electron?.getNeteasePort === 'function');

const PROVIDER_LABEL_KEYS: Record<RuntimeApiBaseProviderId, string> = {
    netease: 'account.neteaseBase',
    qq: 'account.qqBase',
    kugou: 'account.kugouBase',
};

const MusicServiceEndpointCard: React.FC = () => {
    const { t } = useTranslation();
    const [bases, setBases] = useState<Record<RuntimeApiBaseProviderId, string>>(() => ({
        netease: readRuntimeApiBase('netease'),
        qq: readRuntimeApiBase('qq'),
        kugou: readRuntimeApiBase('kugou'),
    }));

    const handleSave = () => {
        RUNTIME_API_BASE_PROVIDERS.forEach(providerId => writeRuntimeApiBase(providerId, bases[providerId]));
        // 传输层对地址做了会话级缓存，整页重载是让三个平台同时生效的最稳妥方式。
        window.location.reload();
    };

    return (
        <div className="bg-white/5 p-3 rounded-xl">
            <div className="flex items-center gap-2 mb-2 opacity-60">
                <Server size={12} />
                <span className="text-[10px] font-bold uppercase tracking-wide">
                    {t('account.musicServiceTitle')}
                </span>
            </div>
            <p className="text-[10px] opacity-50 leading-relaxed mb-2">
                {t('account.musicServiceHint')}
            </p>
            <div className="flex flex-col gap-2">
                {RUNTIME_API_BASE_PROVIDERS.map(providerId => (
                    <label key={providerId} className="flex flex-col gap-1">
                        <span className="text-[10px] opacity-60">{t(PROVIDER_LABEL_KEYS[providerId])}</span>
                        <input
                            type="url"
                            inputMode="url"
                            autoCapitalize="off"
                            autoCorrect="off"
                            spellCheck={false}
                            placeholder="https://your-server.example.com"
                            value={bases[providerId]}
                            onChange={event => setBases(prev => ({ ...prev, [providerId]: event.target.value }))}
                            className="w-full min-w-0 px-2 py-1.5 rounded-lg bg-black/30 border border-white/10 text-[11px] font-mono text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-white/30"
                        />
                    </label>
                ))}
            </div>
            <button
                type="button"
                onClick={handleSave}
                className="mt-2 w-full py-1.5 bg-white/10 hover:bg-white/20 rounded-lg text-[10px] font-bold transition-colors"
            >
                {t('account.saveAndReload')}
            </button>
        </div>
    );
};

const AccountTab: React.FC<AccountTabProps> = ({
    user,
    accountController,
    audioQuality,
    onAudioQualityChange,
    cacheSize,
    onClearCache,
    onSyncData,
    isSyncing,
    onNavigateHome,
}) => {
    const { t } = useTranslation();
    // 当前平台取 controller 快照里回落过的那个，与登出的判定（只有当前且已登录的平台能登出）一致。
    const { providers, activeProviderId } = useLibraryAccountProviders(accountController);
    const providerAccount = useOnlineProviderAccountStore(state => state.accounts[activeProviderId]);
    const activeUser = providerAccount?.user || (activeProviderId === 'netease' ? user : null);
    // 登出按钮只在 controller 会接受时可用：网易启动 / 首次刷新的窗口里 App 的 user 已经显示，账户 store 却还没写成
    // authenticated，controller 会以 not-authenticated 拒绝——按钮这时不可用，而不是点了没反应；登出进行中同样不可用。
    // 不放宽 controller 的判定：unknown 状态的平台还没有可登出的登录态（切换器的登出入口用的是同一条规则）。
    const logoutPending = useLibraryAccountSelector(accountController, selectLogoutPending);
    const canLogout = !logoutPending
        && canLogoutProvider(providers.find(provider => provider.providerId === activeProviderId), activeProviderId);

    // 网易与其它平台同一条路径：controller 调宿主注入的 per-provider 登出（网易的会清登录态并提示已登出）。
    const handleLogout = async () => {
        await accountController.logout(activeProviderId);
    };

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex flex-col justify-start gap-4 h-full"
        >
            {activeUser ? (
                /* User Info with Logout in Header */
                <div className="flex items-center justify-between bg-white/5 p-3 rounded-xl">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full overflow-hidden">
                            <img
                                src={activeUser.avatarUrl?.replace('http:', 'https:')}
                                className="w-full h-full object-cover"
                                alt={activeUser.nickname}
                            />
                        </div>
                        <div>
                            <div className="flex items-center gap-1.5">
                                <h3 className="font-bold text-sm">{activeUser.nickname}</h3>
                                {Boolean(activeUser.vipType && activeUser.vipType !== 0) && (
                                    <Crown size={14} className="text-white fill-white" />
                                )}
                            </div>
                            <span className="block text-[10px] opacity-50">{omni.getProviderLabel(activeProviderId)}</span>
                            <span className="text-[10px] font-mono opacity-40">ID: {String(activeUser.id)}</span>
                        </div>
                    </div>
                    <button
                        onClick={() => void handleLogout()}
                        disabled={!canLogout}
                        className="p-2 hover:bg-red-500/10 text-red-400 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent"
                        title={t('account.logout')}
                    >
                        <LogOut size={16} />
                    </button>
                </div>
            ) : (
                <div className="flex flex-col items-center justify-center gap-2 py-4 text-center opacity-50">
                    <p>{t('account.guestMode')}</p>
                    <button
                        onClick={onNavigateHome}
                        className="px-4 py-2 bg-white/10 hover:bg-white/20 rounded-full text-xs font-bold"
                    >
                        {t('account.loginOnHome')}
                    </button>
                </div>
            )}

            {/* Provider-independent audio quality preference; each online provider maps these semantic presets. */}
            <div className="bg-white/5 p-3 rounded-xl">
                <div className="flex items-center gap-2 mb-2 opacity-60">
                    <SlidersHorizontal size={12} />
                    <span className="text-[10px] font-bold uppercase tracking-wide">
                        {t('account.audioQuality')}
                    </span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                    {AUDIO_QUALITY_OPTIONS.map(option => (
                        <button
                            key={option.value}
                            type="button"
                            aria-pressed={audioQuality === option.value}
                            onClick={() => onAudioQualityChange(option.value)}
                            className={`py-1.5 text-[10px] font-medium rounded-lg transition-all ${audioQuality === option.value
                                ? 'bg-white/20 shadow-sm'
                                : 'opacity-40 hover:opacity-100 hover:bg-white/5'
                                }`}
                        >
                            {t(option.labelKey)}
                        </button>
                    ))}
                </div>
            </div>

            {/* 网页版 / iOS：登录前必须先配置自建音乐 API 服务地址，桌面端不显示。 */}
            {isWebRuntime() && <MusicServiceEndpointCard />}

            {/* Cache Management Section */}
            {/* <div className="bg-white/5 p-3 rounded-xl mb-2">
                <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2 opacity-60">
                        <HardDrive size={12} />
                        <span className="text-[10px] font-bold uppercase tracking-wide">
                            {t('account.storage')}
                        </span>
                    </div>
                    <span className="text-[10px] font-mono">{cacheSize}</span>
                </div>
                <button
                    onClick={onClearCache}
                    className="w-full py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-300 rounded-lg flex items-center justify-center gap-2 text-[10px] font-bold transition-colors"
                >
                    <Trash2 size={12} />
                    {t('account.clearCache')}
                </button>
            </div> */}

            {activeUser && <button
                onClick={onSyncData}
                disabled={isSyncing}
                className="w-full py-2 bg-white/5 hover:bg-white/10 rounded-lg flex items-center justify-center gap-2 text-xs font-bold opacity-80 transition-colors disabled:opacity-50"
            >
                <RefreshCw size={14} className={isSyncing ? "animate-spin" : ""} />
                {isSyncing ? t('account.syncing') : t('account.syncData')}
            </button>}
        </motion.div>
    );
};

export default AccountTab;

