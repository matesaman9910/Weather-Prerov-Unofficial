import {
  CITY,
  addDateKey,
  alertPresentation,
  buildWetPeriods,
  formatPragueDay,
  formatPragueTime,
  filterOlomoucRegionAlerts,
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
import { waitForSunCalc } from "./suncalc-loader.mjs";

const APP_VERSION = "2.0.0";
const LOCALE = navigator.language || "cs-CZ";
const LIVE_CACHE_KEY = "prerov-weather-live-v2";
const SNAPSHOT_CACHE_KEY = "prerov-weather-snapshot-v1";
const LIVE_CACHE_MAX_AGE = 6 * 60 * 60 * 1000;
const PROXY_BASE = "https://weatherwebsiteprerov.matejkratochvilbilina.workers.dev";
const RADAR_URL = `https://radar.bourky.cz/index.php?img_to_load=10&lat=${CITY.latitude.toFixed(5)}&lon=${CITY.longitude.toFixed(5)}&zoom=10&map_id=1&anim=1&repeat=0&last=0&l_type=0&l_res=0&fcst=1&prod=0&r_opa=25&l_opa=16&b_opa=100&menu_weather=0&menu_weathergraphs=0&menu_webcam=0&menu_cells=0&menu_blitzortung=0&menu_sivs=0&menu_estofex=0&menu_metar=0&menu_planes=0&menu_hydro=0&menu_aero=0&menu_radars=0&menu_wind=0&menu_airquality=0&menu_chasers=0&menu_daynight=1&synop_selected=T&gps=false`;
const LOW_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches
  || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4);

const $ = (id) => document.getElementById(id);
let currentSnapshot = null;
let lockedSelection = null;
let lastHours24 = null;
let latestForecast = null;

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

function formatFetchedTime(value) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? formatPragueTime(parsed, LOCALE) : "—";
}

function setAnswer(node, text, level = "pending") {
  node.textContent = text;
  node.className = `answer ${level}`;
}

function renderUnavailableDaily(reason = "Daily snapshot unavailable") {
  lockedSelection = null;
  setAnswer($("rainToday"), "PENDING", "pending");
  $("reasonToday").textContent = `${reason}. No live forecast was substituted.`;
  $("highlightsToday").textContent = "Waiting for a published entry for today in Europe/Prague.";
  setAnswer($("rainTomorrow"), "PENDING", "pending");
  $("reasonTomorrow").textContent = "Tomorrow is not available in the published snapshot.";
  $("highlightsTomorrow").textContent = "—";
}

function periodSummary(period) {
  return `Starts ~ ${formatPragueTime(period.start, LOCALE)} · Peak ~ ${formatPragueTime(period.peakTime, LOCALE)} — ${Math.round(period.peakProbabilityPercent)}% · ${period.peakPrecipitationMm.toFixed(1)} mm/h · Ends ~ ${formatPragueTime(period.end, LOCALE)}`;
}

function periodHighlights(periods) {
  return periods.slice(0, 3)
    .map((period) => `${formatPragueTime(period.start, LOCALE)}–${formatPragueTime(period.end, LOCALE)}`)
    .join(" · ");
}

function renderSnapshotDay(day, answerNode, reasonNode, highlightsNode, isToday) {
  const yes = day.verdict === "YES";
  setAnswer(answerNode, day.verdict, yes ? (isToday ? "bad" : "warn") : "ok");
  if (yes) {
    reasonNode.textContent = periodSummary(day.wetPeriods[0]);
    highlightsNode.textContent = periodHighlights(day.wetPeriods);
  } else {
    reasonNode.textContent = isToday
      ? "No significant precipitation met the locked daily thresholds."
      : "No significant precipitation met the published thresholds.";
    highlightsNode.textContent = isToday ? "All published hours look dry." : "—";
  }
}

