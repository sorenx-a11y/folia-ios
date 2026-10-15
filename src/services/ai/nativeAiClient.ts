import type { DualTheme } from '../../types';
import { buildThemeSourcePrompt, buildThemeSystemPrompt, THEME_JSON_SCHEMA } from '../../utils/aiThemePrompts';
import { directHttpRequest } from '../nativeHttpChannel';
import { sanitizeDualTheme } from '../themeSanitizer';
import { loadNativeAiSettings, type NativeAiSettings } from './nativeAiSettings';

// src/services/ai/nativeAiClient.ts
// 原生壳上的 AI 直连客户端：请求由 CapacitorHttp（原生 URLSession）发出，绕开 WKWebView 的 CORS。
//
// 协议对齐 electron/aiTextClient.cjs 与 api-ts/generate-theme_openai.ts：同一个 system prompt、
// 同一份 schema、同一套 OpenAI 兼容端点归一化规则，这样同一条歌词在三端得到的主题是一致的。
//
// 与桌面端的一处必然差异：原生请求无法边收边解析（CapacitorHttp 是一次性响应），所以这里始终非流式，
// 与 Electron 开启「流式传输」时的结果相同——结果本就要等 JSON 收完才解析。

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent';
const GEMINI_MODEL_LABEL = 'gemini-3-flash-preview';
const DEFAULT_OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_OPENAI_MODEL = 'gpt-5.6-luna';
const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash';
const DEFAULT_OPENAI_TEMPERATURE = 0.7;
const THEME_MAX_OUTPUT_TOKENS = 4096;
const THEME_SCHEMA_NAME = 'dual_theme';

// 一次主题生成要读一千多 token 的 JSON，20 秒不够；与 Electron 的 DEFAULT_AI_TIMEOUT_MS 一致。
const AI_REQUEST_TIMEOUT_MS = 120000;
const AI_TEST_TIMEOUT_MS = 30000;
const AI_TEST_MAX_TOKENS = 512;
const AI_TEST_PROMPT = 'hello';
const AI_TEST_MAX_TEXT_CHARS = 500;

type OpenAICompatibleProvider = 'openai' | 'deepseek' | 'generic';

/** 端点归一化：与 electron/aiTextClient.cjs 的 normalizeOpenAIChatCompletionsUrl 同一套规则。 */
export const normalizeOpenAIChatCompletionsUrl = (rawUrl?: string): string => {
    const trimmedUrl = (rawUrl ?? '').trim();
    if (!trimmedUrl) return DEFAULT_OPENAI_CHAT_COMPLETIONS_URL;

    try {
        const parsed = new URL(trimmedUrl);
        const normalizedPath = parsed.pathname.replace(/\/+$/, '');

        if (!normalizedPath || normalizedPath === '/') {
            parsed.pathname = '/v1/chat/completions';
            return parsed.toString();
        }
        if (/\/v\d+$/.test(normalizedPath)) {
            parsed.pathname = `${normalizedPath}/chat/completions`;
            return parsed.toString();
        }
        parsed.pathname = normalizedPath;
        return parsed.toString();
    } catch {
        return trimmedUrl.replace(/\/+$/, '');
    }
};

export const resolveOpenAICompatibleModel = (apiUrl: string, configuredModel?: string): string => {
    const trimmedModel = (configuredModel ?? '').trim();
    if (trimmedModel) return trimmedModel;

    try {
        const hostname = new URL(apiUrl).hostname.toLowerCase();
        if (hostname === 'api.deepseek.com' || hostname.endsWith('.deepseek.com')) {
            return DEEPSEEK_DEFAULT_MODEL;
        }
    } catch {
        // URL 解析不了就退回通用默认模型。
    }
    return DEFAULT_OPENAI_MODEL;
};

