import {
  CITY,
  addDateKey,
  alertPresentation,
  apiTimestampToPragueInstant,
  buildWetPeriods,
  formatPragueDay,
  formatPragueTime,
  filterOlomoucRegionAlerts,
  getNextRain,
  getPragueDateKey,
  getPragueHourKey,
  groupHoursByApiDate,
  pragueLocalDateToInstant,
  recordsFromHourly,
  normalizeSeverity,
  selectActiveAlerts,
  selectSnapshotDay,
  totalPrecipitationMm,
  validateSnapshot,
} from "./weather-core.mjs";
import { createTranslator, resolveLanguage } from "./i18n.mjs";
import { waitForSunCalc } from "./suncalc-loader.mjs";

const APP_VERSION = "2.2.0";
const LANGUAGE_STORAGE_KEY = "prerov-weather-language-v1";
const LIVE_CACHE_KEY = "prerov-weather-live-v4";
const SNAPSHOT_CACHE_KEY = "prerov-weather-snapshot-v1";
const LIVE_CACHE_MAX_AGE = 6 * 60 * 60 * 1000;
const PROXY_BASE = "https://weatherwebsiteprerov.matejkratochvilbilina.workers.dev";
const RADAR_URL = `https://radar.bourky.cz/index.php?img_to_load=10&lat=${CITY.latitude.toFixed(5)}&lon=${CITY.longitude.toFixed(5)}&zoom=10&map_id=1&anim=1&repeat=0&last=0&l_type=0&l_res=0&fcst=1&prod=0&r_opa=25&l_opa=16&b_opa=100&menu_weather=0&menu_weathergraphs=0&menu_webcam=0&menu_cells=0&menu_blitzortung=0&menu_sivs=0&menu_estofex=0&menu_metar=0&menu_planes=0&menu_hydro=0&menu_aero=0&menu_radars=0&menu_wind=0&menu_airquality=0&menu_chasers=0&menu_daynight=1&synop_selected=T&gps=false`;
const LOW_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches
  || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4);

const $ = (id) => document.getElementById(id);
let language = resolveLanguage(safeReadCache(LANGUAGE_STORAGE_KEY), navigator.language);
let locale = language === "cs" ? "cs-CZ" : "en-GB";
let t = createTranslator(language);
let currentSnapshot = null;
let lockedSelection = null;
let lastHours24 = null;

function safeReadCache(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function safeWriteCache(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage may be unavailable in private or hardened browser modes.
  }
}

function applyStaticTranslations() {
  document.documentElement.lang = language;
  document.title = t("pageTitle");
  document.querySelector('meta[name="description"]')?.setAttribute("content", t("pageDescription"));
  for (const node of document.querySelectorAll("[data-i18n]")) {
    node.textContent = t(node.dataset.i18n);
  }
  $("rainChart").setAttribute("aria-label", t("rainChartAria"));
  $("tempWindChart").setAttribute("aria-label", t("tempChartAria"));
  $("languageBtn").textContent = t("switchLanguage");
}

function formatFetchedTime(value) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? formatPragueTime(parsed, locale) : "—";
}

function setAnswer(node, text, level = "pending") {
  node.textContent = text;
  node.className = `answer ${level}`;
}

function renderUnavailableDaily(reason = t("snapshotUnavailable")) {
  lockedSelection = null;
  setAnswer($("rainToday"), t("pending"), "pending");
  $("reasonToday").textContent = t("noLiveSubstitute", { reason });
  $("highlightsToday").textContent = t("waitingPublishedToday");
  setAnswer($("rainTomorrow"), t("pending"), "pending");
  $("reasonTomorrow").textContent = t("tomorrowUnavailable");
  $("highlightsTomorrow").textContent = "—";
}

function periodSummary(period) {
  return t("startsPeakEnds", {
    start: formatPragueTime(period.start, locale),
    peak: formatPragueTime(period.peakTime, locale),
    probability: Math.round(period.peakProbabilityPercent),
    amount: period.peakPrecipitationMm.toFixed(1),
    end: formatPragueTime(period.end, locale),
  });
}

function periodHighlights(periods) {
  return periods.slice(0, 3)
    .map((period) => `${formatPragueTime(period.start, locale)}–${formatPragueTime(period.end, locale)}`)
    .join(" · ");
}

function renderSnapshotDay(day, answerNode, reasonNode, highlightsNode, isToday) {
  const yes = day.verdict === "YES";
  setAnswer(answerNode, t(yes ? "yes" : "no"), yes ? (isToday ? "bad" : "warn") : "ok");
  if (yes) {
    reasonNode.textContent = periodSummary(day.wetPeriods[0]);
    highlightsNode.textContent = periodHighlights(day.wetPeriods);
  } else {
    reasonNode.textContent = isToday
      ? t("noSignificantToday")
      : t("noSignificantPublished");
    highlightsNode.textContent = isToday ? t("allPublishedDry") : "—";
  }
}

