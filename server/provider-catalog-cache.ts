import type { PaseoApi } from "@getpaseo/client";
import type { ProviderCatalogEntry } from "../shared/contracts.ts";
import { fetchProviderCatalogSnapshot } from "./rpc.ts";

export interface ProviderCatalogCache {
  getCachedProviders(): readonly ProviderCatalogEntry[];
  update(providers: readonly ProviderCatalogEntry[]): void;
  refresh(paseo: PaseoApi, options?: { cwd?: string; forceRefresh?: boolean }): Promise<readonly ProviderCatalogEntry[]>;
  ensureFresh(paseo: PaseoApi, options?: { cwd?: string; timeoutMs?: number }): Promise<readonly ProviderCatalogEntry[]>;
  bind(paseo: PaseoApi): void;
  dispose(): void;
}

export function createProviderCatalogCache(homeDir = "/"): ProviderCatalogCache {
  let providers: readonly ProviderCatalogEntry[] = [];
  let hasSnapshot = false;
  let refreshPromise: Promise<readonly ProviderCatalogEntry[]> | null = null;
  let unsubscribe: (() => void) | null = null;

  return {
    getCachedProviders: () => providers,
    update(nextProviders) {
      providers = nextProviders;
      hasSnapshot = true;
    },
    async refresh(paseo, { cwd, forceRefresh = false } = {}) {
      if (!forceRefresh && hasSnapshot) return providers;
      if (!refreshPromise) {
        refreshPromise = fetchProviderCatalogSnapshot(paseo, { cwd, refresh: forceRefresh, homeDir })
          .then((snapshot) => {
            providers = snapshot.providers;
            hasSnapshot = true;
            return providers;
          })
          .finally(() => { refreshPromise = null; });
      }
      return refreshPromise;
    },
    async ensureFresh(paseo, { cwd, timeoutMs = 2000 } = {}) {
      if (hasSnapshot) return providers;
      const pending = this.refresh(paseo, { cwd }).catch(() => providers);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<readonly ProviderCatalogEntry[]>((resolve) => {
        timer = setTimeout(() => resolve(providers), timeoutMs);
      });
      try {
        return await Promise.race([pending, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    bind(paseo) {
      if (unsubscribe) return;
      if (!paseo.providers || typeof paseo.providers.subscribe !== "function") return;
      unsubscribe = paseo.providers.subscribe(() => {
        hasSnapshot = false;
      });
    },
    dispose() {
      unsubscribe?.();
      unsubscribe = null;
      providers = [];
      hasSnapshot = false;
      refreshPromise = null;
    },
  };
}