export const detectOpenAICompatibleProvider = (apiUrl: string): OpenAICompatibleProvider => {
    try {
        const hostname = new URL(apiUrl).hostname.toLowerCase();
        if (hostname === 'api.deepseek.com' || hostname.endsWith('.deepseek.com')) return 'deepseek';
        if (hostname === 'api.openai.com' || hostname.endsWith('.openai.com')) return 'openai';
    } catch {
        // 落到通用分支。
    }
    return 'generic';
};

export const resolveOpenAICompatibleTemperature = (value: string): number => {
    const temperature = Number.parseFloat(value.trim());
    return Number.isFinite(temperature) && temperature >= 0 && temperature <= 2
        ? temperature
        : DEFAULT_OPENAI_TEMPERATURE;
};

export const extractProviderErrorMessage = (bodyText: string): string => {
    try {
        const parsed = JSON.parse(bodyText) as { error?: unknown; message?: unknown };
        const error = parsed?.error;
        if (typeof error === 'string') return error;
        if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
            return (error as { message: string }).message;
        }
        if (typeof parsed?.message === 'string') return parsed.message;
    } catch {
        // 非 JSON 的错误原样带出去。
    }
    return bodyText.trim().slice(0, 500);
};

const isOk = (status: number): boolean => status >= 200 && status < 300;

/** 响应体里的 JSON 文本可能被 ``` 包住（服务商把 schema 文本当成了排版建议）。 */
const stripCodeFence = (text: string): string => {
    const trimmed = text.trim();
    if (!trimmed.startsWith('```')) return trimmed;
    return trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
};

const parseThemeText = (text: string): DualTheme => {
    const parsed = JSON.parse(stripCodeFence(text));
    const theme = sanitizeDualTheme(parsed);
    theme.light.provider = 'Google Gemini';
    theme.dark.provider = 'Google Gemini';
    return theme;
};

/** OpenAI 兼容响应的正文：可能是字符串，也可能是分部数组，还可能是拒答。 */
const extractChatMessageText = (payload: unknown): string => {
    const message = (payload as { choices?: Array<{ message?: { content?: unknown; refusal?: unknown } }> })
        ?.choices?.[0]?.message;
    if (!message) return '';

    if (typeof message.refusal === 'string' && message.refusal.trim()) {
        throw new Error(`Model refused request: ${message.refusal}`);
    }
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
        return message.content
            .filter((part): part is { type?: string; text?: string } => Boolean(part) && typeof part === 'object')
            .filter(part => part.type === 'text' && typeof part.text === 'string')
            .map(part => part.text as string)
            .join('');
    }
    return '';
};

/** Gemini generateContent：原生响应 schema 只在自家方言里成立，这里用 JSON MIME + 提示词里的 schema。 */
export const requestGeminiJson = async (
    settings: NativeAiSettings,
    systemPrompt: string,
    sourcePrompt: string,
    generationConfig: Record<string, unknown>,
    timeoutMs: number,
): Promise<string> => {
    const apiKey = settings.geminiApiKey.trim();
    if (!apiKey) throw new Error('GEMINI_API_KEY is not configured in settings');

    const response = await directHttpRequest({
        url: GEMINI_ENDPOINT,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ parts: [{ text: sourcePrompt }] }],
            generationConfig,
        }),
        readTimeoutMs: timeoutMs,
    });

    if (!isOk(response.status)) {
        throw new Error(`Gemini API error: ${response.status} ${extractProviderErrorMessage(response.bodyText)}`);
    }

    const payload = JSON.parse(response.bodyText) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const parts = payload?.candidates?.[0]?.content?.parts;
    return Array.isArray(parts)
        ? parts.filter(part => typeof part?.text === 'string').map(part => part.text as string).join('')
        : '';
};

