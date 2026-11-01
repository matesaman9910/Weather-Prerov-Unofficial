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

test("every barometer state has distinct English and Czech wording", () => {
  const cs = createTranslator("cs");
  const en = createTranslator("en");
  const states = [
    "RisingFast",
    "Rising",
    "RisingSlowly",
    "Steady",
    "FallingSlowly",
    "Falling",
    "FallingFast",
  ];
  const levels = ["VeryLow", "Low", "Normal", "High", "VeryHigh", "Unavailable"];
  const keys = [
    "barometerTitle",
    "barometerCurrentLabel",
    "barometerLoading",
    "barometerUnavailable",
    "barometerPastLegend",
    "barometerForecastLegend",
    "barometerSummaryLoading",
    "barometerChartAria",
    "barometerLegendAria",
    "barometerNowLabel",
    "barometerChange",
    "barometerFutureUp",
    "barometerFutureDown",
    "barometerFutureSteady",
    "barometerGraphSummary",
    "barometerGraphSummaryNoForecast",
    ...states.flatMap((state) => [
      `barometerTrend${state}`,
      `barometerTrend${state}Advice`,
    ]),
    ...levels.map((level) => `barometerLevel${level}`),
  ];

  for (const key of keys) {
    assert.notEqual(en(key), key, `missing English ${key}`);
    assert.notEqual(cs(key), en(key), `missing Czech ${key}`);
  }
});

