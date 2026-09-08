import { decrementInFlight, getAllAccountEmails, getTokenWithAccount } from './auth.ts';
import { browserlessFetch } from './browserlessFetch.ts';
import { config } from './configService.ts';
import { DEFAULT_SYSTEM_PROMPT } from './defaultSystemPrompt.ts';
import { logStore } from './logStore.ts';
import { completeEntry, errorEntry } from './networkDebug.ts';
import { getBasicHeaders } from './playwright.ts';
import { QWEN_API_BASE, QWEN_CHATS_URL, QWEN_MODELS_URL, QWEN_SETTINGS_URL } from './qwen.ts';

export { DEFAULT_SYSTEM_PROMPT };

/**
 * Client-hint profile for GET /api/models — coherent with the wreq chrome_142
 * transport and the main chat path (qwen.ts) / chats/new (sessionPool.ts).
 * The WAF challenges this endpoint when UA + client hints are absent (A/B verified).
 */
export const MODELS_CLIENT_HINTS = {
  'sec-ch-ua': '"Chromium";v="142", "Google Chrome";v="142", "Not?A_Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Linux"',
} as const;

/** Canonical GET /api/models request shape. */
export interface ModelsRequest {
  url: string;
  method: 'GET';
  headers: Record<string, string>;
}

/**
 * Build the canonical models request. Cookie handling is unchanged
 * (token-only passthrough); bx-* injection stays in browserlessFetch.
 * userAgent comes from getBasicHeaders() (centralized, dynamic).
 */
export function buildModelsRequest(cookieStr: string, userAgent: string): ModelsRequest {
  return {
    url: QWEN_MODELS_URL,
    method: 'GET',
    headers: {
      accept: 'application/json, text/plain, */*',
      source: 'web',
      origin: QWEN_API_BASE,
      referer: 'https://chat.qwen.ai/',
      ...(cookieStr ? { cookie: cookieStr } : {}),
      // WAF fix: real browser UA + coherent client hints.
      'user-agent': userAgent,
      ...MODELS_CLIENT_HINTS,
    },
  };
}

/** Canonical POST /api/v2/users/user/settings/update request shape. */
export interface SettingsRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

/**
 * Build the canonical settings/update request. Cookie handling is unchanged
 * (token-only passthrough, key always present); bx-* injection stays in
 * browserlessFetch. userAgent comes from getBasicHeaders() (centralized,
 * dynamic). Only UA + coherent client hints are added — the WAF probes (P1
 * PASS with UA+CH alone, P2 FAIL with full cookies but no UA) proved nothing
 * else is needed, so origin/referer/body/bx/version/timezone/lang/x-request-id
 * stay exactly as before.
 */
