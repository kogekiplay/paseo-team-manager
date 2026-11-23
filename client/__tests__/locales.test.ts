import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.resolve(CURRENT_DIR, "..", "locales");

type Str = string;
type UnknownVal = unknown;
type LocaleMap = Map<Str, Str>;

function flattenResource(resource: UnknownVal, prefix = ""): LocaleMap {
  assert.ok(
    resource !== null && typeof resource === "object" && !Array.isArray(resource),
    `Locale resource at "${prefix || "(root)"}" must be a plain object`,
  );
  const result: LocaleMap = new Map();
  for (const [key, value] of Object.entries(resource as Record<Str, UnknownVal>)) {
    assert.ok(key.length > 0, "Locale key must not be empty");
    assert.ok(!key.includes("."), `Locale key segment must not contain ".": ${key}`);
    assert.ok(
      !["__proto__", "constructor", "prototype"].includes(key),
      `Forbidden locale key segment: ${key}`,
    );
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      result.set(fullKey, value);
    } else {
      for (const [nestedKey, nestedValue] of flattenResource(value, fullKey)) {
        result.set(nestedKey, nestedValue);
      }
    }
  }
  return result;
}

function extractPlaceholders(template: Str): Str[] {
  const matches = [...template.matchAll(/{{-?\s*([^},\s]+)(?:[^}]*)}}/g)];
  return [...new Set(matches.map((match) => match[1]))].sort();
}

describe("client locale resources (en.json & zh-CN.json)", () => {
  const enRaw = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, "en.json"), "utf8"));
  const zhRaw = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, "zh-CN.json"), "utf8"));
  const en = flattenResource(enRaw);
  const zhCN = flattenResource(zhRaw);

  it("contains non-empty translations for all keys", () => {
    assert.ok(en.size > 0, "en.json must not be empty");
    for (const [key, value] of en) {
      assert.ok(value.trim().length > 0, `Empty en.json translation for key: ${key}`);
    }
    for (const [key, value] of zhCN) {
      assert.ok(value.trim().length > 0, `Empty zh-CN.json translation for key: ${key}`);
    }
  });

  it("has exact key parity between en.json and zh-CN.json", () => {
    const unknownInZh = [...zhCN.keys()].filter((key) => !en.has(key));
    const missingInZh = [...en.keys()].filter((key) => !zhCN.has(key));
    assert.deepEqual(unknownInZh, [], `Unknown keys in zh-CN.json: ${unknownInZh.join(", ")}`);
    assert.deepEqual(missingInZh, [], `Missing keys in zh-CN.json: ${missingInZh.join(", ")}`);
  });

  it("matches every interpolation placeholder exactly across locales", () => {
    for (const [key, enValue] of en) {
      const zhValue = zhCN.get(key);
      assert.ok(zhValue !== undefined, `Missing zh-CN key: ${key}`);
      const enVars = extractPlaceholders(enValue);
      const zhVars = extractPlaceholders(zhValue);
      assert.deepEqual(
        zhVars,
        enVars,
        `Placeholder mismatch for "${key}": en=[${enVars.join(",")}] vs zh-CN=[${zhVars.join(",")}]`,
      );
    }
  });
});