/** OpenAI 兼容 chat/completions；只有官方 OpenAI 收结构化输出，其余走 json_object。 */
const requestOpenAICompatibleJson = async (
    settings: NativeAiSettings,
    body: Record<string, unknown>,
    timeoutMs: number,
): Promise<{ text: string; model?: string }> => {
    const apiKey = settings.openaiApiKey.trim();
    if (!apiKey) throw new Error('OPENAI_API_KEY is not configured in settings');

    const url = normalizeOpenAIChatCompletionsUrl(settings.openaiApiUrl);
    const response = await directHttpRequest({
        url,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        readTimeoutMs: timeoutMs,
    });

    if (!isOk(response.status)) {
        throw new Error(`OpenAI compatible API error (${response.status}): ${extractProviderErrorMessage(response.bodyText)}`);
    }

    const payload = JSON.parse(response.bodyText);
    const model = typeof (payload as { model?: unknown }).model === 'string'
        ? (payload as { model: string }).model
        : undefined;
    return { text: extractChatMessageText(payload), model };
};

const buildOpenAICompatibleRequestBody = (
    settings: NativeAiSettings,
    systemPrompt: string,
    sourcePrompt: string,
): { url: string; body: Record<string, unknown> } => {
    const url = normalizeOpenAIChatCompletionsUrl(settings.openaiApiUrl);
    const model = resolveOpenAICompatibleModel(url, settings.openaiApiModel);
    const provider = detectOpenAICompatibleProvider(url);
    const tokenLimitKey = provider === 'openai' ? 'max_completion_tokens' : 'max_tokens';

    return {
        url,
        body: {
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: sourcePrompt },
            ],
            temperature: resolveOpenAICompatibleTemperature(settings.openaiApiTemperature),
            [tokenLimitKey]: THEME_MAX_OUTPUT_TOKENS,
            response_format: provider === 'openai'
                ? { type: 'json_schema', json_schema: { name: THEME_SCHEMA_NAME, strict: true, schema: THEME_JSON_SCHEMA } }
                : { type: 'json_object' },
        },
    };
};

/**
 * 用本地配置直接生成双主题（「识别主题」在原生壳上的实现）。
 * 抛出的错误文案与主进程保持一致，`isMissingAiApiKeyError` 才能识别「没配 key」这一类失败。
 */
export const generateNativeAiTheme = async ({
    lyricsText,
    isPureMusic = false,
    songTitle,
    settings = loadNativeAiSettings(),
}: {
    lyricsText: string;
    isPureMusic?: boolean;
    songTitle?: string;
    settings?: NativeAiSettings;
}): Promise<DualTheme> => {
    const snippet = lyricsText.slice(0, 2000);
    const systemPrompt = buildThemeSystemPrompt();
    const sourcePrompt = buildThemeSourcePrompt(snippet, isPureMusic, songTitle);

    if (settings.provider === 'openai') {
        const { body } = buildOpenAICompatibleRequestBody(settings, systemPrompt, sourcePrompt);
        const { text } = await requestOpenAICompatibleJson(settings, body, AI_REQUEST_TIMEOUT_MS);
        if (!text.trim()) throw new Error('Model returned an empty response');
        const theme = sanitizeDualTheme(JSON.parse(stripCodeFence(text)));
        theme.light.provider = 'OpenAI Compatible';
        theme.dark.provider = 'OpenAI Compatible';
        return theme;
    }

    const text = await requestGeminiJson(
        settings,
        systemPrompt,
        sourcePrompt,
        { responseMimeType: 'application/json' },
        AI_REQUEST_TIMEOUT_MS,
    );
    if (!text.trim()) throw new Error('Model returned an empty response');
    return parseThemeText(text);
};

const truncate = (text: string, limit: number): string => (text.length > limit ? `${text.slice(0, limit)}…` : text);

