import test from "node:test";
import assert from "node:assert/strict";
import {
  createTranslator,
  normalizeLanguage,
  resolveLanguage,
} from "../scripts/i18n.mjs";

test("language resolution prefers a saved supported language", () => {
  assert.equal(resolveLanguage("en", "cs-CZ"), "en");
  assert.equal(resolveLanguage(null, "cs-CZ"), "cs");
  assert.equal(resolveLanguage(null, "de-DE"), "en");
  assert.equal(normalizeLanguage("CS-cz"), "cs");
});

test("translations interpolate dynamic values", () => {
  const cs = createTranslator("cs");
  const en = createTranslator("en");
  assert.equal(cs("nowcastWithin", { minutes: 25 }), "Déšť za 25 min");
  assert.equal(en("nowcastWithin", { minutes: 25 }), "Rain in 25 min");
});

