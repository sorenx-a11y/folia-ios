import {
    REASONING_SUPPRESSION_ATTEMPTS,
    SEGMENTATION_GEMINI_GENERATION_CONFIG,
    SEGMENTATION_JSON_SCHEMA,
    SEGMENTATION_MAX_OUTPUT_TOKENS,
    SEGMENTATION_SCHEMA_NAME,
    buildSegmentationSourcePrompt,
    buildSegmentationSystemPrompt,
    parseSegmentationResponse,
} from '../../../shared/lyricSegmentationPrompt.mjs';
import { rejectsOpenAICompatibleParameter, sendOpenAICompatibleRequest } from '../../../shared/openAICompatibleRequest.mjs';
import { directHttpRequest } from '../nativeHttpChannel';
import {
    detectOpenAICompatibleProvider,
    extractProviderErrorMessage,
    normalizeOpenAIChatCompletionsUrl,
    requestGeminiJson,
    resolveOpenAICompatibleModel,
    resolveOpenAICompatibleTemperature,
} from './nativeAiClient';
import { loadNativeAiSettings, type NativeAiSettings } from './nativeAiSettings';

// src/services/ai/nativeLyricSegmentation.ts
// 原生壳上的 AI 歌词分词。与 electron/aiTextClient.cjs 的 runAiJsonCompletion 走同一套协议：同一份
// system prompt、同一份 schema、同一套「推理压制」阶梯，区别只是把 fetch 换成 CapacitorHttp。
//
// 推理压制这条阶梯在这里不是可选项。分词是机械任务，gemini-3-flash-preview 与 deepseek-v4-flash 都会
// 把整个输出预算花在思考上然后返回空串（实测 52s、零结果），而配置里的地址和模型名是自由文本，无从
// 预知对面是谁，所以只能按顺序试，成功后记住。

const AI_REQUEST_TIMEOUT_MS = 120000;

/** sendOpenAICompatibleRequest 要的是 Response，这里把 directHttpRequest 的结果包成等价形状。 */
interface NativeResponseLike {
    ok: boolean;
    status: number;
    text: () => Promise<string>;
    json: () => Promise<unknown>;
    clone: () => NativeResponseLike;
}

const createResponseLike = (status: number, bodyText: string): NativeResponseLike => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => bodyText,
    json: async () => JSON.parse(bodyText),
    clone: () => createResponseLike(status, bodyText),
});

/** 原生请求无法取消，`init` 里的 signal 与 method 收下但用不上（与 Electron 的 ipcRenderer.invoke 同理）。 */
const createNativeFetch = (timeoutMs: number) => async (
    url: string | URL | Request,
    init: RequestInit = {},
): Promise<NativeResponseLike> => {
    const response = await directHttpRequest({
        url: String(url),
        headers: (init.headers as Record<string, string>) ?? {},
        body: typeof init.body === 'string' ? init.body : '',
        readTimeoutMs: timeoutMs,
    });
    return createResponseLike(response.status, response.bodyText);
};

interface ChatChoice {
    finish_reason?: string;
    message?: { content?: unknown; refusal?: unknown; reasoning_content?: unknown };
}

interface ChatUsage {
    completion_tokens_details?: { reasoning_tokens?: number };
}

interface OpenAICompatibleOutcome {
    ok: boolean;
    status: number;
    errorText?: string;
    choice?: ChatChoice;
    usage?: ChatUsage;
    content?: string | null;
    model?: string;
}

/** 正文可能是字符串、分部数组，也可能是拒答；与主进程的 extractResponseContentText 一致。 */
const extractContentText = (message: ChatChoice['message']): string | null => {
    if (!message) return null;
    if (typeof message.refusal === 'string' && message.refusal.trim()) {
        throw new Error(`Model refused request: ${message.refusal}`);
    }
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
        const text = message.content
            .filter((part): part is { type?: string; text?: string } => Boolean(part) && typeof part === 'object')
            .filter(part => part.type === 'text' && typeof part.text === 'string')
            .map(part => part.text as string)
            .join('');
        return text || null;
    }
    return null;
};

