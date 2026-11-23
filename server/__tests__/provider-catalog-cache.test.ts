import assert from "node:assert/strict";
import { test } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { createProviderCatalogCache } from "../provider-catalog-cache.ts";

function paseoFixture() {
  let snapshots = 0;
  let refreshes = 0;
  let listener: (() => void) | null = null;
  const paseo = {
    providers: {
      async snapshot() {
        snapshots += 1;
        return { generatedAt: `snapshot-${snapshots}`, entries: [] };
      },
      async refresh() {
        refreshes += 1;
        return { acknowledged: true };
      },
      subscribe(callback: () => void) {
        listener = callback;
        return () => { listener = null; };
      },
    },
  } as unknown as PaseoApi;
  return { paseo, counts: () => ({ snapshots, refreshes }), notify: () => listener?.() };
}

test("provider catalog cache reuses snapshots and refreshes on demand", async () => {
  const fixture = paseoFixture();
  const cache = createProviderCatalogCache("/home/tester");
  assert.deepEqual(cache.getCachedProviders(), []);
  await cache.ensureFresh(fixture.paseo, { cwd: "/repo" });
  assert.deepEqual(fixture.counts(), { snapshots: 1, refreshes: 0 });
  await cache.ensureFresh(fixture.paseo, { cwd: "/repo" });
  assert.deepEqual(fixture.counts(), { snapshots: 1, refreshes: 0 });
  await cache.refresh(fixture.paseo, { cwd: "/repo", forceRefresh: true });
  assert.deepEqual(fixture.counts(), { snapshots: 2, refreshes: 1 });
  cache.dispose();
});

test("provider catalog cache subscribes lazily, invalidates, and tolerates a slow host", async () => {
  const fixture = paseoFixture();
  const cache = createProviderCatalogCache();
  cache.bind(fixture.paseo);
  await cache.ensureFresh(fixture.paseo);
  assert.deepEqual(fixture.counts(), { snapshots: 1, refreshes: 0 });
  fixture.notify();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fixture.counts(), { snapshots: 1, refreshes: 0 });
  await cache.ensureFresh(fixture.paseo);
  assert.deepEqual(fixture.counts(), { snapshots: 2, refreshes: 0 });
  cache.dispose();

  const slow = createProviderCatalogCache();
  const slowPaseo = { providers: { snapshot: () => new Promise<never>(() => {}) } } as unknown as PaseoApi;
  const started = Date.now();
  assert.deepEqual(await slow.ensureFresh(slowPaseo, { timeoutMs: 5 }), []);
  assert.ok(Date.now() - started < 500);
  slow.dispose();
});
