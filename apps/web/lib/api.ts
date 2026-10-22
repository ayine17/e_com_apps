export class ApiError extends Error {
  constructor(public status: number, message: string, public issues?: { path: string; message: string }[]) {
    super(message);
  }
}

/** Calls the API through the same-origin proxy. Throws ApiError with a readable message. */
export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...rest,
    headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = Array.isArray(data.message) ? data.message.join(", ") : data.message;
    const issues = data.issues as { path: string; message: string }[] | undefined;
    throw new ApiError(res.status, issues?.length ? `${msg}: ${issues.map((i) => `${i.path} ${i.message}`).join("; ")}` : msg ?? "Something went wrong", issues);
  }
  return data as T;
}

export async function uploadImage(file: File): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  const res = await api<{ url: string }>("/uploads/images", { method: "POST", body: form });
  return res.url;
}
