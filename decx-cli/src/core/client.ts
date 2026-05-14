/**
 * DECX HTTP Client - Direct HTTP client for DECX Server.
 *
 * Communicates with the DECX server via REST API endpoints.
 * All methods return raw JSON responses — no data unwrapping.
 */

import { DecxError } from "../utils/errors.js";
import { logApiCall } from "../utils/logger.js";

export { DecxError };

export type FetchFn = typeof globalThis.fetch;

export type ClassFilterOptions = {
    filter: {
        limit?: number;
        includes: string[];
        excludes: string[];
        regex?: boolean;
    };
};

export type ExportedComponentOptions = {
    includes: string[];
    excludes?: string[];
    regex?: boolean;
};

export type ResourceFilterOptions = {
    filter: {
        includes: string[];
        regex?: boolean;
    };
};

export type SourceFilterOptions = {
    filter: {
        limit?: number;
    };
};

export type GlobalSearchOptions = {
    search: {
        limit?: number;
        includes: string[];
        excludes: string[];
        caseSensitive: boolean;
        regex: boolean;
    };
};

export type ClassGrepOptions = {
    grep: {
        limit: number;
        caseSensitive: boolean;
        regex: boolean;
    };
};

export class DecxClient {
    private baseUrl: string;
    private timeout: number;
    private _fetch: FetchFn;
    private sessionName: string | null;

    constructor(host: string = "127.0.0.1", port: number = 25419, timeout: number = 30, fetchFn?: FetchFn, sessionName?: string) {
        this.baseUrl = `http://${host}:${port}`;
        this.timeout = timeout * 1000;
        this._fetch = fetchFn ?? globalThis.fetch;
        this.sessionName = sessionName ?? null;
    }

    private async request<T = unknown>(
        method: "GET" | "POST",
        apiPath: string,
        data?: Record<string, unknown>
    ): Promise<T> {
        const url = `${this.baseUrl}${apiPath}`;
        const headers: Record<string, string> = {
            Accept: "application/json",
            "Content-Type": "application/json",
        };

        // Debug log (opt-in via DECX_DEBUG=1)
        if (process.env.DECX_DEBUG === "1") {
            console.error(`[DEBUG] ${method} ${url}`);
            if (data) console.error(`[DEBUG] Body: ${JSON.stringify(data)}`);
        }

        const startTime = Date.now();
        let status: "ok" | "error" = "error";
        let errorMsg: string | undefined;

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.timeout);

            const response = await this._fetch(url, {
                method,
                headers,
                body: method === "POST" && data ? JSON.stringify(data) : undefined,
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (response.status === 200) {
                status = "ok";
                return await response.json() as T;
            }

            // Server returns { "error": "E0xx", "message": "..." }
            let errorMessage = `HTTP ${response.status}`;
            let errorCode = `HTTP_${response.status}`;
            try {
                const errorBody = (await response.json()) as {
                    error?: string | { code?: string; message?: string };
                    message?: string;
                };
                if (typeof errorBody.error === "object" && errorBody.error !== null) {
                    errorCode = errorBody.error.code ?? errorCode;
                    errorMessage = errorBody.error.message ?? errorMessage;
                } else if (errorBody.error) {
                    errorCode = errorBody.error;
                    errorMessage = errorBody.message ?? errorBody.error;
                }
            } catch {
                // ignore parse errors
            }
            errorMsg = errorMessage;
            throw new DecxError(errorMessage, errorCode);
        } catch (err) {
            if (err instanceof DecxError) throw err;
            if ((err as Error).name === "AbortError") {
                throw new DecxError("Request timed out", "TIMEOUT");
            }
            throw new DecxError(`Connection failed: ${(err as Error).message}`, "CONNECTION_ERROR");
        } finally {
            if (this.sessionName) {
                logApiCall(this.sessionName, {
                    method,
                    path: apiPath,
                    duration_ms: Date.now() - startTime,
                    status,
                    error: errorMsg,
                });
            }
        }
    }

    // ── Health Check ────────────────────────────────────────────────────────

    async healthCheck(): Promise<Record<string, unknown>> {
        return this.request("GET", "/health");
    }

    async isHealthy(): Promise<boolean> {
        try {
            const result = await this.healthCheck();
            return result.status === "running";
        } catch {
            return false;
        }
    }

    // ── CommonService ───────────────────────────────────────────────────────

    async getClasses(options: ClassFilterOptions, page: number = 1): Promise<Record<string, unknown>> {
        return this.request("POST", "/api/decx/get_classes", { ...options, page });
    }

