import type { ApiErrorPayload } from "../lib/types";

const DEFAULT_API_BASE_PATH = "/api/v1";
const FALLBACK_ORIGIN = "http://localhost:3000";
const viteEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
const runtimeOrigin = typeof window !== "undefined" ? window.location.origin : FALLBACK_ORIGIN;

function resolveApiBaseUrl(rawValue: string | undefined, origin: string) {
  const candidate = rawValue?.trim() || DEFAULT_API_BASE_PATH;
  try {
    return new URL(candidate, origin).toString();
  } catch {
    throw new Error(
      `Invalid VITE_API_BASE_URL value "${candidate}". Use an absolute URL or a path like "/api/v1".`,
    );
  }
}

const API_BASE_URL = resolveApiBaseUrl(viteEnv?.VITE_API_BASE_URL, runtimeOrigin);
const API_ORIGIN = new URL(API_BASE_URL).origin;

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

interface RequestOptions {
  base?: "api" | "origin";
  headers?: Record<string, string>;
}

function buildUrl(
  path: string,
  params?: Record<string, string | number | null | undefined>,
  options?: RequestOptions,
) {
  const baseUrl = options?.base === "origin"
    ? `${API_ORIGIN}/`
    : (API_BASE_URL.endsWith("/") ? API_BASE_URL : `${API_BASE_URL}/`);
  const normalizedPath = path.replace(/^\//, "");
  const url = new URL(normalizedPath, baseUrl);

  Object.entries(params ?? {}).forEach(([key, value]) => {
    if (value == null || value === "") {
      return;
    }

    url.searchParams.set(key, String(value));
  });

  return url.toString();
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  let data: T | ApiErrorPayload = {} as T;

  if (text) {
    try {
      data = JSON.parse(text) as T | ApiErrorPayload;
    } catch {
      throw new ApiError(response.status, "The server returned an unreadable response.");
    }
  }

  if (!response.ok) {
    const errorField = (data as ApiErrorPayload).error;
    const message = typeof errorField === "string"
      ? errorField
      : (errorField as { message: string } | undefined)?.message ?? "Request failed";
    throw new ApiError(response.status, message);
  }

  return data as T;
}

function getStoredAuth(): { token: string | null; workspaceId: string | null } {
  try {
    const raw = localStorage.getItem("raf_auth");
    if (!raw) return { token: null, workspaceId: null };
    const session = JSON.parse(raw);
    return {
      token: session.token ?? session.accessToken ?? null,
      workspaceId: session.workspaceId ?? session.householdId ?? null,
    };
  } catch {
    return { token: null, workspaceId: null };
  }
}

async function performRequest(input: RequestInfo | URL, init?: RequestInit) {
  const auth = getStoredAuth();
  if (auth.token) {
    const headers = new Headers(init?.headers);
    if (!headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${auth.token}`);
    }
    if (auth.workspaceId && !headers.has("X-Workspace-Id")) {
      headers.set("X-Workspace-Id", auth.workspaceId);
    }
    init = { ...init, headers };
  }
  try {
    return await fetch(input, init);
  } catch {
    throw new ApiError(0, "Unable to reach the server. Check the API URL and try again.");
  }
}

export async function getJson<T>(
  path: string,
  params?: Record<string, string | number | null | undefined>,
  options?: RequestOptions,
): Promise<T> {
  const response = await performRequest(buildUrl(path, params, options), {
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
  });

  return parseResponse<T>(response);
}

export async function postJson<T>(
  path: string,
  body: unknown,
  headers?: Record<string, string>,
  options?: RequestOptions,
): Promise<T> {
  const response = await performRequest(buildUrl(path, undefined, options), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });

  return parseResponse<T>(response);
}

export async function putJson<T>(
  path: string,
  body: unknown,
  headers?: Record<string, string>,
  options?: RequestOptions,
): Promise<T> {
  const response = await performRequest(buildUrl(path, undefined, options), {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });

  return parseResponse<T>(response);
}

export async function patchJson<T>(
  path: string,
  body: unknown,
  headers?: Record<string, string>,
  options?: RequestOptions,
): Promise<T> {
  const response = await performRequest(buildUrl(path, undefined, options), {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });

  return parseResponse<T>(response);
}

export async function deleteJson<T>(
  path: string,
  options?: RequestOptions,
): Promise<T> {
  const response = await performRequest(buildUrl(path, undefined, options), {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
  });

  return parseResponse<T>(response);
}

export async function postForm<T>(
  path: string,
  formData: FormData,
  headers?: Record<string, string>,
  options?: RequestOptions,
): Promise<T> {
  const response = await performRequest(buildUrl(path, undefined, options), {
    method: "POST",
    headers: {
      ...(options?.headers ?? {}),
      ...headers,
    },
    body: formData,
  });

  return parseResponse<T>(response);
}
