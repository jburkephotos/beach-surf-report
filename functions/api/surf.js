/**
 * SWELL READER — Data Worker v2 (Cloudflare Pages Function)
 * ---------------------------------------------------------
 * Pulls everything SERVER-SIDE (no CORS issues), for one spot at a time:
 *   • Open-Meteo Marine — HOURLY forecast, swell + wind-wave SPLIT (primary/secondary)
 *   • NDBC buoy 46050   — live "right now" observation (ground truth)
 *   • NOAA CO-OPS tides — next 48h hi/lo
 *
 * No API keys. No rating/scoring — raw data only, for surfers to read themselves.
 *
 * DEPLOY: functions/api/surf.js   ->   app calls /api/surf?spot=south-beach
 * (Standalone Worker also works; see entry points below.)
 */

const BUOY = "46050";            // Stonewall Bank — central OR offshore reference
const TIDE_STATION = "9435380";  // South Beach, Yaquina Bay (Newport)

// Per-spot coordinates feed Open-Meteo's nearshore forecast.
const SPOTS = {
  "seaside-cove":   { name:"Seaside Cove",             lat:45.98, lon:-123.94 },
  "short-sand":     { name:"Short Sand (Oswald West)", lat:45.76, lon:-123.96 },
  "pacific-city":   { name:"Pacific City",             lat:45.20, lon:-123.97 },
  "otter-rock":     { name:"Otter Rock",               lat:44.75, lon:-124.07 },
  "agate-beach":    { name:"Agate Beach",              lat:44.66, lon:-124.06 },
  "south-beach":    { name:"South Beach",              lat:44.61, lon:-124.07 },
  "florence":       { name:"Florence (S Jetty)",       lat:43.98, lon:-124.13 },
  "bastendorff":    { name:"Bastendorff Beach",        lat:43.34, lon:-124.34 },
  "port-orford":    { name:"Battle Rock (Port Orford)",lat:42.74, lon:-124.50 },
};

// ----------------------------------------------------------------------------
// BATHYMETRY-TUNED SPOT RULES (the "real edge" — static, hand-tuned)
// ----------------------------------------------------------------------------
// We can't run a live nearshore wave model like Surfline's LOLA. But we CAN
// encode, per spot, how the seafloor + headlands shape incoming swell — derived
// from NOAA BlueTopo bathymetry + local knowledge. This is a one-time tuning,
// not a live computation, and it's what lets the forecast say "this swell
// direction actually works HERE" instead of just parroting the open-ocean buoy.
//
//   idealSwellDir : compass deg the break is best oriented to receive
//   swellWindow   : +/- degrees off ideal before the spot starts to shut down
//   bestPeriod    : seconds of swell period this bottom contour favors
//   shelter       : 0..1, how much a headland/jetty blocks raw swell (1 = open)
//   note          : plain-language "what makes it work" for surfers
//
// Edit these as you ground-truth them with the BlueTopo viewer + your own eyes.
const SPOT_TUNING = {
  "seaside-cove":  { idealSwellDir:270, swellWindow:45, bestPeriod:11, shelter:0.95, note:"Open W-facing beachbreak; takes most W–NW swell, sandbars shift seasonally." },
  "short-sand":    { idealSwellDir:270, swellWindow:35, bestPeriod:12, shelter:0.7,  note:"Cape Falcon shelters it from N wind; needs a bit more W swell to wrap in." },
  "pacific-city":  { idealSwellDir:285, swellWindow:40, bestPeriod:12, shelter:0.85, note:"Cape Kiwanda blocks NW; best on W–WNW groundswell, holds size." },
  "otter-rock":    { idealSwellDir:270, swellWindow:30, bestPeriod:11, shelter:0.6,  note:"Cove tucked behind the cape — mellow, gathers wrapping W swell, wind-protected." },
  "agate-beach":   { idealSwellDir:282, swellWindow:45, bestPeriod:11, shelter:0.9,  note:"Long open beach N of Yaquina Head; exposed, picks up most swell directions." },
  "south-beach":   { idealSwellDir:272, swellWindow:45, bestPeriod:11, shelter:0.92, note:"Jetty-fed sandbars S of the bay mouth; banks change but consistently catches W swell." },
  "florence":      { idealSwellDir:285, swellWindow:50, bestPeriod:12, shelter:0.95, note:"Very open; needs a clean window — wind ruins it fast, but raw swell access is high." },
  "bastendorff":   { idealSwellDir:250, swellWindow:40, bestPeriod:12, shelter:0.85, note:"Coos Bay's most consistent; faces a touch SW, the bay/cape give some N-wind shelter." },
  "port-orford":   { idealSwellDir:240, swellWindow:35, bestPeriod:13, shelter:0.7,  note:"Tucked in the SW corner behind the head — wind-protected, wants more S/SW swell." },
};

