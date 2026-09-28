export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Fetch wrapper for the { success, data | error } envelope used by every API route. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData) && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const res = await fetch(path, { ...init, headers, credentials: "same-origin" });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ApiError("INTERNAL_ERROR", "Unexpected response from server", res.status);
  }
  const envelope = body as { success: boolean; data?: T; error?: { code: string; message: string } };
  if (!res.ok || !envelope.success) {
    throw new ApiError(envelope.error?.code ?? "INTERNAL_ERROR", envelope.error?.message ?? "Request failed", res.status);
  }
  return envelope.data as T;
}