function renderSnapshot(snapshot) {
  validateSnapshot(snapshot);
  const selection = selectSnapshotDay(snapshot, new Date());
  if (selection.status !== "available") {
    renderUnavailableDaily("No entry exists for the current Prague date");
    $("snapshotStatus").textContent = `Snapshot loaded, but ${selection.dateKey} is not published yet.`;
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
    setAnswer($("rainTomorrow"), "PENDING", "pending");
    $("reasonTomorrow").textContent = `No published entry for ${tomorrowKey}.`;
    $("highlightsTomorrow").textContent = "—";
  }

  const generated = new Intl.DateTimeFormat(LOCALE, {
    timeZone: CITY.timezone,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(snapshot.generatedAt));
  $("snapshotStatus").textContent = selection.stale
    ? `Snapshot stale — current-date fallback published in an older snapshot (${generated}, Europe/Prague).`
    : `Daily answer locked from the ${generated} Europe/Prague snapshot.`;
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
          $("snapshotStatus").textContent += " Download failed; using the cached shared snapshot.";
          return;
        }
      } catch {
        // Fall through to the explicit unavailable state.
      }
    }
    renderUnavailableDaily("Shared daily snapshot unavailable");
    $("snapshotStatus").textContent = `Daily snapshot unavailable (${networkError.message}).`;
  }
}