/** 密钥可能被服务商的报错原文回显，送进界面前先抹掉。 */
const redactApiKey = (message: string, apiKey: string): string => {
    let text = apiKey ? message.split(apiKey).join('***') : message;
    return text
        .replace(/(bearer\s+)[^\s"',;]+/gi, '$1***')
        .replace(/(x-goog-api-key["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1***')
        .replace(/([?&](?:key|api[_-]?key|token|access_token)=)[^&\s"']+/gi, '$1***');
};

/**
 * 「测试连接」在原生壳上的实现：用表单当前值发一条 hello，走与真实生成完全相同的请求路径。
 * 与主进程一样不抛异常——连接失败本身就是这个函数要报告的结果。
 */
export const runNativeAiConnectionTest = async (
    payload: AiConnectionTestPayload,
): Promise<AiConnectionTestResult> => {
    const startedAt = Date.now();
    const finish = (result: Omit<AiConnectionTestResult, 'durationMs'>): AiConnectionTestResult => ({
        durationMs: Date.now() - startedAt,
        ...result,
    });
    const failure = (message: string, extra: Partial<AiConnectionTestResult> = {}): AiConnectionTestResult => finish({
        ok: false,
        error: truncate(redactApiKey(String(message), payload.apiKey ?? ''), AI_TEST_MAX_TEXT_CHARS),
        ...extra,
    });
    const describeFailure = (error: unknown): AiConnectionTestResult => {
        const message = error instanceof Error ? error.message : String(error);
        return failure(message, { errorKind: /time(?:d)? ?out|timeout/i.test(message) ? 'timeout' : 'network' });
    };

    if (payload.provider === 'gemini') {
        const settings: NativeAiSettings = { ...loadNativeAiSettings(), provider: 'gemini', geminiApiKey: payload.apiKey ?? '' };
        if (!settings.geminiApiKey.trim()) {
            return finish({ ok: false, errorKind: 'config', error: 'GEMINI_API_KEY is not configured in settings' });
        }
        let text = '';
        try {
            text = await requestGeminiJson(
                settings,
                '',
                AI_TEST_PROMPT,
                // gemini-3-flash-preview 默认会思考，不关掉的话 hello 还没答完预算就用光了。
                { maxOutputTokens: AI_TEST_MAX_TOKENS, thinkingConfig: { thinkingBudget: 0 } },
                AI_TEST_TIMEOUT_MS,
            );
        } catch (error) {
            return describeFailure(error);
        }
        if (!text.trim()) {
            return finish({ ok: true, status: 200, model: GEMINI_MODEL_LABEL, text: '', emptyReason: 'empty' });
        }
        return finish({
            ok: true,
            status: 200,
            model: GEMINI_MODEL_LABEL,
            text: truncate(redactApiKey(text, payload.apiKey ?? ''), AI_TEST_MAX_TEXT_CHARS),
        });
    }

    const settings: NativeAiSettings = {
        ...loadNativeAiSettings(),
        provider: 'openai',
        openaiApiKey: payload.apiKey ?? '',
        openaiApiUrl: payload.apiUrl ?? '',
        openaiApiModel: payload.model ?? '',
    };
    if (!settings.openaiApiKey.trim()) {
        return finish({ ok: false, errorKind: 'config', error: 'OPENAI_API_KEY is not configured in settings' });
    }

    const url = normalizeOpenAIChatCompletionsUrl(settings.openaiApiUrl);
    const model = resolveOpenAICompatibleModel(url, settings.openaiApiModel);
    const provider = detectOpenAICompatibleProvider(url);
    // 连通性测试不需要压制推理：总是思考的模型反而会因此报错，空回复照样按下面的空回复处理。
    const body = {
        model,
        messages: [{ role: 'user', content: AI_TEST_PROMPT }],
        [provider === 'openai' ? 'max_completion_tokens' : 'max_tokens']: AI_TEST_MAX_TOKENS,
    };

    try {
        const result = await requestOpenAICompatibleJson(settings, body, AI_TEST_TIMEOUT_MS);
        if (!result.text.trim()) {
            return finish({ ok: true, status: 200, model: result.model || model, text: '', emptyReason: 'empty' });
        }
        return finish({
            ok: true,
            status: 200,
            model: result.model || model,
            text: truncate(redactApiKey(result.text, settings.openaiApiKey), AI_TEST_MAX_TEXT_CHARS),
        });
    } catch (error) {
        return describeFailure(error);
    }
};
