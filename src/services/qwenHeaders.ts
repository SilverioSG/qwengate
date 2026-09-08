export const QWEN_BROWSER_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

export const QWEN_CLIENT_HINTS = {
  'sec-ch-ua': '"Chromium";v="142", "Google Chrome";v="142", "Not?A_Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Linux"',
} as const;

export function buildQwenBrowserHeaders(
  cookie: string,
  options: { method: 'GET' | 'POST'; userAgent?: string; referer?: string; contentType?: string },
): Record<string, string> {
  return {
    ...(options.contentType ? { 'content-type': options.contentType } : {}),
    accept: 'application/json, text/plain, */*',
    source: 'web',
    cookie,
    origin: 'https://chat.qwen.ai',
    referer: options.referer || 'https://chat.qwen.ai/',
    'user-agent': options.userAgent || QWEN_BROWSER_USER_AGENT,
    ...QWEN_CLIENT_HINTS,
  };
}
