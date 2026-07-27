# Přerov Weather — Rain-First

A mobile-first, unofficial weather dashboard for Přerov, Czechia. The main question—“Will it rain today?”—comes from one shared, dated snapshot. Current conditions, charts, air quality, pollen, alerts, radar, and the seven-day forecast continue to update live.

Live site: [matesaman9910.github.io/Weather-Prerov-Unofficial](https://matesaman9910.github.io/Weather-Prerov-Unofficial/)

## Version 2.5

- Version 2.5.1 makes increased rain risk a red pulsing alert and adds bilingual, localhost-only QA scenarios for both forecast-change directions.
- Makes today’s card unambiguous: one large stable YES/NO answer, followed by a live “no meaningful change,” “rain risk increased,” or “rain risk decreased” update.
- Adds plain-language guidance and keeps the peak rain chance visible without presenting a competing second answer.
- Labels today’s result as stable and tomorrow’s as live so visitors can immediately understand which answer can change.

## Version 2.4

- Version 2.4.1 fixes the snapshot/live loading race so a visible locked answer can never be paired with “locked answer unavailable.”
- Keeps today’s YES/NO answer locked while showing whether the latest forecast still agrees and the latest maximum precipitation probability.
- Makes tomorrow’s YES/NO answer live, so it can change as Open-Meteo refreshes before tomorrow begins.

## Version 2.3

- Version 2.3 adds labeled chart scales, improves paired-card sizing, and keeps detail cards fixed open on desktop while preserving mobile collapse.

## Version 2.2

- Version 2.2.1 shows the radar immediately and adds visible colour-matched legends to both hourly charts.
- Moves current conditions and Sun/Moon timing directly below the rain-first answer.
- Reworks current conditions into labeled, glanceable temperature, wind, cloud, pressure, humidity, and UV values.
- Adds daylight duration and time-to-sunrise/sunset, plus clearly separated Moon phase, illumination, moonrise, and moonset.
- Expands air quality with European AQI guidance, PM₂.₅, PM₁₀, ozone, nitrogen dioxide, and readable pollen values.
- Simplifies the visual language with quieter surfaces, restrained colour, fewer decorative icons, and better mobile hierarchy.

## Version 2.1

- Adds a separate live “next rain” card based on Open-Meteo’s 15-minute precipitation forecast for Central Europe.
- Uses Open-Meteo’s `apparent_temperature` instead of a browser-side feels-like approximation.
- Provides persistent Czech and English UI modes.
- Collapses secondary charts and detail cards by default on mobile while keeping the daily rain answer, next-rain status, warnings, and current conditions immediately visible.
- Keeps the radar embedded and lazy-loaded on demand.
- Adds the audited Meteoalarm Worker source and tests. The Worker now filters `areaDesc` and `EMMA_ID` geocodes strictly and never falls back to nationwide alerts.

## Why the daily answer is locked

Version 1.9 calculated “today” independently in every browser from the current hour to midnight. The answer could therefore change after a predicted shower passed, after an Open-Meteo model update, or because another visitor had a different cache age or device timezone.

Version 2.0 separates two data classes:

- `data/daily-snapshot.json` is the shared authority for dated YES/NO cards and their wet-period evidence.
- Live browser requests provide tomorrow’s changeable YES/NO answer, current conditions, next-24-hour charts, AQI/pollen, alerts, sun/moon detail, and the seven-day forecast. Live data never replaces today’s locked daily card.

If the current Prague date is absent from the snapshot, the card says `PENDING`; it does not silently calculate a replacement from live data. A current-date entry from an older snapshot is allowed as a schedule-delay fallback and is clearly marked stale.

## Repository layout

```text
index.html                         Main GitHub Pages entry
Weather.html                       Compatibility redirect for the old URL
data/daily-snapshot.json           Initial generated snapshot
scripts/app.mjs                    Browser application
scripts/weather-core.mjs           Shared pure date/decision/alert logic
scripts/i18n.mjs                   Czech and English UI messages
scripts/suncalc-loader.mjs         Explicit external dependency loader
scripts/generate-daily-snapshot.mjs
scripts/fetch-previous-snapshot.mjs
scripts/prepare-site.mjs
tests/weather-core.test.mjs
tests/meteoalarm-worker.test.mjs
worker/worker.js                   Cloudflare Worker module
worker/wrangler.jsonc              Worker deployment configuration
.github/workflows/publish-weather.yml
```

The application remains a static site. It has no database, server, private API key, or always-running process.

## Decision rules

- City: Přerov (`49.4551`, `17.4509`)
- Canonical timezone: `Europe/Prague`
- YES when an hourly record has total precipitation of at least `0.2 mm`, or precipitation probability of at least `60%`
- `precipitation` is the canonical total; `rain + showers` is used only when that total is unavailable
- Wet periods end at the next hourly boundary
- Peaks rank by precipitation amount, then probability, then earliest timestamp

The product preserves the existing “total precipitation” meaning. Open-Meteo’s total can include snow; the UI does not double-count the `rain` and `showers` components.

The live next-rain card is intentionally separate from the locked daily answer. It uses `0.05 mm` per 15-minute interval, equivalent to the daily card’s `0.2 mm/h` amount threshold. It reports ongoing rain, rain beginning within the next hour, or the next measurable signal within six hours.

## Local development

Requires Node.js 20 or newer. No package installation is needed.

```sh
node --test
node scripts/generate-daily-snapshot.mjs
python -m http.server 8765
```

Then open `http://127.0.0.1:8765/`.

To test generation without a network call:

```sh
node scripts/generate-daily-snapshot.mjs --input path/to/open-meteo-response.json
```

The generator exits non-zero when Open-Meteo fails, the timezone is wrong, required arrays are absent or mismatched, no dated entries are produced, or the resulting snapshot is invalid.

## Automated publication

`.github/workflows/publish-weather.yml`:

- runs at 00:05 in `Europe/Prague`;
- supports manual dispatch and deployment on `main`;
- runs tests before publication;
- downloads the currently deployed snapshot when available;
- preserves an already-published current-day answer during same-day reruns;
- generates seven dated entries so a delayed schedule still has a current-date fallback;
- deploys a dedicated static artifact with GitHub Pages;
- prevents overlapping deployments from publishing out of order.

The first workflow run after a Prague date rollover may publish a refreshed answer for that new date. Further runs on the same Prague date preserve the already deployed current-day entry.

### Manual recovery

1. Open the repository’s **Actions** tab.
2. Select **Publish Přerov weather**.
3. Choose **Run workflow** on `main`.
4. Check the deployed page and confirm its snapshot status shows the current Prague date.

Scheduled workflows can be delayed, and GitHub may disable schedules in inactive public repositories. Manual dispatch is the recovery path.

## GitHub Pages owner setup

The repository owner must perform this one-time setting because it is outside the codebase:

1. Go to **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.
3. Ensure Actions are allowed for the repository.
4. Run the workflow once manually and verify the environment URL.

No repository secret is required.

## Meteoalarm Worker

The deployed Worker endpoint is:

```text
https://weatherwebsiteprerov.matejkratochvilbilina.workers.dev
```

Its source is versioned in `worker/worker.js`. The Worker reads Meteoalarm’s maintained Atom compatibility feed, parses CAP fields, and strictly selects regions using structured `areaDesc` values and `EMMA_ID` prefixes. An Olomouc request therefore returns only `CZ071…` or explicitly Olomouc-matching entries; zero matches produces an empty list rather than a nationwide fallback.

After authenticating Wrangler, deploy it from the repository root with:

```sh
npx wrangler deploy --config worker/wrangler.jsonc
```

## Data, privacy, and disclaimer

- Forecasts: [Open-Meteo Weather Forecast API](https://open-meteo.com/en/docs)
- Air quality and pollen: [Open-Meteo Air Quality API](https://open-meteo.com/en/docs/air-quality-api)
- Alerts: [Meteoalarm](https://www.meteoalarm.org/en/live/) through the existing Cloudflare Worker, with [ČHMÚ warnings](https://vystrahy-cr.chmi.cz/) as the official Czech reference
- Radar: ČHMÚ and partners through `radar.bourky.cz`, with the [official ČHMÚ radar viewer](https://produkty.chmi.cz/radar/) as the source reference
- Sun/moon calculations: [SunCalc](https://github.com/mourner/suncalc)

Experimental hobby project. Unofficial. No guarantee of accuracy, timeliness, or availability. Verify important conditions with ČHMÚ and Meteoalarm. No personal data is collected.

The current Worker response has no polygons or structured area identifiers and can include other Czech regions. The client therefore keeps only deduplicated titles that explicitly name Olomoucký kraj, Olomouc Region, or Přerov; the Meteoalarm map remains the authoritative fallback.

Copyright © 2025–2026 matesaman9910. All rights reserved.