export function buildSettingsRequest(cookieStr: string, userAgent: string, bodyStr: string): SettingsRequest {
  return {
    url: QWEN_SETTINGS_URL,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/plain, */*',
      source: 'web',
      cookie: cookieStr,
      origin: QWEN_API_BASE,
      referer: 'https://chat.qwen.ai/',
      // WAF fix: real browser UA + coherent client hints (same profile as models).
      'user-agent': userAgent,
      ...MODELS_CLIENT_HINTS,
    },
    body: bodyStr,
  };
}

async function postQwenSettings(
  email: string | undefined,
  payload: Record<string, unknown>,
): Promise<{ response: Response; debugId: string }> {
  const bodyStr = JSON.stringify(payload);
  const tokenInfo = email ? await getTokenWithAccount(email) : null;
  const cookieStr = tokenInfo ? `token=${tokenInfo.token}` : '';
  // Centralized UA (chrome_142/Linux). With an explicit email this performs no
  // pickAccount and touches no inFlight counters; without email we fall back to
  // the static transport UA instead of picking an account.
  const basic = email ? await getBasicHeaders(email).catch(() => null) : null;
  const userAgent =
    basic?.userAgent ||
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
  const req = buildSettingsRequest(cookieStr, userAgent, bodyStr);
  const response = await browserlessFetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    accountEmail: email,
  });
  return { response, debugId: 'browserless-' + Date.now() };
}

let cachedModels: any[] | null = null;
let lastModelsFetch = 0;
let customInstructionApplied = false;
let applyingCustomInstructionInProgress: Promise<void> | null = null;

export async function setCustomInstruction(instruction: string): Promise<void> {
  if (!instruction || instruction.trim().length === 0) return;
  if (customInstructionApplied) return;
  if (applyingCustomInstructionInProgress) {
    await applyingCustomInstructionInProgress;
    return;
  }
  applyingCustomInstructionInProgress = (async () => {
    const emails = getAllAccountEmails();
    const accountsToProcess = emails.length > 0 ? emails : ['primary'];
    let successCount = 0;
    for (const email of accountsToProcess) {
      let settingsDebugId: string | null = null;
      try {
        const payload = {
          personalization: {
            instruction: instruction,
            enable_for_new_chat: true,
          },
        };
        const { response, debugId } = await postQwenSettings(email, payload);
        settingsDebugId = debugId;
        if (!response.ok) {
          const text = await response.text();
          console.error(`[Qwen] Failed to set custom instruction for ${email}: ${response.status} - ${text}`);
        } else {
          successCount++;
        }
        completeEntry(settingsDebugId);
      } catch (err: any) {
        if (settingsDebugId) errorEntry(settingsDebugId, err.message);
        console.error(`[Qwen] Error setting custom instruction for ${email}: ${err.message}`);
      }
    }
    customInstructionApplied = successCount > 0;
    if (!customInstructionApplied) {
      console.error('[Qwen] Custom instruction failed for all accounts — will retry on next call');
    }
  })();
  try {
    return await applyingCustomInstructionInProgress;
  } finally {
    applyingCustomInstructionInProgress = null;
  }
}

export async function configureAccount(email: string, instruction?: string): Promise<void> {
  let settingsDebugId: string | null = null;
  try {
    const payload: Record<string, any> = {
      tools_enabled: {
        web_extractor: false,
        web_search_image: false,
        web_search: false,
        image_gen_tool: false,
        code_interpreter: false,
        history_retriever: false,
        image_edit_tool: false,
        bio: false,
        image_zoom_in_tool: false,
        image_search: false,
      },
      memory: { enable_memory: false, enable_history_memory: false },
      mcp: { 'code-interpreter': false, 'fire-crawl': false, amap: false, 'image-generation': false },
    };
    if (instruction && instruction.trim().length > 0) {
      payload.personalization = { instruction, enable_for_new_chat: true };
    } else if (!instruction) {
      const useCustom = config.get('USE_CUSTOM_INSTRUCTION') === 'true';
      const resolved = useCustom ? config.get('CUSTOM_INSTRUCTION') : DEFAULT_SYSTEM_PROMPT;
      if (resolved && resolved.trim().length > 0) {
        payload.personalization = { instruction: resolved, enable_for_new_chat: true };
      }
    }
    const { response, debugId } = await postQwenSettings(email, payload);
    settingsDebugId = debugId;
    if (response.ok) {
      logStore.log('info', 'account', `Account ${email} configured (tools off, memory off${instruction ? ', instruction set' : ''})`);
    } else {
      const text = await response.text();
      console.error(`[Qwen] Failed to configure ${email}: ${response.status} - ${text}`);
    }
    completeEntry(settingsDebugId);
  } catch (err: any) {
    if (settingsDebugId) errorEntry(settingsDebugId, err.message);
    console.error(`[Qwen] Error configuring ${email}: ${err.message}`);
  }
}

export async function deleteAllChats(email: string): Promise<void> {
  try {
    const tokenInfo = email ? await getTokenWithAccount(email) : null;
    const cookieStr = tokenInfo ? `token=${tokenInfo.token}` : '';
    const response = await browserlessFetch(QWEN_CHATS_URL, {
      method: 'DELETE',
      headers: {
        accept: 'application/json, text/plain, */*',
        source: 'web',
        cookie: cookieStr,
        origin: QWEN_API_BASE,
        referer: 'https://chat.qwen.ai/',
      },
      accountEmail: email,
    });
    if (response.ok) {
      const body = await response.json().catch(() => ({}));
      if (body?.success !== false) {
        logStore.log('info', 'account', `All chats deleted for ${email}`);
      } else {
        throw new Error(`Delete chats failed: ${body?.message || body?.error || JSON.stringify(body)}`);
      }
    } else {
      const errText = await response.text().catch(() => '');
      throw new Error(`Delete chats failed for ${email}: ${response.status} - ${errText}`);
    }
    return;
  } catch (err: any) {
    console.error(`[Qwen] Error deleting chats for ${email}: ${err.message}`);
    throw err;
  }
}

export async function fetchQwenModels(): Promise<any[]> {
  const now = Date.now();
  const cacheTtl = config.getInt('MODELS_CACHE_TTL_MS', 3600000);
  if (cachedModels && now - lastModelsFetch < cacheTtl) {
    return cachedModels;
  }

  const basic = await getBasicHeaders();
  const resolvedEmail = basic.email;
  if (resolvedEmail) decrementInFlight(resolvedEmail);

  const tokenInfo = resolvedEmail ? await getTokenWithAccount(resolvedEmail) : null;
  const cookieStr = tokenInfo ? `token=${tokenInfo.token}` : '';

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * attempt));

      const req = buildModelsRequest(cookieStr, basic.userAgent);
      const response = await browserlessFetch(req.url, {
        method: req.method,
        headers: req.headers,
        accountEmail: resolvedEmail,
      });

      if (!response.ok) throw new Error(`Failed to fetch models from Qwen: ${response.status} ${response.statusText}`);

      const json = JSON.parse(await response.text());
      if (!json.data || !Array.isArray(json.data)) {
        logStore.log('debug', 'qwen', `[Qwen] fetchQwenModels: response missing data array, returning cached or empty`);
        return cachedModels || [];
      }

      const models = json.data.map((m: any) => ({
        id: m.id,
        object: 'model',
        created: m.info?.created_at || Math.floor(Date.now() / 1000),
        owned_by: m.owned_by || 'qwen',
        context_window: m.info?.meta?.max_context_length ?? 1000000,
        max_output_tokens: m.info?.meta?.max_summary_generation_length ?? 65536,
        modalities: m.info?.meta?.modality ?? ['text'],
        description: m.info?.meta?.short_description || m.info?.meta?.description || '',
        capabilities: m.info?.meta?.capabilities || {},
      }));

      cachedModels = models;
      lastModelsFetch = now;
      return models;
    } catch (err: any) {
      lastErr = err;
    }
  }

  console.error(`[Qwen] fetchQwenModels failed after 3 attempts:`, lastErr?.message);
  return cachedModels || [];
}