function renderSnapshot(snapshot) {
  validateSnapshot(snapshot);
  const selection = selectSnapshotDay(snapshot, new Date());
  if (selection.status !== "available") {
    renderUnavailableDaily(t("currentDateMissing"));
    $("snapshotStatus").textContent = t("snapshotDateMissing", { date: selection.dateKey });
    return false;
  }

  currentSnapshot = snapshot;
  lockedSelection = selection;
  renderSnapshotDay(
    selection.day,
    $("rainToday"),
    $("reasonToday"),
    $("highlightsToday"),
    true,
  );

  const tomorrowKey = addDateKey(selection.dateKey, 1);
  const tomorrow = snapshot.days[tomorrowKey];
  if (tomorrow) {
    renderSnapshotDay(
      tomorrow,
      $("rainTomorrow"),
      $("reasonTomorrow"),
      $("highlightsTomorrow"),
      false,
    );
  } else {
    setAnswer($("rainTomorrow"), t("pending"), "pending");
    $("reasonTomorrow").textContent = t("tomorrowDateMissing", { date: tomorrowKey });
    $("highlightsTomorrow").textContent = "—";
  }

  const generated = new Intl.DateTimeFormat(locale, {
    timeZone: CITY.timezone,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(snapshot.generatedAt));
  $("snapshotStatus").textContent = selection.stale
    ? t("snapshotStale", { generated })
    : t("snapshotLocked", { generated });
  return true;
}

async function loadSnapshot() {
  try {
    const response = await fetch("./data/daily-snapshot.json", {
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const snapshot = await response.json();
    validateSnapshot(snapshot);
    safeWriteCache(SNAPSHOT_CACHE_KEY, {
      snapshot,
      downloadedAt: new Date().toISOString(),
    });
    renderSnapshot(snapshot);
    return;
  } catch (networkError) {
    const cached = safeReadCache(SNAPSHOT_CACHE_KEY);
    if (cached?.snapshot) {
      try {
        validateSnapshot(cached.snapshot);
        const selection = selectSnapshotDay(cached.snapshot, new Date());
        if (selection.status === "available") {
          renderSnapshot(cached.snapshot);
          $("snapshotStatus").textContent += t("cachedSnapshotFallback");
          return;
        }
      } catch {
        // Fall through to the explicit unavailable state.
      }
    }
    renderUnavailableDaily(t("sharedSnapshotUnavailable"));
    $("snapshotStatus").textContent = t("snapshotLoadError", { error: networkError.message });
  }
}

function forecastUrl() {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude: String(CITY.latitude),
    longitude: String(CITY.longitude),
    timezone: CITY.timezone,
    forecast_days: "7",
    forecast_minutely_15: "24",
    minutely_15: "precipitation",
    hourly: [
      "precipitation_probability",
      "precipitation",
      "rain",
      "showers",
      "temperature_2m",
      "apparent_temperature",
      "relative_humidity_2m",
      "cloud_cover",
      "pressure_msl",
      "wind_speed_10m",
      "wind_gusts_10m",
      "uv_index",
    ].join(","),
    daily: [
      "sunrise",
      "sunset",
      "uv_index_max",
      "precipitation_sum",
      "precipitation_probability_max",
      "temperature_2m_max",
      "temperature_2m_min",
      "weather_code",
    ].join(","),
    current: [
      "temperature_2m",
      "apparent_temperature",
      "wind_speed_10m",
      "cloud_cover",
      "pressure_msl",
      "relative_humidity_2m",
      "uv_index",
    ].join(","),
  });
  return url;
}

function airQualityUrl() {
  const url = new URL("https://air-quality-api.open-meteo.com/v1/air-quality");
  url.search = new URLSearchParams({
    latitude: String(CITY.latitude),
    longitude: String(CITY.longitude),
    timezone: CITY.timezone,
    hourly: [
      "pm2_5",
      "pm10",
      "ozone",
      "nitrogen_dioxide",
      "european_aqi",
      "alder_pollen",
      "birch_pollen",
      "grass_pollen",
      "ragweed_pollen",
    ].join(","),
    current: [
      "pm2_5",
      "pm10",
      "ozone",
      "nitrogen_dioxide",
      "european_aqi",
      "alder_pollen",
      "birch_pollen",
      "grass_pollen",
      "ragweed_pollen",
    ].join(","),
  });
  return url;
}

async function fetchJsonWithRetry(url, { attempts = 2, timeoutMs = 10_000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        cache: "no-cache",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!data || typeof data !== "object" || data.error) {
        throw new Error(data?.reason || "Invalid API response");
      }
      return data;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 500 * (attempt + 1)));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

function validateLiveForecast(forecast) {
  if (forecast?.timezone !== CITY.timezone) {
    throw new TypeError(`Forecast timezone was ${forecast?.timezone || "missing"}`);
  }
  const records = recordsFromHourly(forecast.hourly);
  for (const field of [
    "temperature_2m",
    "apparent_temperature",
    "relative_humidity_2m",
    "cloud_cover",
    "pressure_msl",
    "wind_speed_10m",
    "wind_gusts_10m",
    "uv_index",
  ]) {
    if (!Array.isArray(forecast.hourly[field])
      || forecast.hourly[field].length !== forecast.hourly.time.length) {
      throw new TypeError(`Missing or mismatched hourly.${field}`);
    }
  }
  if (!Array.isArray(forecast.daily?.weather_code)) {
    throw new TypeError("Missing daily.weather_code");
  }
  return records;
}

