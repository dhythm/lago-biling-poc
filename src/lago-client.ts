// Lago REST API の薄いラッパー。SDK を使わず fetch だけで、失敗時の挙動を明示する。

export type LagoClientConfig = {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  maxAttempts?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
};

export type LagoApiError = Error & { name: "LagoApiError"; status: number; body: string };

export function lagoApiError(method: string, path: string, status: number, body: string): LagoApiError {
  const error = new Error(`Lago API ${method} ${path} が失敗しました (HTTP ${status}): ${body.slice(0, 500)}`);
  return Object.assign(error, { name: "LagoApiError" as const, status, body });
}

export function isLagoApiError(e: unknown): e is LagoApiError {
  return e instanceof Error && e.name === "LagoApiError";
}

export type LagoClient = {
  get: <T = any>(path: string) => Promise<T>;
  getOrNull: <T = any>(path: string) => Promise<T | null>;
  post: <T = any>(path: string, body: unknown) => Promise<T>;
  put: <T = any>(path: string, body: unknown) => Promise<T>;
  del: <T = any>(path: string) => Promise<T>;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function chunk<T>(items: T[], size: number): T[][] {
  if (size < 1) throw new Error("chunk サイズは1以上にしてください");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function createLagoClient(config: LagoClientConfig): LagoClient {
  const doFetch = config.fetch ?? fetch;
  const maxAttempts = config.maxAttempts ?? 5;
  const retryDelayMs = config.retryDelayMs ?? 500;
  const timeoutMs = config.timeoutMs ?? 30_000;

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await doFetch(`${config.baseUrl}/api/v1${path}`, {
          method,
          headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await res.text();
        if (res.ok) return (text ? JSON.parse(text) : {}) as T;
        const error = lagoApiError(method, path, res.status, text);
        // 4xx(429以外)は呼び出し側の誤りなので再試行しても無駄
        if (res.status < 500 && res.status !== 429) throw error;
        lastError = error;
      } catch (e) {
        if (isLagoApiError(e) && e.status < 500 && e.status !== 429) throw e;
        lastError = e;
      }
      if (attempt < maxAttempts) await sleep(retryDelayMs * 2 ** (attempt - 1));
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  return {
    get: (path) => request("GET", path),
    getOrNull: async (path) => {
      try {
        return await request("GET", path);
      } catch (e) {
        if (isLagoApiError(e) && e.status === 404) return null;
        throw e;
      }
    },
    post: (path, body) => request("POST", path, body),
    put: (path, body) => request("PUT", path, body),
    del: (path) => request("DELETE", path),
  };
}