function forecastUrl() {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude: String(CITY.latitude),
    longitude: String(CITY.longitude),
    timezone: CITY.timezone,
    forecast_days: "7",
    hourly: [
      "precipitation_probability",
      "precipitation",
      "rain",
      "showers",
      "temperature_2m",
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
      "ozone",
      "european_aqi",
      "alder_pollen",
      "birch_pollen",
      "grass_pollen",
      "ragweed_pollen",
    ].join(","),
    current: [
      "pm2_5",
      "ozone",
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

function feelsLikeC(temperature, windKmh, relativeHumidity) {
  const wind = Number(windKmh) || 0;
  const humidity = Number(relativeHumidity) || 50;
  const windMs = wind / 3.6;
  const windChill = 13.12 + 0.6215 * temperature
    - 11.37 * windMs ** 0.16 + 0.3965 * temperature * windMs ** 0.16;
  const fahrenheit = temperature * 9 / 5 + 32;
  const heatIndexF = -42.379 + 2.04901523 * fahrenheit + 10.14333127 * humidity
    - 0.22475541 * fahrenheit * humidity - 0.00683783 * fahrenheit ** 2
    - 0.05481717 * humidity ** 2 + 0.00122874 * fahrenheit ** 2 * humidity
    + 0.00085282 * fahrenheit * humidity ** 2
    - 0.00000199 * fahrenheit ** 2 * humidity ** 2;
  if (temperature <= 10 && wind >= 4.8) return Math.round(windChill);
  if (temperature >= 27) return Math.round((heatIndexF - 32) * 5 / 9);
  return Math.round(temperature);
}

function weatherIcon(code) {
  const numeric = Number(code);
  if (numeric === 0) return ["☀️", "Clear"];
  if ([1, 2].includes(numeric)) return ["🌤️", "Partly cloudy"];
  if (numeric === 3) return ["☁️", "Cloudy"];
  if ([45, 48].includes(numeric)) return ["🌫️", "Fog"];
  if ([51, 53, 55, 56, 57].includes(numeric)) return ["🌦️", "Drizzle"];
  if ([61, 63, 65, 66, 67].includes(numeric)) return ["🌧️", "Rain"];
  if ([71, 73, 75, 77, 85, 86].includes(numeric)) return ["🌨️", "Snow"];
  if ([80, 81, 82].includes(numeric)) return ["🌦️", "Showers"];
  if ([95, 96, 99].includes(numeric)) return ["⛈️", "Thunderstorm"];
  return ["❓", "Unknown"];
}

function moonPhaseName(phase) {
  if (phase < 0.03 || phase > 0.97) return "New Moon";
  if (phase < 0.22) return "Waxing crescent";
  if (phase < 0.28) return "First quarter";
  if (phase < 0.47) return "Waxing gibbous";
  if (phase < 0.53) return "Full Moon";
  if (phase < 0.72) return "Waning gibbous";
  if (phase < 0.78) return "Last quarter";
  return "Waning crescent";
}

function airQualityClass(value) {
  if (!Number.isFinite(value)) return { name: "—", className: "" };
  if (value > 100) return { name: "Extremely poor", className: "b-poor" };
  if (value > 80) return { name: "Very poor", className: "b-poor" };
  if (value > 60) return { name: "Poor", className: "b-poor" };
  if (value > 40) return { name: "Moderate", className: "b-mod" };
  if (value > 20) return { name: "Fair", className: "b-fair" };
  return { name: "Good", className: "b-good" };
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
  const dimensions = setupCanvas(canvas);
  if (!dimensions) {
    $("rainChartSummary").textContent = "Chart unavailable in this browser.";
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
  $("rainChartSummary").textContent = `Latest forecast details · ${wetHours} of the next ${hours.length} hours have at least 0.2 mm total precipitation.`;
}

function drawTemperatureWindChart(hours) {
  const canvas = $("tempWindChart");
  const dimensions = setupCanvas(canvas);
  if (!dimensions) {
    $("tempChartSummary").textContent = "Chart unavailable in this browser.";
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
  $("tempChartSummary").textContent = `Latest forecast details · ${low}–${high}°C over the next ${hours.length} hours.`;
}

function renderLiveDivergence(records) {
  const notice = $("snapshotDivergence");
  notice.hidden = true;
  if (!lockedSelection) return;
  const currentHours = groupHoursByApiDate(records)[lockedSelection.dateKey] || [];
  const currentLiveVerdict = buildWetPeriods(currentHours).length ? "YES" : "NO";
  if (currentLiveVerdict !== lockedSelection.day.verdict) {
    notice.textContent = `The latest live forecast now suggests ${currentLiveVerdict}, but the published daily answer remains locked at ${lockedSelection.day.verdict}.`;
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
  const humidity = Number.isFinite(current.relative_humidity_2m)
    ? current.relative_humidity_2m : fallback.relative_humidity_2m;
  const cloud = Number.isFinite(current.cloud_cover) ? current.cloud_cover : fallback.cloud_cover;
  const pressure = Number.isFinite(current.pressure_msl) ? current.pressure_msl : fallback.pressure_msl;
  const apparent = Number.isFinite(temperature)
    ? feelsLikeC(temperature, wind, humidity) : null;

  $("nowLine").textContent = `Now: ${Number.isFinite(temperature) ? `${Math.round(temperature)}°C` : "—"} (feels ${apparent ?? "—"}°C), wind ${Number.isFinite(wind) ? `${Math.round(wind)} km/h` : "—"}, clouds ${Number.isFinite(cloud) ? `${Math.round(cloud)}%` : "—"}, pressure ${Number.isFinite(pressure) ? `${Math.round(pressure)} hPa` : "—"}`;

  const chips = $("uvChips");
  chips.replaceChildren();
  const values = [
    `UV now ${Number.isFinite(current.uv_index) ? current.uv_index.toFixed(1) : "—"}`,
    `UV max ${Number.isFinite(forecast.daily?.uv_index_max?.[0]) ? forecast.daily.uv_index_max[0].toFixed(1) : "—"}`,
  ];
  const previousPressure = records[Math.max(0, nowIndex - 3)]?.pressure_msl;
  if (Number.isFinite(pressure) && Number.isFinite(previousPressure)) {
    const difference = Math.round(pressure - previousPressure);
    values.push(`Pressure ${difference > 0 ? "▲" : difference < 0 ? "▼" : "→"} ${difference} hPa/3h`);
  }
  for (const value of values) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = value;
    chips.append(chip);
  }
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
    return `Tip: Air quality is ${Math.round(aqi)} (poor). Sensitive people should limit outdoor exertion.`;
  }
  if (Number.isFinite(gust) && gust >= 60) {
    return `Tip: Strong gusts around ${Math.round(gust)} km/h. Secure loose items and take care on bikes.`;
  }
  if (Number.isFinite(pressureDifference) && pressureDifference <= -3) {
    return `Tip: Pressure fell about ${Math.round(-pressureDifference)} hPa in three hours.`;
  }
  if (Number.isFinite(uvMax) && uvMax >= 6) {
    return `Tip: High UV today (maximum ${uvMax.toFixed(1)}). Use sun protection around midday.`;
  }
  if (currentRain >= 0.2) return "Tip: Rain is ongoing; roads may be slippery.";
  return "Tip: No strong signal from AQI, wind, UV, pressure, or current precipitation.";
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
    day.textContent = formatPragueDay(daily.time[index], LOCALE);
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
    probability.textContent = `PoP ${Number.isFinite(pop) ? `${Math.round(pop)}%` : "—"}`;
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
  $("aqBadge").textContent = `${classification.name}${Number.isFinite(data.european_aqi) ? ` (${Math.round(data.european_aqi)})` : ""}`;
  $("aqBadge").className = `badge ${classification.className}`;
  $("aqLine").textContent = `PM₂.₅ ${Number.isFinite(data.pm2_5) ? `${Math.round(data.pm2_5)} µg/m³` : "—"} · O₃ ${Number.isFinite(data.ozone) ? `${Math.round(data.ozone)} µg/m³` : "—"}`;
  const pollen = [
    ["Alder", data.alder_pollen],
    ["Birch", data.birch_pollen],
    ["Grass", data.grass_pollen],
    ["Ragweed", data.ragweed_pollen],
  ].filter(([, value]) => Number.isFinite(value))
    .map(([name, value]) => `${name} ${Math.round(value)}`);
  $("pollenLine").textContent = pollen.length ? pollen.join(" · ") : "Pollen: —";
  $("aqStatus").textContent = `Air quality fetched ${formatFetchedTime(fetchedAt)} Europe/Prague.`;
}

async function renderSunAndMoon(forecast, sunCalcPromise) {
  const dateKey = getPragueDateKey(new Date());
  const dailyIndex = forecast.daily?.time?.indexOf(dateKey) ?? -1;
  if (dailyIndex >= 0) {
    $("sunLine").textContent = `Sunrise ${formatPragueTime(forecast.daily.sunrise?.[dailyIndex], LOCALE)} · Sunset ${formatPragueTime(forecast.daily.sunset?.[dailyIndex], LOCALE)}`;
  } else {
    $("sunLine").textContent = "Sun data unavailable for the current Prague date.";
  }

  try {
    const SunCalc = await sunCalcPromise;
    const date = pragueLocalDateToInstant(dateKey, 12, 0);
    const moonTimes = SunCalc.getMoonTimes(date, CITY.latitude, CITY.longitude);
    const illumination = SunCalc.getMoonIllumination(date);
    let text = `${moonPhaseName(illumination.phase)}: ${Math.round(illumination.fraction * 100)}% lit`;
    if (moonTimes.rise) text += ` · Rise ${formatPragueTime(moonTimes.rise, LOCALE)}`;
    if (moonTimes.set) text += ` · Set ${formatPragueTime(moonTimes.set, LOCALE)}`;
    $("moonLine").textContent = text;
  } catch {
    $("moonLine").textContent = "Sun/moon dependency unavailable.";
  }
}

function paintLive(forecast, airQuality, {
  forecastFetchedAt,
  airQualityFetchedAt,
  cached = false,
  sunCalcPromise,
}) {
  const records = validateLiveForecast(forecast);
  latestForecast = forecast;
  const nowIndex = findCurrentHourIndex(forecast.hourly.time);
  lastHours24 = records.slice(nowIndex, nowIndex + 24);
  drawRainChart(lastHours24);
  drawTemperatureWindChart(lastHours24);
  renderCurrentConditions(forecast, records, nowIndex);
  renderSevenDayForecast(forecast);
  renderAirQuality(airQuality, airQualityFetchedAt);
  renderSunAndMoon(forecast, sunCalcPromise);
  renderLiveDivergence(records);
  $("dailyTip").textContent = computeTip(forecast, airQuality, records, nowIndex);
  $("asof").textContent = `${cached ? "Cached live data" : "Live forecast fetched"} ${formatFetchedTime(forecastFetchedAt)} · v${APP_VERSION}`;
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
      $("asof").textContent = `Live refresh failed — showing forecast from ${formatFetchedTime(cached.forecastFetchedAt)} · v${APP_VERSION}`;
    } else {
      $("asof").textContent = `Live details unavailable · v${APP_VERSION}`;
      $("rainChartSummary").textContent = "Live precipitation data unavailable.";
      $("tempChartSummary").textContent = "Live temperature and wind data unavailable.";
      $("aqStatus").textContent = "Air-quality refresh failed and no usable cache exists.";
      $("dailyTip").textContent = `Tip unavailable: ${error.message}`;
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
    if (!activeItems.length) {
      setAlertBanner("No active alerts for the Olomouc Region", "green");
      $("alertsPanel").hidden = true;
      return;
    }

    const headline = activeItems.find((item) => normalizeSeverity(item.level) === severity);
    setAlertBanner(headline?.title || "Active regional weather alert", severity);
    const panel = $("alertsPanel");
    const list = $("alertsList");
    panel.hidden = false;
    panel.classList.add("reveal");
    list.replaceChildren();
    const level = document.createElement("span");
    level.className = `level ${severity}`;
    level.textContent = severity.toUpperCase();
    $("alertsSummary").replaceChildren(
      document.createTextNode("Active regional level: "),
      level,
      document.createTextNode(` · ${activeItems.length} item(s)`),
    );
    for (const item of activeItems.slice(0, 6)) {
      const row = document.createElement("li");
      const badge = document.createElement("span");
      const itemLevel = String(item.level || "yellow").toLowerCase();
      badge.className = `level ${["green", "yellow", "orange", "red"].includes(itemLevel) ? itemLevel : "yellow"}`;
      badge.textContent = itemLevel.toUpperCase();
      const expiry = item.expires
        ? new Intl.DateTimeFormat(LOCALE, {
          timeZone: CITY.timezone,
          day: "2-digit",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date(item.expires))
        : "unknown";
      row.append(
        document.createTextNode(`${item.title || "Alert"} `),
        badge,
        document.createTextNode(` until ${expiry}`),
      );
      list.append(row);
    }
  } catch {
    setAlertBanner("Alerts unavailable — tap to open Meteoalarm", "gray");
    $("alertBar").dataset.fallbackLink = "true";
  }
}

function setupInteractions() {
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
      window.open("https://www.meteoalarm.org/en/region/CZ", "_blank", "noopener");
      return;
    }
    const expanded = $("alertBar").classList.toggle("expand");
    $("alertBar").setAttribute("aria-expanded", String(expanded));
  });

  $("shareBtn").addEventListener("click", async () => {
    const answer = $("rainToday").textContent.trim();
    const text = `Přerov weather: locked rain answer for today is ${answer}. ${$("reasonToday").textContent.trim()}`;
    const shareData = { title: "Přerov Weather", text, url: location.href };
    if (navigator.share) {
      try { await navigator.share(shareData); } catch { /* User cancellation. */ }
      return;
    }
    try {
      await navigator.clipboard.writeText(`${text} — ${location.href}`);
      $("shareBtn").textContent = "Copied!";
      setTimeout(() => { $("shareBtn").textContent = "Share"; }, 1200);
    } catch {
      $("shareBtn").textContent = "Copy failed";
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
      iframe.title = "Live Czech weather radar centered on Přerov";
      iframe.src = RADAR_URL;
      slot.append(iframe);
      $("radarToggle").textContent = "Hide live radar";
      radarShown = true;
    } else {
      slot.replaceChildren();
      $("radarToggle").textContent = "Show live radar";
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