function findCurrentHourIndex(times, now = new Date()) {
  const key = getPragueHourKey(now);
  const exact = times.findIndex((time) => String(time).slice(0, 13) === key);
  if (exact >= 0) return exact;
  let latestPast = -1;
  for (let index = 0; index < times.length; index += 1) {
    const hourKey = String(times[index]).slice(0, 13);
    if (hourKey <= key) latestPast = index;
    else break;
  }
  return latestPast >= 0 ? latestPast : 0;
}

function weatherIcon(code) {
  const numeric = Number(code);
  if (numeric === 0) return ["☀️", t("weatherClear")];
  if ([1, 2].includes(numeric)) return ["🌤️", t("weatherPartlyCloudy")];
  if (numeric === 3) return ["☁️", t("weatherCloudy")];
  if ([45, 48].includes(numeric)) return ["🌫️", t("weatherFog")];
  if ([51, 53, 55, 56, 57].includes(numeric)) return ["🌦️", t("weatherDrizzle")];
  if ([61, 63, 65, 66, 67].includes(numeric)) return ["🌧️", t("weatherRain")];
  if ([71, 73, 75, 77, 85, 86].includes(numeric)) return ["🌨️", t("weatherSnow")];
  if ([80, 81, 82].includes(numeric)) return ["🌦️", t("weatherShowers")];
  if ([95, 96, 99].includes(numeric)) return ["⛈️", t("weatherThunderstorm")];
  return ["❓", t("weatherUnknown")];
}

function moonPhaseName(phase) {
  if (phase < 0.03 || phase > 0.97) return t("moonNew");
  if (phase < 0.22) return t("moonWaxingCrescent");
  if (phase < 0.28) return t("moonFirstQuarter");
  if (phase < 0.47) return t("moonWaxingGibbous");
  if (phase < 0.53) return t("moonFull");
  if (phase < 0.72) return t("moonWaningGibbous");
  if (phase < 0.78) return t("moonLastQuarter");
  return t("moonWaningCrescent");
}

function moonPhaseGlyph(phase) {
  if (phase < 0.03 || phase > 0.97) return "●";
  if (phase < 0.22) return "◔";
  if (phase < 0.28) return "◐";
  if (phase < 0.47) return "◕";
  if (phase < 0.53) return "○";
  if (phase < 0.72) return "◕";
  if (phase < 0.78) return "◑";
  return "◔";
}

function airQualityClass(value) {
  if (!Number.isFinite(value)) {
    return { name: "—", className: "", advice: t("aqiAdviceUnavailable") };
  }
  if (value > 100) {
    return { name: t("aqiExtremelyPoor"), className: "b-poor", advice: t("aqiAdviceExtremelyPoor") };
  }
  if (value > 80) {
    return { name: t("aqiVeryPoor"), className: "b-poor", advice: t("aqiAdviceVeryPoor") };
  }
  if (value > 60) {
    return { name: t("aqiPoor"), className: "b-poor", advice: t("aqiAdvicePoor") };
  }
  if (value > 40) {
    return { name: t("aqiModerate"), className: "b-mod", advice: t("aqiAdviceModerate") };
  }
  if (value > 20) {
    return { name: t("aqiFair"), className: "b-fair", advice: t("aqiAdviceFair") };
  }
  return { name: t("aqiGood"), className: "b-good", advice: t("aqiAdviceGood") };
}

function formattedNumber(value, maximumFractionDigits = 0) {
  return Number.isFinite(value)
    ? new Intl.NumberFormat(locale, { maximumFractionDigits }).format(value)
    : "—";
}

function durationParts(milliseconds) {
  const totalMinutes = Math.max(0, Math.round(milliseconds / 60_000));
  return {
    hours: Math.floor(totalMinutes / 60),
    minutes: totalMinutes % 60,
  };
}

function durationText(milliseconds) {
  const { hours, minutes } = durationParts(milliseconds);
  if (hours === 0) return t("durationMinutes", { minutes });
  return t("durationHoursMinutes", { hours, minutes });
}