/** 只发一次请求，把结果返回给阶梯去判断，而不是在这里抛。 */
const sendNativeOpenAICompatible = async (
    apiUrl: string,
    apiKey: string,
    body: Record<string, unknown>,
    timeoutMs: number,
): Promise<OpenAICompatibleOutcome> => {
    const response: NativeResponseLike = await sendOpenAICompatibleRequest({
        apiUrl,
        provider: detectOpenAICompatibleProvider(apiUrl),
        body,
        init: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        },
        // 共享模块只是在这里发起请求，没有用到 Response 的其余成员；原生通道给的是它的等价子集。
        fetchImpl: createNativeFetch(timeoutMs) as unknown as typeof fetch,
    });

    if (!response.ok) {
        const detail = extractProviderErrorMessage(await response.text());
        return {
            ok: false,
            status: response.status,
            errorText: `OpenAI compatible API error (${response.status})${detail ? `: ${detail}` : ''}`,
        };
    }

    const data = (await response.json()) as { choices?: ChatChoice[]; usage?: ChatUsage; model?: unknown };
    const choice = data?.choices?.[0];
    return {
        ok: true,
        status: response.status,
        choice,
        usage: data?.usage,
        model: typeof data?.model === 'string' ? data.model : undefined,
        content: extractContentText(choice?.message),
    };
};

/** 记住了哪一级阶梯对某个 地址+模型 有效，探测只付一次。 */
const reasoningAttemptCache = new Map<string, number>();

/** HTTP 200、token 照扣、content 为空——这是看起来最像成功的一种失败。 */
const exhaustedByReasoning = (choice?: ChatChoice, usage?: ChatUsage): boolean => {
    const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens;
    const hasReasoning = Boolean(reasoningTokens || choice?.message?.reasoning_content);
    return hasReasoning && choice?.finish_reason === 'length';
};

const describeEmptyCompletion = (choice: ChatChoice | undefined, usage: ChatUsage | undefined, model: string): string => {
    const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens;
    const finishReason = choice?.finish_reason;
    if (exhaustedByReasoning(choice, usage)) {
        return `Model "${model}" used its entire output budget on reasoning`
            + `${reasoningTokens ? ` (${reasoningTokens} reasoning tokens)` : ''} and returned no answer.`
            + ' This is a reasoning model doing a mechanical task. Point the app at a non-reasoning model,'
            + ' or raise the token limit if the provider ignores reasoning_effort.';
    }
    if (finishReason === 'length') {
        return `Model "${model}" hit the output token limit before finishing its answer.`;
    }
    return `Model "${model}" returned an empty response${finishReason ? ` (finish_reason: ${finishReason})` : ''}.`;
};