export async function onRequest(context) { return handle(context.request); }
export default { fetch: (request) => handle(request) };

async function handle(request) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Cache-Control": "public, max-age=900",
  };
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });

  const url = new URL(request.url);
  const spotKey = url.searchParams.get("spot") || "south-beach";
  const spot = SPOTS[spotKey] || SPOTS["south-beach"];

  // requested horizon: 3 or 7 = full marine forecast; 10 = wind-only outlook
  let days = parseInt(url.searchParams.get("days") || "3");
  if (![3, 7, 10].includes(days)) days = 3;
  const windOnly = days === 10;          // marine model only reaches 7 days
  const marineDays = windOnly ? 7 : days;

  try {
    const [forecast, buoy, tides] = await Promise.all([
      getForecast(spot, marineDays, days, windOnly),
      getBuoy().catch(() => null),
      getTides().catch(() => null),
    ]);
    return new Response(JSON.stringify({
      spot: { key: spotKey, name: spot.name, lat: spot.lat, lon: spot.lon },
      spots: Object.entries(SPOTS).map(([k, v]) => ({ key: k, name: v.name })),
      days, windOnly,
      tuning: SPOT_TUNING[spotKey] || null,
      spotFit: spotFitRead(spotKey, forecast[0]),
      forecast, buoy, tides, generated: Date.now(),
    }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 502, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
}

// ---------- Open-Meteo Marine: hourly, split swell/wind-wave ----------
// marineDays: days to request from marine model (<=7)
// reqDays: what the user asked for (3/7/10) — controls sampling + length
// windOnly: 10-day mode, wind forecast only (marine doesn't reach 10d)
async function getForecast(spot, marineDays, reqDays, windOnly) {
  // wind forecast reaches the full requested horizon (weather API does 16d)
  const wu = `https://api.open-meteo.com/v1/forecast?latitude=${spot.lat}&longitude=${spot.lon}` +
    `&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m&timezone=America%2FLos_Angeles` +
    `&forecast_days=${reqDays}&wind_speed_unit=kn`;

  let m = { hourly: {} };
  if (!windOnly) {
    const vars = [
      "wave_height","wave_direction","wave_period",
      "swell_wave_height","swell_wave_direction","swell_wave_period","swell_wave_peak_period",
      "wind_wave_height","wind_wave_direction","wind_wave_period",
    ].join(",");
    const u = `https://marine-api.open-meteo.com/v1/marine?latitude=${spot.lat}&longitude=${spot.lon}` +
      `&hourly=${vars}&timezone=America%2FLos_Angeles&forecast_days=${marineDays}&length_unit=imperial`;
    const mr = await fetch(u, { cf: { cacheTtl: 1800 } });
    if (!mr.ok) throw new Error(`marine ${mr.status}`);
    m = await mr.json();
  }
  const wr = await fetch(wu, { cf: { cacheTtl: 1800 } });
  const w = wr.ok ? await wr.json() : { hourly: {} };

  const H = m.hourly || {}, WH = w.hourly || {};
  // sampling: hourly for 3d, every 3h for 7d, every 6h for 10d wind — keeps tables readable
  const step = reqDays <= 3 ? 1 : reqDays <= 7 ? 3 : 6;

  // index time by the wind series (always present); marine aligns by timestamp
  const wtimes = WH.time || [];
  // build a lookup from marine time -> index
  const mIndex = {};
  (H.time || []).forEach((t, i) => { mIndex[t] = i; });

  const out = [];
  const nowIso = new Date().toLocaleString("sv-SE", { timeZone: "America/Los_Angeles" }).slice(0, 13);
  for (let i = 0; i < wtimes.length; i++) {
    if (wtimes[i].slice(0, 13) < nowIso) continue;       // skip past hours
    if ((out.length === 0) || (i % step === 0)) {        // sample at the step
      const mi = mIndex[wtimes[i]];
      const row = {
        t: wtimes[i],
        windKt:  round1(WH.wind_speed_10m?.[i]),
        gustKt:  round1(WH.wind_gusts_10m?.[i]),
        windDir: WH.wind_direction_10m?.[i] ?? null,
      };
      if (!windOnly && mi != null) {
        row.waveFt   = round1(H.wave_height?.[mi]);
        row.waveDir  = H.wave_direction?.[mi] ?? null;
        row.wavePer  = round1(H.wave_period?.[mi]);
        row.swellFt  = round1(H.swell_wave_height?.[mi]);
        row.swellDir = H.swell_wave_direction?.[mi] ?? null;
        row.swellPer = round1(H.swell_wave_peak_period?.[mi] ?? H.swell_wave_period?.[mi]);
        row.windWaveFt  = round1(H.wind_wave_height?.[mi]);
        row.windWaveDir = H.wind_wave_direction?.[mi] ?? null;
        row.windWavePer = round1(H.wind_wave_period?.[mi]);
      }
      out.push(row);
    }
  }
  return out;
}

// ---------- NDBC buoy: live "right now" ----------
async function getBuoy() {
  const r = await fetch(`https://www.ndbc.noaa.gov/data/realtime2/${BUOY}.txt`, { cf: { cacheTtl: 900 } });
  if (!r.ok) throw new Error(`buoy ${r.status}`);
  const txt = await r.text();
  for (const line of txt.split("\n").filter(l => l && !l.startsWith("#"))) {
    const c = line.trim().split(/\s+/);
    const wvht = parseFloat(c[8]), dpd = parseFloat(c[9]);
    if (!isNaN(wvht) && !isNaN(dpd)) {
      const num = x => (isNaN(parseFloat(x)) ? null : parseFloat(x));
      return {
        heightFt: round1(wvht * 3.28084),
        period: dpd,
        swellDir: num(c[11]),
        windKt: num(c[6]) != null ? round1(num(c[6]) * 1.94384) : null,
        windDir: num(c[5]),
        waterF: num(c[14]) != null ? round1(num(c[14]) * 9 / 5 + 32) : null,
        stamp: `${c[0]}-${c[1]}-${c[2]} ${c[3]}:${c[4]}Z`,
      };
    }
  }
  throw new Error("no buoy row");
}

// ---------- NOAA tides ----------
async function getTides() {
  const base = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";
  const q = new URLSearchParams({
    station: TIDE_STATION, product: "predictions", datum: "MLLW", interval: "hilo",
    units: "english", time_zone: "lst_ldt", format: "json", date: "today", range: "48",
    application: "SwellReader",
  });
  const r = await fetch(`${base}?${q}`, { cf: { cacheTtl: 3600 } });
  if (!r.ok) throw new Error(`tides ${r.status}`);
  const data = await r.json();
  return (data.predictions || []).map(p => ({
    time: p.t, heightFt: round1(parseFloat(p.v)), type: p.type === "H" ? "high" : "low",
  }));
}

const round1 = x => (x == null || isNaN(x) ? null : Math.round(x * 10) / 10);

// Bathymetry-tuned "does the current swell suit THIS break?" read.
// Uses the hand-tuned SPOT_TUNING (derived from BlueTopo + local knowledge)
// to interpret the open-ocean swell for the specific spot's orientation.
function spotFitRead(spotKey, cur){
  const t = SPOT_TUNING[spotKey];
  if(!t || !cur || cur.swellFt==null) return null;
  // direction match
  let dirFit = "good", dirNote = "";
  if(cur.swellDir!=null){
    let off = Math.abs(cur.swellDir - t.idealSwellDir) % 360; if(off>180) off=360-off;
    if(off <= t.swellWindow*0.5)      { dirFit="ideal";  dirNote="swell is coming from the direction this break likes"; }
    else if(off <= t.swellWindow)     { dirFit="good";   dirNote="swell direction is workable here"; }
    else                              { dirFit="poor";   dirNote="swell is coming from an angle this break doesn't favor — likely weak or closed out"; }
  }
  // period match
  let perFit = "good";
  if(cur.swellPer!=null){
    if(cur.swellPer >= t.bestPeriod) perFit="ideal";
    else if(cur.swellPer >= t.bestPeriod-3) perFit="good";
    else perFit="poor";
  }
  return { dirFit, perFit, dirNote, note: t.note,
    summary: dirFit==="ideal"&&perFit==="ideal" ? "Conditions suit this break well today."
           : dirFit==="poor" ? "Today's swell doesn't line up well with this break."
           : "Workable for this break, not perfect." };
}
