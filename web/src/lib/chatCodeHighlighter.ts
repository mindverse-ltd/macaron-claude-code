import { CodeToTokenTransformStream, type RecallToken } from '@shikijs/stream';
import { bundledLanguages, bundledLanguagesInfo, createHighlighter, type BundledLanguage } from 'shiki/bundle/web';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import type { ThemedToken } from 'shiki';

export type ChatCodeLanguage = BundledLanguage | 'text';
export type ChatCodeToken = ThemedToken | RecallToken;
export type ChatCodeTokenStream = ReadableStream<ChatCodeToken>;

type ChatCodeDeltaController = { stream: ChatCodeTokenStream; push: (delta: string) => void; close: () => void };

const CHAT_CODE_THEME = 'vitesse-light';
const CODE_HTML_CACHE_LIMIT = 24;

// Map every bundled language id + its aliases to a canonical id so `resolveChatCodeLanguage`
// can accept the loose fence hints models emit ("js", "shell", "golang") and fall back to plain text.
const chatCodeLanguageAliases = new Map<string, BundledLanguage>();
for (const language of bundledLanguagesInfo) {
  if (!(language.id in bundledLanguages)) continue;
  const languageId = language.id as BundledLanguage;
  chatCodeLanguageAliases.set(languageId, languageId);
  for (const alias of language.aliases ?? []) chatCodeLanguageAliases.set(alias, languageId);
}

let highlighterPromise: ReturnType<typeof createHighlighter> | null = null;
const languageLoadPromises = new Map<BundledLanguage, Promise<void>>();
const codeHtmlCache = new Map<string, string>();

const getHighlighter = () =>
  (highlighterPromise ??= createHighlighter({ langs: [], themes: [CHAT_CODE_THEME], engine: createJavaScriptRegexEngine() }));

async function getHighlighterForLanguage(language: ChatCodeLanguage) {
  const highlighter = await getHighlighter();
  if (language === 'text' || highlighter.getLoadedLanguages().includes(language)) return highlighter;

  let loadPromise = languageLoadPromises.get(language);
  if (!loadPromise) {
    loadPromise = highlighter.loadLanguage(bundledLanguages[language]).then(() => undefined);
    languageLoadPromises.set(language, loadPromise);
  }
  await loadPromise;
  return highlighter;
}

export function resolveChatCodeLanguage(language?: string): ChatCodeLanguage {
  const normalized = language?.trim().toLowerCase();
  if (!normalized) return 'text';
  return chatCodeLanguageAliases.get(normalized) ?? 'text';
}

function getCodeHtmlCacheKey(code: string, language: ChatCodeLanguage) {
  return `${CHAT_CODE_THEME}\0${language}\0${code}`;
}

export async function renderChatCodeToHtml(code: string, language: ChatCodeLanguage) {
  const cacheKey = getCodeHtmlCacheKey(code, language);
  const cached = codeHtmlCache.get(cacheKey);
  if (cached) {
    codeHtmlCache.delete(cacheKey);
    codeHtmlCache.set(cacheKey, cached);
    return cached;
  }

  const highlighter = await getHighlighterForLanguage(language);
  const html = highlighter.codeToHtml(code, { lang: language, theme: CHAT_CODE_THEME });
  codeHtmlCache.set(cacheKey, html);
  if (codeHtmlCache.size > CODE_HTML_CACHE_LIMIT) {
    const oldestKey = codeHtmlCache.keys().next().value;
    if (oldestKey) codeHtmlCache.delete(oldestKey);
  }
  return html;
}

export function createChatCodeDeltaStream(language: ChatCodeLanguage): ChatCodeDeltaController {
  let sourceController: ReadableStreamDefaultController<string> | null = null;
  const source = new ReadableStream<string>({ start(controller) { sourceController = controller; } });

  const stream = new ReadableStream<ChatCodeToken>({
    async start(controller) {
      try {
        const highlighter = await getHighlighterForLanguage(language);
        // The source buffers deltas immediately, so chunks pushed before Shiki boots still replay in order.
        const tokenStream = source.pipeThrough(
          new CodeToTokenTransformStream({ highlighter, lang: language, theme: CHAT_CODE_THEME, allowRecalls: true }),
        );
        const reader = tokenStream.getReader();
        let next = await reader.read();
        while (!next.done) {
          controller.enqueue(next.value);
          next = await reader.read();
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  return {
    stream,
    push(delta) { if (sourceController && delta) sourceController.enqueue(delta); },
    close() {
      if (!sourceController) return;
      sourceController.close();
      sourceController = null;
    },
  };
}
