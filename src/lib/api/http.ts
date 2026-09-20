export class ApiError extends Error {
    readonly pendingVerification: boolean;
    readonly userId: string | undefined;

    constructor(
        message: string,
        readonly status: number,
        readonly data: unknown
    ) {
        super(message);
        this.name = 'ApiError';
        this.pendingVerification = hasBooleanProperty(data, 'pendingVerification');
        this.userId = getStringProperty(data, 'userId');
    }
}

function hasBooleanProperty(value: unknown, property: string): boolean {
    return typeof value === 'object' && value !== null && property in value && value[property] === true;
}

function getStringProperty(value: unknown, property: string): string | undefined {
    return typeof value === 'object' && value !== null && property in value && typeof value[property] === 'string'
        ? value[property]
        : undefined;
}

export function getErrorMessage(error: unknown, fallback: string): string {
    return error instanceof Error && error.message ? error.message : fallback;
}

function getApiErrorMessage(data: unknown, fallback: string): string {
    if (typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string') {
        return data.error;
    }
    return fallback;
}

export async function apiFetch<T = unknown>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const isFormData = options.body instanceof FormData;
    const headers = new Headers(options.headers);
    if (!isFormData && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

    const res = await fetch(endpoint, { ...options, headers, credentials: 'include' });
    const text = await res.text();
    let data: unknown = null;

    if (text) {
        try {
            data = JSON.parse(text);
        } catch {
            if (!res.ok) throw new ApiError(`API Request Failed (${res.status})`, res.status, text);
            return text as T;
        }
    }

    if (!res.ok) {
        throw new ApiError(getApiErrorMessage(data, `API Request Failed (${res.status})`), res.status, data);
    }
    return data as T;
}
