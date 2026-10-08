import { BASE_URL } from "./env";

/**
 * Minimal API client for the end-to-end tests. It sends the session cookie itself (the
 * cookie is `Secure`, so a cookie jar would drop it over http) and the same-origin `Origin`
 * header every mutating request needs. `origin` can be overridden to test the CSRF check.
 */

export interface ApiResponse<T = unknown> {
  status: number;
  headers: Headers;
  /** `data` of a success envelope. */
  data: T;
  /** `error` of a failure envelope. */
  error: { code: string; message: string } | null;
  /** The raw body, for non-JSON responses (exports, patches). */
  text: string;
}

export interface RequestOptions {
  json?: unknown;
  form?: FormData;
  origin?: string | null;
}

export class Session {
  constructor(
    readonly cookie: string | null,
    readonly user: { id: string; email: string } | null = null,
  ) {}

  static anonymous(): Session {
    return new Session(null);
  }

  async request<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {};
    if (this.cookie) headers.cookie = this.cookie;
    const origin = opts.origin === undefined ? BASE_URL : opts.origin;
    if (origin) headers.origin = origin;
    let body: string | FormData | undefined;
    if (opts.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.json);
    } else if (opts.form) {
      body = opts.form;
    }
    const res = await fetch(`${BASE_URL}${path}`, { method, headers, body, redirect: "manual" });
    const text = await res.text();
    let parsed: { success?: boolean; data?: T; error?: { code: string; message: string } } | null = null;
    if ((res.headers.get("content-type") ?? "").includes("application/json")) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    return { status: res.status, headers: res.headers, data: parsed?.data as T, error: parsed?.error ?? null, text };
  }

  get<T = unknown>(path: string, opts?: RequestOptions) {
    return this.request<T>("GET", path, opts);
  }
  post<T = unknown>(path: string, json?: unknown, opts: Omit<RequestOptions, "json"> = {}) {
    return this.request<T>("POST", path, { ...opts, json });
  }
  put<T = unknown>(path: string, json?: unknown) {
    return this.request<T>("PUT", path, { json });
  }
  delete<T = unknown>(path: string) {
    return this.request<T>("DELETE", path);
  }
}

/** Signs up a fresh user and returns its session. */
export async function signUp(label: string): Promise<{ session: Session; email: string; password: string }> {
  const email = `e2e-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = `e2e-password-${Math.random().toString(36).slice(2, 12)}`;
  const res = await Session.anonymous().post<{ user: { id: string; email: string } }>("/api/auth/signup", { name: `E2E ${label}`, email, password });
  if (res.status !== 201) {
    // Sign-ups are limited per client address (5 per hour); a reused stack runs out. Recreate it: npm run e2e:down.
    throw new Error(`Sign-up failed with ${res.status} ${res.error?.code ?? ""}: ${res.error?.message ?? res.text.slice(0, 200)}`);
  }
  return { session: new Session(sessionCookie(res.headers), res.data.user), email, password };
}

export function sessionCookie(headers: Headers): string {
  const cookie = headers.getSetCookie().find((c) => c.startsWith("pd_session="));
  if (!cookie) throw new Error("No session cookie in the response");
  return cookie.split(";")[0]!;
}
