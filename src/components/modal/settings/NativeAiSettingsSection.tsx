import React from 'react';
import { Cpu } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SettingsAnchor } from './navigation/SettingsAnchorContext';
import SettingsSectionHeading from './navigation/SettingsSectionHeading';
import { settingsDividerClassFor } from './settingsCardClasses';
import AiConnectionTest from './AiConnectionTest';
import { runNativeAiConnectionTest } from '../../../services/ai/nativeAiClient';
import type { NativeAiProvider, NativeAiSettings } from '../../../services/ai/nativeAiSettings';

// src/components/modal/settings/NativeAiSettingsSection.tsx
// 原生壳（iOS/Android）的「AI 主题设置」。
//
// 桌面端这一段在 DesktopSettingsSubview 里，密钥由 Electron 主进程保管；原生壳没有主进程，
// 也没有可请求的 /api/generate-theme 后端，所以配置存在设备本地，由 App 直接调用服务商。

type NativeAiSettingsSectionProps = {
    isDaylight: boolean;
    settingsCardClass: string;
    utilityGhostButtonClass: string;
    settings: NativeAiSettings;
    onChange: (next: NativeAiSettings) => void;
};

const NativeAiSettingsSection: React.FC<NativeAiSettingsSectionProps> = ({
    isDaylight,
    settingsCardClass,
    utilityGhostButtonClass,
    settings,
    onChange,
}) => {
    const { t } = useTranslation();
    const rowDividerClass = settingsDividerClassFor(isDaylight);
    const fieldClass = `w-full rounded-lg border px-3 py-2 text-sm outline-none transition-colors ${
        isDaylight
            ? 'border-black/10 bg-black/[0.04] focus:border-black/25'
            : 'border-white/10 bg-black/10 focus:border-white/25'
    }`;

    // 每次改动直接落盘：这一页没有「保存」按钮，配置项很少，没有批处理的必要。
    const update = (patch: Partial<NativeAiSettings>) => onChange({ ...settings, ...patch });

    const renderField = (label: React.ReactNode, input: React.ReactNode, hint?: React.ReactNode) => (
        <label className="block space-y-1 text-left">
            <span className="text-xs opacity-60" style={{ color: 'var(--text-secondary)' }}>
                {label}
            </span>
            {input}
            {hint && (
                <span className="block text-[10px] opacity-45 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                    {hint}
                </span>
            )}
        </label>
    );

    const renderProviderOption = (provider: NativeAiProvider, label: React.ReactNode) => {
        const selected = provider === 'openai' ? settings.provider === 'openai' : settings.provider !== 'openai';
        return (
            <button
                type="button"
                onClick={() => update({ provider })}
                className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-all duration-200 ${
                    selected
                        ? (isDaylight ? 'bg-white shadow-sm' : 'bg-white/10 shadow-sm')
                        : 'opacity-50 hover:opacity-100'
                }`}
                style={{ color: 'var(--text-primary)' }}
            >
                {label}
            </button>
        );
    };

    return (
        <SettingsAnchor anchorId="nativeAiProvider" label={t('options.electronSettings')} className="space-y-4">
            <SettingsSectionHeading icon={Cpu} label={t('options.electronSettings')} />

            <div className={`rounded-xl border ${settingsCardClass} overflow-hidden`}>
                <div className={`flex flex-wrap items-center justify-between gap-4 p-4 border-b ${rowDividerClass}`}>
                    <div className="space-y-1 text-left min-w-0">
                        <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                            {t('options.aiProvider')}
                        </div>
                        <div className="text-xs opacity-50 max-w-[28rem]" style={{ color: 'var(--text-secondary)' }}>
                            选择生成智能歌词主题效果的 AI 服务商。「AI 推断」由它读取歌词推断情绪配色。
                        </div>
                    </div>

                    <div className={`flex rounded-xl border p-1 shrink-0 ${isDaylight ? 'bg-black/[0.05] border-black/10' : 'bg-white/5 border-white/5'}`}>
                        {renderProviderOption('gemini', 'Google Gemini')}
                        {renderProviderOption('openai', t('options.otherCompatibleApi'))}
                    </div>
                </div>

                <div className={`p-4 space-y-3 border-b ${rowDividerClass}`}>
                    {settings.provider === 'openai' ? (
                        <>
                            {renderField(
                                t('options.openaiApiUrl'),
                                <input
                                    type="text"
                                    inputMode="url"
                                    autoComplete="off"
                                    value={settings.openaiApiUrl}
                                    onChange={(e) => update({ openaiApiUrl: e.target.value })}
                                    placeholder="https://api.openai.com/v1 或 https://api.deepseek.com"
                                    className={fieldClass}
                                    style={{ color: 'var(--text-primary)' }}
                                />,
                                t('options.openaiApiUrlDesc'),
                            )}
                            {renderField(
                                t('options.openaiApiModel'),
                                <input
                                    type="text"
                                    autoComplete="off"
                                    value={settings.openaiApiModel}
                                    onChange={(e) => update({ openaiApiModel: e.target.value })}
                                    placeholder="gpt-5.6-luna / deepseek-v4-flash"
                                    className={fieldClass}
                                    style={{ color: 'var(--text-primary)' }}
                                />,
                                t('options.openaiApiModelDesc'),
                            )}
                            {renderField(
                                t('options.openaiApiTemperature'),
                                <input
                                    type="number"
                                    min="0"
                                    max="2"
                                    step="0.1"
                                    value={settings.openaiApiTemperature}
                                    onChange={(e) => update({ openaiApiTemperature: e.target.value })}
                                    placeholder="0.7"
                                    className={fieldClass}
                                    style={{ color: 'var(--text-primary)' }}
                                />,
                                t('options.openaiApiTemperatureDesc'),
                            )}
                            {renderField(
                                t('options.openaiApiKey'),
                                <input
                                    type="password"
                                    autoComplete="off"
                                    value={settings.openaiApiKey}
                                    onChange={(e) => update({ openaiApiKey: e.target.value })}
                                    placeholder="sk-..."
                                    className={fieldClass}
                                    style={{ color: 'var(--text-primary)' }}
                                />,
                            )}
                            <AiConnectionTest
                                key="native-ai-openai"
                                payload={{
                                    provider: 'openai',
                                    apiKey: settings.openaiApiKey,
                                    apiUrl: settings.openaiApiUrl,
                                    model: settings.openaiApiModel,
                                    stream: false,
                                }}
                                runTest={runNativeAiConnectionTest}
                                buttonClassName={utilityGhostButtonClass}
                                isDaylight={isDaylight}
                            />
                        </>
                    ) : (
                        <>
                            {renderField(
                                t('options.geminiApiKey'),
                                <input
                                    type="password"
                                    autoComplete="off"
                                    value={settings.geminiApiKey}
                                    onChange={(e) => update({ geminiApiKey: e.target.value })}
                                    placeholder="AIza..."
                                    className={fieldClass}
                                    style={{ color: 'var(--text-primary)' }}
                                />,
                            )}
                            <AiConnectionTest
                                key="native-ai-gemini"
                                payload={{ provider: 'gemini', apiKey: settings.geminiApiKey }}
                                runTest={runNativeAiConnectionTest}
                                buttonClassName={utilityGhostButtonClass}
                                isDaylight={isDaylight}
                            />
                        </>
                    )}
                </div>

                <div className="p-4 text-left">
                    <span className="text-[10px] opacity-45 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                        密钥保存在本设备（localStorage），仅用于让本机直接调用所选服务商；它不会同步到其他设备，也不会上传到任何自建服务。当前平台不支持流式：回复会在完整接收后一次性解析。
                    </span>
                </div>
            </div>
        </SettingsAnchor>
    );
};

export default NativeAiSettingsSection;