    async searchGlobalKey(key: string, options: GlobalSearchOptions, page: number = 1): Promise<Record<string, unknown>> {
        return this.request("POST", "/api/decx/search_global_key", { key, ...options, page });
    }

    async getClassContext(cls: string, page: number = 1): Promise<Record<string, unknown>> {
        return this.request("POST", "/api/decx/get_class_context", { cls, page });
    }

    async getClassSource(
        cls: string,
        smali: boolean = false,
        options: SourceFilterOptions = { filter: {} },
        page: number = 1
    ): Promise<Record<string, unknown>> {
        return this.request("POST", "/api/decx/get_class_source", { cls, smali, ...options, page });
    }

    async searchClassKey(cls: string, key: string, options: ClassGrepOptions, page: number = 1): Promise<Record<string, unknown>> {
        return this.request("POST", "/api/decx/search_class_key", { cls, key, ...options, page });
    }

    async searchMethod(mth: string, page: number = 1): Promise<Record<string, unknown>> {
        return this.request("POST", "/api/decx/search_method", { mth, page });
    }

    // ── ContextService ──────────────────────────────────────────────────────

    async getMethodSource(mth: string, smali: boolean = false, page: number = 1): Promise<Record<string, unknown>> {
        return this.request("POST", "/api/decx/get_method_source", { mth, smali, page });
    }

    async getMethodContext(mth: string, page: number = 1): Promise<Record<string, unknown>> {
        return this.request("POST", "/api/decx/get_method_context", { mth, page });
    }

    async getMethodCfg(mth: string, page: number = 1): Promise<Record<string, unknown>> {
        return this.request("POST", "/api/decx/get_method_cfg", { mth, page });
    }

    async getMethodXref(mth: string, page: number = 1): Promise<Record<string, unknown>> {
        return this.request("POST", "/api/decx/get_method_xref", { mth, page });
    }

    async getFieldXref(fld: string, page: number = 1): Promise<Record<string, unknown>> {
        return this.request("POST", "/api/decx/get_field_xref", { fld, page });
    }

    async getClassXref(cls: string, page: number = 1): Promise<Record<string, unknown>> {
        return this.request("POST", "/api/decx/get_class_xref", { cls, page });
    }

    async getImplement(iface: string, page: number = 1): Promise<Record<string, unknown>> {
        return this.request("POST", "/api/decx/get_implement", { iface, page });
    }

    async getSubClasses(cls: string, page: number = 1): Promise<Record<string, unknown>> {
        return this.request("POST", "/api/decx/get_sub_classes", { cls, page });
    }

    // ── AndroidService ─────────────────────────────────────────────────────

    async getAidlInterfaces(options: ClassFilterOptions = { filter: { includes: [], excludes: [] } }, page: number = 1): Promise<Record<string, unknown>> {
        return this.request("POST", "/api/decx/get_aidl", { ...options, page });
    }

    async getAppManifest(page: number = 1): Promise<Record<string, unknown>> {
        return this.request("POST", "/api/decx/get_app_manifest", { page });
    }

    async getMainActivity(page: number = 1): Promise<Record<string, unknown>> {
        return this.request("POST", "/api/decx/get_main_activity", { page });
    }

    async getApplication(page: number = 1): Promise<Record<string, unknown>> {
        return this.request("POST", "/api/decx/get_application", { page });
    }

    async getExportedComponents(options: ExportedComponentOptions = { includes: [], excludes: [] }, page: number = 1): Promise<Record<string, unknown>> {
        return this.request("POST", "/api/decx/get_exported_components", { ...options, page });
    }

    async getDeepLinks(page: number = 1): Promise<Record<string, unknown>> {
        return this.request("POST", "/api/decx/get_deep_links", { page });
    }

    async getDynamicReceivers(options: ClassFilterOptions = { filter: { includes: [], excludes: [] } }, page: number = 1): Promise<Record<string, unknown>> {
        return this.request("POST", "/api/decx/get_dynamic_receivers", { ...options, page });
    }

    async getAllResources(options: ResourceFilterOptions = { filter: { includes: [] } }, page: number = 1): Promise<Record<string, unknown>> {
        return this.request("POST", "/api/decx/get_all_resources", { ...options, page });
    }

    async getResourceFile(res: string, page: number = 1): Promise<Record<string, unknown>> {
        return this.request("POST", "/api/decx/get_resource_file", { res, page });
    }

    async getStrings(page: number = 1): Promise<Record<string, unknown>> {
        return this.request("POST", "/api/decx/get_strings", { page });
    }

    async getSystemServiceImpl(iface: string, page: number = 1): Promise<Record<string, unknown>> {
        return this.request("POST", "/api/decx/get_system_service_impl", { iface, page });
    }

}