function drawAnimated(drawFrame, duration = 650) {
  if (LOW_MOTION) {
    drawFrame(1);
    return;
  }
  const started = performance.now();
  const frame = (now) => {
    const progress = Math.min(1, (now - started) / duration);
    drawFrame(progress);
    if (progress < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function setupCanvas(canvas) {
  const context = canvas.getContext("2d");
  if (!context) return null;
  const ratio = Math.min(1.5, window.devicePixelRatio || 1);
  canvas.width = Math.floor(canvas.clientWidth * ratio);
  canvas.height = Math.floor(canvas.clientHeight * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return {
    context,
    width: canvas.clientWidth,
    height: canvas.clientHeight,
  };
}

function drawRainChart(hours) {
  const canvas = $("rainChart");
  if (!canvas.clientWidth || !canvas.clientHeight) return;
  const dimensions = setupCanvas(canvas);
  if (!dimensions) {
    $("rainChartSummary").textContent = t("chartUnavailable");
    return;
  }
  const { context, width, height } = dimensions;
  context.clearRect(0, 0, width, height);
  if (!hours.length) {
    context.fillStyle = "#9fb0ff";
    context.fillText(t("noLiveData"), 8, 16);
    return;
  }
  const padding = 32;
  const barWidth = (width - padding * 2) / hours.length;
  const millimetres = hours.map(totalPrecipitationMm);
  const probability = hours.map((hour) => Number(hour.precipitation_probability) || 0);
  const maximum = Math.max(0.8, ...millimetres);

  drawAnimated((progress) => {
    context.clearRect(0, 0, width, height);
    for (let index = 0; index < hours.length; index += 1) {
      const x = padding + index * barWidth;
      const barHeight = millimetres[index] / maximum * (height - padding * 2) * progress;
      context.fillStyle = "#77a8ff";
      context.fillRect(x, height - padding - barHeight, barWidth * 0.6, barHeight);
    }
    context.beginPath();
    probability.forEach((value, index) => {
      const x = padding + index * barWidth + barWidth * 0.3;
      const y = height - padding - value / 100 * (height - padding * 2) * progress;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.strokeStyle = "#f5d061";
    context.lineWidth = 2;
    context.stroke();
    context.fillStyle = "#9fb0ff";
    context.font = "13px system-ui";
    for (let index = 0; index < hours.length; index += 3) {
      context.fillText(hours[index].time.slice(11, 13), padding + index * barWidth - 4, height - 8);
    }
  });

  const wetHours = hours.filter((hour) => totalPrecipitationMm(hour) >= 0.2).length;
  $("rainChartSummary").textContent = t("rainChartSummary", {
    wet: wetHours,
    hours: hours.length,
  });
}

function drawTemperatureWindChart(hours) {
  const canvas = $("tempWindChart");
  if (!canvas.clientWidth || !canvas.clientHeight) return;
  const dimensions = setupCanvas(canvas);
  if (!dimensions) {
    $("tempChartSummary").textContent = t("chartUnavailable");
    return;
  }
  const { context, width, height } = dimensions;
  context.clearRect(0, 0, width, height);
  if (!hours.length) {
    context.fillStyle = "#9fb0ff";
    context.fillText("No live data", 8, 16);
    return;
  }
  const padding = 32;
  const step = (width - padding * 2) / hours.length;
  const temperatures = hours.map((hour) => Number(hour.temperature_2m) || 0);
  const winds = hours.map((hour) => Number(hour.wind_speed_10m) || 0);
  const minimumTemperature = Math.min(...temperatures) - 1;
  const maximumTemperature = Math.max(...temperatures) + 1;
  const maximumWind = Math.max(20, ...winds);
  const temperatureY = (value) => height - padding
    - (value - minimumTemperature) / (maximumTemperature - minimumTemperature) * (height - padding * 2);
  const windY = (value) => height - padding - value / maximumWind * (height - padding * 2);

  drawAnimated((progress) => {
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#9fb0ff55";
    winds.forEach((wind, index) => {
      const x = padding + index * step;
      const y = windY(wind * progress);
      context.fillRect(x, y, step * 0.6, windY(0) - y);
    });
    context.beginPath();
    temperatures.forEach((temperature, index) => {
      const x = padding + index * step + step * 0.3;
      const y = temperatureY(temperature);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.strokeStyle = "#ffd166";
    context.lineWidth = 2;
    context.stroke();
    context.fillStyle = "#9fb0ff";
    context.font = "13px system-ui";
    for (let index = 0; index < hours.length; index += 3) {
      context.fillText(hours[index].time.slice(11, 13), padding + index * step - 4, height - 8);
    }
  });

  const low = Math.round(Math.min(...temperatures));
  const high = Math.round(Math.max(...temperatures));
  $("tempChartSummary").textContent = t("tempChartSummary", {
    low,
    high,
    hours: hours.length,
  });
}

function renderLiveDivergence(records) {
  const notice = $("snapshotDivergence");
  notice.hidden = true;
  if (!lockedSelection) return;
  const currentHours = groupHoursByApiDate(records)[lockedSelection.dateKey] || [];
  const currentLiveVerdict = buildWetPeriods(currentHours).length ? "YES" : "NO";
  if (currentLiveVerdict !== lockedSelection.day.verdict) {
    notice.textContent = t("divergence", {
      live: t(currentLiveVerdict === "YES" ? "yes" : "no"),
      locked: t(lockedSelection.day.verdict === "YES" ? "yes" : "no"),
    });
    notice.hidden = false;
  }
}

function renderCurrentConditions(forecast, records, nowIndex) {
  const current = forecast.current || {};
  const fallback = records[nowIndex] || {};
  const temperature = Number.isFinite(current.temperature_2m)
    ? current.temperature_2m : fallback.temperature_2m;
  const wind = Number.isFinite(current.wind_speed_10m)
    ? current.wind_speed_10m : fallback.wind_speed_10m;
  const cloud = Number.isFinite(current.cloud_cover) ? current.cloud_cover : fallback.cloud_cover;
  const pressure = Number.isFinite(current.pressure_msl) ? current.pressure_msl : fallback.pressure_msl;
  const apparent = Number.isFinite(current.apparent_temperature)
    ? current.apparent_temperature : fallback.apparent_temperature;
  const humidity = Number.isFinite(current.relative_humidity_2m)
    ? current.relative_humidity_2m : fallback.relative_humidity_2m;
  const uvNow = Number.isFinite(current.uv_index) ? current.uv_index : fallback.uv_index;
  const uvMax = forecast.daily?.uv_index_max?.[0];

  $("currentTemp").textContent = Number.isFinite(temperature) ? `${Math.round(temperature)}°` : "—";
  $("currentFeels").textContent = t("feelsLike", {
    value: Number.isFinite(apparent) ? `${Math.round(apparent)}°C` : "—",
  });
  $("currentWind").textContent = Number.isFinite(wind) ? `${Math.round(wind)} km/h` : "—";
  $("currentClouds").textContent = Number.isFinite(cloud) ? `${Math.round(cloud)}%` : "—";
  $("currentPressure").textContent = Number.isFinite(pressure) ? `${Math.round(pressure)} hPa` : "—";
  $("currentHumidity").textContent = Number.isFinite(humidity) ? `${Math.round(humidity)}%` : "—";
  $("currentUv").textContent = Number.isFinite(uvNow) ? uvNow.toFixed(1) : "—";
  $("currentUvMax").textContent = Number.isFinite(uvMax) ? uvMax.toFixed(1) : "—";

  const previousPressure = records[Math.max(0, nowIndex - 3)]?.pressure_msl;
  $("pressureTrend").textContent = "";
  if (Number.isFinite(pressure) && Number.isFinite(previousPressure)) {
    const difference = Math.round(pressure - previousPressure);
    $("pressureTrend").textContent = t("pressureTrend", {
      arrow: difference > 0 ? "▲" : difference < 0 ? "▼" : "→",
      value: difference,
    });
  }
}

function renderNextRain(forecast) {
  const result = getNextRain(forecast.minutely_15, new Date());
  const card = $("nowcastCard");
  card.classList.remove("wet", "dry");

  if (result.state === "unavailable") {
    $("nextRain").textContent = t("nowcastUnavailable");
    $("nextRainDetail").textContent = t("nowcastLiveNote");
    return;
  }

  if (result.state === "raining") {
    card.classList.add("wet");
    $("nextRain").textContent = t("nowcastRaining");
    $("nextRainDetail").textContent = t("nowcastAmount", {
      amount: new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(result.amountMm),
    });
    return;
  }

  if (result.state === "within-hour") {
    card.classList.add("wet");
    $("nextRain").textContent = t("nowcastWithin", { minutes: result.minutes });
    $("nextRainDetail").textContent = t("nowcastAmount", {
      amount: new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(result.amountMm),
    });
    return;
  }

  card.classList.add("dry");
  $("nextRain").textContent = t("nowcastDryHour");
  if (result.state === "later") {
    $("nextRainDetail").textContent = `${t("nowcastLater", {
      time: formatPragueTime(result.startsAt, locale),
    })} ${t("nowcastAmount", {
      amount: new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(result.amountMm),
    })}`;
    return;
  }
  $("nextRainDetail").textContent = t("nowcastDrySixHours");
}

function computeTip(forecast, airQuality, records, nowIndex) {
  const pressure = records[nowIndex]?.pressure_msl;
  const earlierPressure = records[Math.max(0, nowIndex - 3)]?.pressure_msl;
  const pressureDifference = Number.isFinite(pressure) && Number.isFinite(earlierPressure)
    ? pressure - earlierPressure : null;
  const uvMax = forecast.daily?.uv_index_max?.[0];
  const gust = records[nowIndex]?.wind_gusts_10m;
  const currentRain = totalPrecipitationMm(records[nowIndex] || {});
  const aqi = airQuality?.current?.european_aqi;
  if (Number.isFinite(aqi) && aqi > 60) {
    return t("tipPoorAir", { aqi: Math.round(aqi) });
  }
  if (Number.isFinite(gust) && gust >= 60) {
    return t("tipStrongWind", { gust: Math.round(gust) });
  }
  if (Number.isFinite(pressureDifference) && pressureDifference <= -3) {
    return t("tipPressureDrop", { drop: Math.round(-pressureDifference) });
  }
  if (Number.isFinite(uvMax) && uvMax >= 6) {
    return t("tipHighUv", { uv: uvMax.toFixed(1) });
  }
  if (currentRain >= 0.2) return t("tipRainNow");
  return t("tipQuiet");
}

function renderSevenDayForecast(forecast) {
  const daily = forecast.daily || {};
  const strip = $("daysStrip");
  strip.replaceChildren();
  const count = Math.min(7, daily.time?.length || 0);
  for (let index = 0; index < count; index += 1) {
    const [icon, label] = weatherIcon(daily.weather_code[index]);
    const card = document.createElement("div");
    card.className = "day";
    const day = document.createElement("div");
    day.className = "sub";
    day.textContent = formatPragueDay(daily.time[index], locale);
    const weather = document.createElement("div");
    weather.className = "weather-icon";
    weather.textContent = icon;
    const description = document.createElement("div");
    description.textContent = label;
    const temperature = document.createElement("div");
    temperature.className = "temperature";
    const high = daily.temperature_2m_max?.[index];
    const low = daily.temperature_2m_min?.[index];
    temperature.textContent = `${Number.isFinite(high) ? Math.round(high) : "—"}° / ${Number.isFinite(low) ? Math.round(low) : "—"}°`;
    const probability = document.createElement("div");
    probability.className = "sub";
    const pop = daily.precipitation_probability_max?.[index];
    probability.textContent = t("precipitationProbabilityShort", {
      value: Number.isFinite(pop) ? `${Math.round(pop)}%` : "—",
    });
    card.append(day, weather, description, temperature, probability);
    strip.append(card);
  }
}

function renderAirQuality(airQuality, fetchedAt) {
  if (airQuality?.timezone !== CITY.timezone) {
    throw new TypeError(`Air-quality timezone was ${airQuality?.timezone || "missing"}`);
  }
  const current = airQuality.current || {};
  let data = current;
  if (!Number.isFinite(current.european_aqi) && airQuality.hourly?.time) {
    const index = findCurrentHourIndex(airQuality.hourly.time);
    data = Object.fromEntries(
      Object.entries(airQuality.hourly)
        .filter(([field]) => field !== "time")
        .map(([field, values]) => [field, values?.[index]]),
    );
  }
  const classification = airQualityClass(data.european_aqi);
  $("aqValue").textContent = formattedNumber(data.european_aqi);
  $("aqBadge").textContent = classification.name;
  $("aqBadge").className = `badge ${classification.className}`;
  $("aqAdvice").textContent = classification.advice;
  $("pm25Value").textContent = Number.isFinite(data.pm2_5)
    ? `${formattedNumber(data.pm2_5, 1)} µg/m³` : "—";
  $("pm10Value").textContent = Number.isFinite(data.pm10)
    ? `${formattedNumber(data.pm10, 1)} µg/m³` : "—";
  $("ozoneValue").textContent = Number.isFinite(data.ozone)
    ? `${formattedNumber(data.ozone, 1)} µg/m³` : "—";
  $("no2Value").textContent = Number.isFinite(data.nitrogen_dioxide)
    ? `${formattedNumber(data.nitrogen_dioxide, 1)} µg/m³` : "—";

  const pollen = [
    [t("pollenAlder"), data.alder_pollen],
    [t("pollenBirch"), data.birch_pollen],
    [t("pollenGrass"), data.grass_pollen],
    [t("pollenRagweed"), data.ragweed_pollen],
  ];
  const pollenGrid = $("pollenGrid");
  pollenGrid.replaceChildren();
  for (const [name, value] of pollen) {
    const item = document.createElement("div");
    item.className = "pollen-item";
    const label = document.createElement("span");
    label.className = "sub tiny";
    label.textContent = name;
    const amount = document.createElement("strong");
    amount.textContent = Number.isFinite(value) ? formattedNumber(value, 1) : "—";
    item.append(label, amount);
    pollenGrid.append(item);
  }
  $("aqStatus").textContent = t("airFetched", { time: formatFetchedTime(fetchedAt) });
}

async function renderSunAndMoon(forecast, sunCalcPromise) {
  const dateKey = getPragueDateKey(new Date());
  const dailyIndex = forecast.daily?.time?.indexOf(dateKey) ?? -1;
  const now = new Date();
  if (dailyIndex >= 0) {
    const sunriseValue = forecast.daily.sunrise?.[dailyIndex];
    const sunsetValue = forecast.daily.sunset?.[dailyIndex];
    $("sunriseTime").textContent = formatPragueTime(sunriseValue, locale);
    $("sunsetTime").textContent = formatPragueTime(sunsetValue, locale);

    try {
      const sunrise = apiTimestampToPragueInstant(sunriseValue);
      const sunset = apiTimestampToPragueInstant(sunsetValue);
      const daylightMs = sunset.getTime() - sunrise.getTime();
      const progress = Math.max(0, Math.min(1, (now.getTime() - sunrise.getTime()) / daylightMs));
      $("daylightProgress").style.width = `${Math.round(progress * 100)}%`;
      const daylight = durationText(daylightMs);
      if (now < sunrise) {
        $("sunStatus").textContent = t("sunriseIn", {
          duration: durationText(sunrise.getTime() - now.getTime()),
          daylight,
        });
      } else if (now < sunset) {
        $("sunStatus").textContent = t("sunsetIn", {
          duration: durationText(sunset.getTime() - now.getTime()),
          daylight,
        });
      } else {
        $("sunStatus").textContent = t("sunBelowHorizon", { daylight });
      }
    } catch {
      $("sunStatus").textContent = t("sunriseSunset", {
        sunrise: formatPragueTime(sunriseValue, locale),
        sunset: formatPragueTime(sunsetValue, locale),
      });
    }
  } else {
    $("sunriseTime").textContent = "—";
    $("sunsetTime").textContent = "—";
    $("daylightProgress").style.width = "0";
    $("sunStatus").textContent = t("sunUnavailable");
  }

  try {
    const SunCalc = await sunCalcPromise;
    const date = pragueLocalDateToInstant(dateKey, 12, 0);
    const moonTimes = SunCalc.getMoonTimes(date, CITY.latitude, CITY.longitude);
    const illumination = SunCalc.getMoonIllumination(date);
    $("moonGlyph").textContent = moonPhaseGlyph(illumination.phase);
    $("moonPhase").textContent = t("moonDetails", {
      phase: moonPhaseName(illumination.phase),
      fraction: Math.round(illumination.fraction * 100),
    });
    $("moonriseTime").textContent = moonTimes.rise ? formatPragueTime(moonTimes.rise, locale) : "—";
    $("moonsetTime").textContent = moonTimes.set ? formatPragueTime(moonTimes.set, locale) : "—";
    $("moonStatus").textContent = t("moonTimesLocal");
  } catch {
    $("moonPhase").textContent = t("moonUnavailable");
    $("moonriseTime").textContent = "—";
    $("moonsetTime").textContent = "—";
    $("moonStatus").textContent = "";
  }
}

function paintLive(forecast, airQuality, {
  forecastFetchedAt,
  airQualityFetchedAt,
  cached = false,
  sunCalcPromise,
}) {
  const records = validateLiveForecast(forecast);
  const nowIndex = findCurrentHourIndex(forecast.hourly.time);
  lastHours24 = records.slice(nowIndex, nowIndex + 24);
  drawRainChart(lastHours24);
  drawTemperatureWindChart(lastHours24);
  renderNextRain(forecast);
  renderCurrentConditions(forecast, records, nowIndex);
  renderSevenDayForecast(forecast);
  renderAirQuality(airQuality, airQualityFetchedAt);
  renderSunAndMoon(forecast, sunCalcPromise);
  renderLiveDivergence(records);
  $("dailyTip").textContent = computeTip(forecast, airQuality, records, nowIndex);
  $("asof").textContent = `${t(cached ? "cachedLive" : "liveFetched")} ${formatFetchedTime(forecastFetchedAt)} · v${APP_VERSION}`;
}

async function loadLiveData(sunCalcPromise) {
  const cached = safeReadCache(LIVE_CACHE_KEY);
  const cachedAge = cached?.forecastFetchedAt
    ? Date.now() - Date.parse(cached.forecastFetchedAt) : Number.POSITIVE_INFINITY;
  let paintedCache = false;
  if (cached?.forecast && cached?.airQuality && cachedAge <= LIVE_CACHE_MAX_AGE) {
    try {
      paintLive(cached.forecast, cached.airQuality, {
        ...cached,
        cached: true,
        sunCalcPromise,
      });
      paintedCache = true;
    } catch {
      // Invalid v2 cache is ignored.
    }
  }

  try {
    const [forecast, airQuality] = await Promise.all([
      fetchJsonWithRetry(forecastUrl()),
      fetchJsonWithRetry(airQualityUrl()),
    ]);
    validateLiveForecast(forecast);
    const now = new Date().toISOString();
    const value = {
      forecast,
      airQuality,
      forecastFetchedAt: now,
      airQualityFetchedAt: now,
    };
    safeWriteCache(LIVE_CACHE_KEY, value);
    paintLive(forecast, airQuality, {
      ...value,
      cached: false,
      sunCalcPromise,
    });
  } catch (error) {
    if (paintedCache) {
      $("asof").textContent = t("liveRefreshFailed", {
        time: formatFetchedTime(cached.forecastFetchedAt),
        version: APP_VERSION,
      });
    } else {
      $("asof").textContent = t("liveUnavailable", { version: APP_VERSION });
      $("nextRain").textContent = t("nowcastUnavailable");
      $("rainChartSummary").textContent = t("rainDataUnavailable");
      $("tempChartSummary").textContent = t("tempDataUnavailable");
      $("aqStatus").textContent = t("airDataUnavailable");
      $("dailyTip").textContent = t("tipUnavailable", { error: error.message });
    }
  }
}

function setAlertBanner(text, level) {
  const presentation = level === "gray"
    ? {
      className: "banner gray",
      glowColor: "transparent",
      glowAlpha: "0%",
    }
    : alertPresentation(level);
  $("alertBar").className = presentation.className;
  $("alertText").textContent = text;
  document.documentElement.style.setProperty("--glow", presentation.glowColor);
  document.documentElement.style.setProperty("--glow-alpha", presentation.glowAlpha);
}

async function loadAlerts() {
  try {
    const response = await fetchJsonWithRetry(
      `${PROXY_BASE}/meteoalarm-cz?region=olomoucky`,
      { attempts: 2, timeoutMs: 8_000 },
    );
    const regionalItems = filterOlomoucRegionAlerts(response.items);
    const { activeItems, severity } = selectActiveAlerts(regionalItems, new Date());
    delete $("alertBar").dataset.fallbackLink;
    if (!activeItems.length) {
      setAlertBanner(t("noActiveAlerts"), "green");
      $("alertsPanel").hidden = true;
      return;
    }

    const headline = activeItems.find((item) => normalizeSeverity(item.level) === severity);
    setAlertBanner(headline?.title || t("activeAlertFallback"), severity);
    const panel = $("alertsPanel");
    const list = $("alertsList");
    panel.hidden = false;
    panel.classList.add("reveal");
    list.replaceChildren();
    const level = document.createElement("span");
    level.className = `level ${severity}`;
    level.textContent = severity.toUpperCase();
    $("alertsSummary").replaceChildren(
      document.createTextNode(t("activeRegionalLevel")),
      level,
      document.createTextNode(t("alertItems", { count: activeItems.length })),
    );
    for (const item of activeItems.slice(0, 6)) {
      const row = document.createElement("li");
      const badge = document.createElement("span");
      const itemLevel = String(item.level || "yellow").toLowerCase();
      badge.className = `level ${["green", "yellow", "orange", "red"].includes(itemLevel) ? itemLevel : "yellow"}`;
      badge.textContent = itemLevel.toUpperCase();
      const expiry = item.expires
        ? new Intl.DateTimeFormat(locale, {
          timeZone: CITY.timezone,
          day: "2-digit",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date(item.expires))
        : "unknown";
      row.append(
        document.createTextNode(`${item.title || t("alertFallbackTitle")} `),
        badge,
        document.createTextNode(t("alertUntil", { time: expiry })),
      );
      list.append(row);
    }
  } catch {
    setAlertBanner(t("alertsUnavailable"), "gray");
    $("alertBar").dataset.fallbackLink = "true";
  }
}

function setupInteractions() {
  const mobileQuery = window.matchMedia("(max-width: 600px)");
  const collapsibleDetails = [...document.querySelectorAll("details[data-mobile-collapse]")];
  if (mobileQuery.matches) {
    collapsibleDetails.forEach((details) => details.removeAttribute("open"));
  }
  collapsibleDetails.forEach((details) => {
    details.querySelector("summary")?.setAttribute("title", t("detailsToggleHint"));
    details.addEventListener("toggle", () => {
      if (details.open && lastHours24) {
        requestAnimationFrame(() => {
          drawRainChart(lastHours24);
          drawTemperatureWindChart(lastHours24);
        });
      }
    });
  });

  const observer = "IntersectionObserver" in window
    ? new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("reveal");
          observer.unobserve(entry.target);
        }
      }
    }, { threshold: 0.12 })
    : null;
  document.querySelectorAll(".card").forEach((card) => {
    if (observer) observer.observe(card);
    else card.classList.add("reveal");
  });

  $("alertBar").addEventListener("click", () => {
    if ($("alertBar").dataset.fallbackLink) {
      window.open("https://www.meteoalarm.org/en/live/", "_blank", "noopener");
      return;
    }
    const expanded = $("alertBar").classList.toggle("expand");
    $("alertBar").setAttribute("aria-expanded", String(expanded));
  });

  $("languageBtn").addEventListener("click", () => {
    const nextLanguage = language === "cs" ? "en" : "cs";
    safeWriteCache(LANGUAGE_STORAGE_KEY, nextLanguage);
    location.reload();
  });

  $("shareBtn").addEventListener("click", async () => {
    const answer = $("rainToday").textContent.trim();
    const text = t("shareText", {
      answer,
      reason: $("reasonToday").textContent.trim(),
    });
    const shareData = { title: t("pageTitle"), text, url: location.href };
    if (navigator.share) {
      try { await navigator.share(shareData); } catch { /* User cancellation. */ }
      return;
    }
    try {
      await navigator.clipboard.writeText(`${text} — ${location.href}`);
      $("shareBtn").textContent = t("copied");
      setTimeout(() => { $("shareBtn").textContent = t("share"); }, 1200);
    } catch {
      $("shareBtn").textContent = t("copyFailed");
    }
  });

  $("radarOpenLink").href = RADAR_URL;
  let radarShown = false;
  $("radarToggle").addEventListener("click", () => {
    const slot = $("radarSlot");
    if (!radarShown) {
      const iframe = document.createElement("iframe");
      iframe.className = "radar";
      iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
      iframe.setAttribute("referrerpolicy", "no-referrer");
      iframe.loading = "lazy";
      iframe.title = t("radarFrameTitle");
      iframe.src = RADAR_URL;
      slot.append(iframe);
      $("radarToggle").textContent = t("hideRadar");
      radarShown = true;
    } else {
      slot.replaceChildren();
      $("radarToggle").textContent = t("showRadar");
      radarShown = false;
    }
  });

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (lastHours24) {
        drawRainChart(lastHours24);
        drawTemperatureWindChart(lastHours24);
      }
    }, 120);
  });
}

async function init() {
  applyStaticTranslations();
  setupInteractions();
  const sunCalcPromise = waitForSunCalc($("suncalcScript"), window);
  sunCalcPromise.catch(() => {});
  await Promise.allSettled([
    loadSnapshot(),
    loadLiveData(sunCalcPromise),
    loadAlerts(),
  ]);
}

init();