const runNativeOpenAICompatibleSegmentation = async (lines: string[], settings: NativeAiSettings): Promise<string> => {
    const apiKey = settings.openaiApiKey.trim();
    if (!apiKey) throw new Error('OPENAI_API_KEY is not configured in settings');

    const apiUrl = normalizeOpenAIChatCompletionsUrl(settings.openaiApiUrl);
    const model = resolveOpenAICompatibleModel(apiUrl, settings.openaiApiModel);
    const provider = detectOpenAICompatibleProvider(apiUrl);
    const temperature = resolveOpenAICompatibleTemperature(settings.openaiApiTemperature);

    const messages = [
        { role: 'system', content: buildSegmentationSystemPrompt() },
        { role: 'user', content: buildSegmentationSourcePrompt(lines) },
    ];

    // 只有 OpenAI 自己收 json_schema，其余端点一律退回纯 JSON 模式。
    const responseFormat = provider === 'openai'
        ? {
            type: 'json_schema',
            json_schema: { name: SEGMENTATION_SCHEMA_NAME, strict: true, schema: SEGMENTATION_JSON_SCHEMA },
        }
        : { type: 'json_object' };

    const attempts = REASONING_SUPPRESSION_ATTEMPTS as Array<{ params: Record<string, unknown> }>;
    const cacheKey = `${apiUrl}|${model}`;
    const learned = reasoningAttemptCache.get(cacheKey);
    const firstIndex = typeof learned === 'number' ? learned : 0;

    let lastEmpty: OpenAICompatibleOutcome | null = null;
    for (let index = firstIndex; index < attempts.length; index += 1) {
        const { params } = attempts[index];
        const isLastAttempt = index === attempts.length - 1;
        // 最后一级是给「压根关不掉推理」的模型用的，得同时容下推理和答案；前面几级预期没有推理。
        const budget = isLastAttempt ? SEGMENTATION_MAX_OUTPUT_TOKENS * 4 : SEGMENTATION_MAX_OUTPUT_TOKENS;
        // DeepSeek 的官方开关属于分词策略，不属于通用 HTTP 传输层。
        const reasoningParams = provider === 'deepseek'
            ? { thinking: { type: 'disabled' }, ...params }
            : params;

        const result = await sendNativeOpenAICompatible(apiUrl, apiKey, {
            model,
            messages,
            temperature,
            [provider === 'openai' ? 'max_completion_tokens' : 'max_tokens']: budget,
            ...reasoningParams,
            response_format: responseFormat,
        }, AI_REQUEST_TIMEOUT_MS);

        if (!result.ok) {
            // 参数被端点明确拒绝，说明这一级方言不适用，往下走；其余错误直接报给用户。
            if (!isLastAttempt
                && Object.keys(params).some(key => rejectsOpenAICompatibleParameter(result.status, result.errorText ?? '', key))) {
                continue;
            }
            throw new Error(result.errorText || 'OpenAI compatible request failed');
        }

        if (result.content) {
            reasoningAttemptCache.set(cacheKey, index);
            return result.content;
        }

        lastEmpty = result;
        if (!isLastAttempt && exhaustedByReasoning(result.choice, result.usage)) {
            continue;
        }
        break;
    }

    throw new Error(describeEmptyCompletion(lastEmpty?.choice, lastEmpty?.usage, model));
};

/**
 * 用本机保存的配置分词，返回每行一个边界数组（与 Electron 的 segment-lyrics 同一个契约）。
 * 模型认错的行走 parseSegmentationResponse，那里会给出 null，调用方保留该行默认切分。
 */
export const segmentLyricsNative = async (
    lines: string[],
    settings: NativeAiSettings = loadNativeAiSettings(),
): Promise<(string[] | null)[]> => {
    const sourceLines = lines.map(line => String(line ?? ''));
    if (sourceLines.length === 0) throw new Error('No lyric lines to segment');

    const raw = settings.provider === 'openai'
        ? await runNativeOpenAICompatibleSegmentation(sourceLines, settings)
        : await requestGeminiJson(
            settings,
            buildSegmentationSystemPrompt(),
            buildSegmentationSourcePrompt(sourceLines),
            SEGMENTATION_GEMINI_GENERATION_CONFIG,
            AI_REQUEST_TIMEOUT_MS,
        );

    if (!raw.trim()) throw new Error('Model returned an empty response');

    try {
        const { boundaries, rejections } = parseSegmentationResponse(raw, sourceLines);
        if (rejections.length > 0) {
            console.warn(`[segment-lyrics] ${rejections.length}/${sourceLines.length} lines rejected; first: ${rejections[0]}`);
        }
        return boundaries;
    } catch (error) {
        // 被拒的原始响应是唯一能说明「为什么」的证据，抛出去之后就没了。
        console.error('[segment-lyrics] rejected model response:', String(raw).slice(0, 4000));
        throw error instanceof Error ? error : new Error(String(error));
    }
};
