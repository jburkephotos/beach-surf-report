/**
 * SWELL READER — Beach Conditions Worker (the "Today" data layer)
 * ----------------------------------------------------------------
 * Powers the "Should I go to the beach today?" view for VISITORS, not just
 * surfers. Pulls everything server-side (no CORS), no API keys:
 *
 *   1) NWS OFFICIAL ALERTS  — api.weather.gov, zone ORZ001 (Central OR Coast:
 *      Lincoln City, Newport, Waldport). Real Beach Hazards Statements, High
 *      Surf Advisories, Tsunami alerts. THIS IS THE AUTHORITATIVE SAFETY SOURCE.
 *   2) DAYLIGHT WEATHER     — Open-Meteo: temp, rain chance, cloud/fog, UV, wind.
 *   3) SUN TIMES            — sunrise / sunset / golden hour.
 *   4) TIDES                — NOAA 9435380: daylight low-tide (tidepool) windows
 *                             + king-tide / minus-tide flags.
 *   5) SURF heads-up        — buoy 46050 height, for a 7ft+ "big surf" flag that
 *                             backs up (never replaces) the official NWS alert.
 *
 * DEPLOY: functions/api/beach.js   ->   app calls /api/beach?spot=south-beach
 *
 * IMPORTANT: api.weather.gov requires a User-Agent header identifying your app.
 * Set it below (NWS asks for a contact). Without it, requests may be rejected.
 */

const NWS_ZONE = "ORZ001";                 // Central Coast of Oregon (land zone, for alerts)
const NWS_SURF_ZONE = "orz103";            // Lincoln City surf-zone forecast (rip current risk)
const NWS_UA   = "BeachReport/1.0 (beach.jburkephotos.com; jlburkephotos@gmail.com)";
const TIDE_STATION = "9435380";            // South Beach, Yaquina Bay (Newport)
const BUOY = "46050";

// HAND-BUILT known permanent rip hazards. These aren't weather — they're
// structural (headlands, jetties channeling water) and present almost always.
// This is local ground-truth the NWS general forecast can't give. Edit freely.
const KNOWN_RIPS = {
  "south-beach": [{
    name:"South Jetty rip",
    severity:"high",
    text:"A strong, near-constant rip runs along the south jetty at the mouth of Yaquina Bay. It's fast and pulls straight out. Stay well south of the jetty, keep kids back, and never wade near the rocks. If caught: don't fight it — swim parallel to the beach, then back in."
  }],
  "agate-beach": [{
    name:"Yaquina Head rip",
    severity:"high",
    text:"The rocky point at Yaquina Head channels a fast rip along its south side. It's deceptive on calm-looking days. Keep clear of the rocks, stay where the waves break evenly, and if pulled out, swim parallel to shore before heading in."
  }],
  // Add more as you map them — river mouths, other jetties, etc.
};

const SPOTS = {
  "seaside-cove":{name:"Seaside Cove",lat:45.98,lon:-123.94},
  "short-sand":{name:"Short Sand",lat:45.76,lon:-123.96},
  "pacific-city":{name:"Pacific City",lat:45.20,lon:-123.97},
  "otter-rock":{name:"Otter Rock",lat:44.75,lon:-124.07},
  "agate-beach":{name:"Agate Beach",lat:44.66,lon:-124.06},
  "south-beach":{name:"South Beach",lat:44.61,lon:-124.07},
  "florence":{name:"Florence",lat:43.98,lon:-124.13},
  "bastendorff":{name:"Bastendorff",lat:43.34,lon:-124.34},
  "port-orford":{name:"Port Orford",lat:42.74,lon:-124.50},
};

export async function onRequest(context){ return handle(context.request); }
export default { fetch: (request)=>handle(request) };

async function handle(request){
  const cors = {
    "Access-Control-Allow-Origin":"*",
    "Access-Control-Allow-Methods":"GET, OPTIONS",
    "Cache-Control":"public, max-age=900",
  };
  if(request.method==="OPTIONS") return new Response(null,{headers:cors});

  const url=new URL(request.url);
  const spotKey=url.searchParams.get("spot")||"south-beach";
  const spot=SPOTS[spotKey]||SPOTS["south-beach"];

  try{
    const [alerts, weather, tides, surf, ripFc] = await Promise.all([
      getAlerts().catch(()=>[]),
      getWeather(spot).catch(()=>null),
      getTides().catch(()=>null),
      getBuoyHeight().catch(()=>null),
      getSurfZone().catch(()=>null),
    ]);

    // builders that reason about "today" get today's tides only;
    // the full 14-day array still goes out for the swipeable chart.
    const todayKey = new Date().toLocaleString("sv-SE",{timeZone:"America/Los_Angeles"}).slice(0,10);
    const tidesToday = (tides||[]).filter(t=>t.day===todayKey);

    const moments = buildMoments(weather, tidesToday);
    const safety  = buildSafety(alerts, surf, tidesToday);
    const beachDay = buildBeachDay(weather);
    const rip = buildRip(spotKey, ripFc);
    const bestWindow = buildBestWindow(weather, tidesToday);
    const campfire = buildCampfire(weather, tidesToday);
    const photo = buildPhoto(weather, tidesToday, surf);

    return new Response(JSON.stringify({
      spot:{key:spotKey,name:spot.name},
      spots:Object.entries(SPOTS).map(([k,v])=>({key:k,name:v.name})),
      safety, beachDay, moments, rip, bestWindow, campfire, photo,
      weather, tides, tidesToday, surfHeight:surf,
      generated:Date.now(),
    }),{headers:{...cors,"Content-Type":"application/json"}});
  }catch(e){
    return new Response(JSON.stringify({error:e.message}),{status:502,headers:{...cors,"Content-Type":"application/json"}});
  }
}

// ---------- 1. NWS official alerts ----------
async function getAlerts(){
  const r=await fetch(`https://api.weather.gov/alerts/active/zone/${NWS_ZONE}`,
    { headers:{ "User-Agent":NWS_UA, "Accept":"application/geo+json" }, cf:{cacheTtl:600} });
  if(!r.ok) throw new Error(`nws ${r.status}`);
  const d=await r.json();
  return (d.features||[]).map(f=>{
    const p=f.properties||{};
    return {
      event: p.event,                 // "Beach Hazards Statement", "High Surf Advisory", ...
      severity: p.severity,           // Minor/Moderate/Severe/Extreme
      urgency: p.urgency,
      headline: p.headline,
      // trim the wall-of-text instruction to the essential bit
      summary: (p.description||"").split("\n\n")[0]?.replace(/\s+/g," ").slice(0,300) || "",
      onset: p.onset, ends: p.ends,
    };
  });
}

// ---------- 2. daylight weather ----------
async function getWeather(spot){
  const u=`https://api.open-meteo.com/v1/forecast?latitude=${spot.lat}&longitude=${spot.lon}`+
    `&hourly=temperature_2m,apparent_temperature,precipitation_probability,cloud_cover,visibility,wind_speed_10m,wind_gusts_10m,uv_index`+
    `&daily=sunrise,sunset,uv_index_max,precipitation_probability_max,temperature_2m_max`+
    `&timezone=America%2FLos_Angeles&forecast_days=1&temperature_unit=fahrenheit&wind_speed_unit=kn`;
  const r=await fetch(u,{cf:{cacheTtl:900}});
  if(!r.ok) throw new Error(`weather ${r.status}`);
  const d=await r.json();
  const H=d.hourly||{}, D=d.daily||{};
  // find the current hour index
  const nowIso=new Date().toLocaleString("sv-SE",{timeZone:"America/Los_Angeles"}).slice(0,13);
  let i=(H.time||[]).findIndex(t=>t.slice(0,13)>=nowIso); if(i<0)i=0;
  const vis=H.visibility?.[i];
  return {
    nowF: r1(H.temperature_2m?.[i]),
    feelsF: r1(H.apparent_temperature?.[i]),
    highF: r1(D.temperature_2m_max?.[0]),
    rainPct: H.precipitation_probability?.[i] ?? D.precipitation_probability_max?.[0] ?? null,
    cloudPct: H.cloud_cover?.[i] ?? null,
    foggy: vis!=null ? vis < 2000 : null,   // <2km visibility ~ fog/mist (meters)
    visKm: vis!=null ? r1(vis/1000) : null,
    windKt: r1(H.wind_speed_10m?.[i]),
    gustKt: r1(H.wind_gusts_10m?.[i]),
    uv: r1(H.uv_index?.[i]),
    uvMax: r1(D.uv_index_max?.[0]),
    sunrise: D.sunrise?.[0]||null,
    sunset: D.sunset?.[0]||null,
  };
}

// ---------- 3+4. tides ----------
async function getTides(){
  // 14-day window of high/low predictions (NOAA allows up to 10 years out)
  const pad=n=>String(n).padStart(2,"0");
  const fmtDate=d=>`${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;
  const start=new Date();
  const end=new Date(Date.now()+14*86400000);
  const q=new URLSearchParams({station:TIDE_STATION,product:"predictions",datum:"MLLW",interval:"hilo",
    units:"english",time_zone:"lst_ldt",format:"json",
    begin_date:fmtDate(start),end_date:fmtDate(end),application:"SwellReader"});
  const r=await fetch(`https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?${q}`,{cf:{cacheTtl:21600}});
  if(!r.ok) throw new Error(`tides ${r.status}`);
  const d=await r.json();
  // p.t is "YYYY-MM-DD HH:MM" local — keep full timestamp + a day key for grouping
  return (d.predictions||[]).map(p=>({
    time:p.t,
    day:(p.t||"").slice(0,10),
    heightFt:r1(parseFloat(p.v)),
    type:p.type==="H"?"high":"low"
  }));
}

// ---------- 5. buoy height only (for big-surf flag) ----------
async function getBuoyHeight(){
  const r=await fetch(`https://www.ndbc.noaa.gov/data/realtime2/${BUOY}.txt`,{cf:{cacheTtl:900}});
  if(!r.ok) throw new Error(`buoy ${r.status}`);
  const txt=await r.text();
  for(const line of txt.split("\n").filter(l=>l&&!l.startsWith("#"))){
    const c=line.trim().split(/\s+/); const wvht=parseFloat(c[8]);
    if(!isNaN(wvht)) return r1(wvht*3.28084);
  }
  return null;
}

// ---------- derived: safety band ----------
function buildSafety(alerts, surfFt, tides){
  const items=[];

  // OFFICIAL NWS alerts first — these are authoritative
  for(const a of alerts){
    let level="amber";
    const ev=(a.event||"").toLowerCase();
    if(ev.includes("tsunami")||a.severity==="Extreme"||a.severity==="Severe") level="red";
    if(ev.includes("statement")&&a.severity==="Minor") level="amber";
    items.push({ level, official:true, title:a.event, text:a.summary||a.headline||"", ends:a.ends });
  }

  // TOOL's own heads-up flags (clearly secondary to official alerts)
  // Big surf flag (>=7ft) — backs up, doesn't replace, an official advisory
  if(surfFt!=null && surfFt>=7){
    const already = alerts.some(a=>/surf|beach hazard/i.test(a.event||""));
    if(!already){
      items.push({ level: surfFt>=12?"red":"amber", official:false,
        title:`Big surf — ${surfFt.toFixed(0)} ft at the buoy`,
        text:"Large waves offshore. Sneaker waves can surge far up the beach without warning — stay well back from the waterline, off rocks and jetties, and never turn your back on the ocean." });
    }
  }

  // King tide / extreme high (>= ~8.5 ft at this station is notably high)
  const maxHigh = Math.max(0,...(tides||[]).filter(t=>t.type==="high").map(t=>t.heightFt));
  if(maxHigh>=8.5){
    const t=(tides||[]).find(t=>t.type==="high"&&t.heightFt===maxHigh);
    items.push({ level:"amber", official:false,
      title:`Extreme high tide — ${maxHigh.toFixed(1)} ft`,
      text:`A king-tide-level high${t?` around ${fmtTime(t.time)}`:""}. Beach access and low spots can flood; some beaches get cut off. Great for wave-watching from a safe height.` });
  }

  return items;
}

// ---------- derived: is it a nice beach day? ----------
function buildBeachDay(w){
  if(!w) return null;
  let score=0, notes=[];
  // temperature (coast is cool; grade gently)
  if(w.highF!=null){
    if(w.highF>=62){score+=2;notes.push("mild");}
    else if(w.highF>=55){score+=1;notes.push("cool but fine");}
    else notes.push("chilly — bring layers");
  }
  // rain
  if(w.rainPct!=null){
    if(w.rainPct<=20){score+=2;notes.push("mostly dry");}
    else if(w.rainPct<=50){score+=1;notes.push("some shower risk");}
    else notes.push("likely wet");
  }
  // wind
  if(w.windKt!=null){
    if(w.windKt<10){score+=2;notes.push("light wind");}
    else if(w.windKt<18){score+=1;notes.push("breezy");}
    else notes.push("windy");
  }
  // sun/fog
  if(w.foggy){ notes.push("foggy"); }
  else if(w.cloudPct!=null){
    if(w.cloudPct<=40){score+=1;notes.push("decent sun");}
    else if(w.cloudPct>=85) notes.push("overcast");
  }
  const verdict = score>=6 ? "A really nice beach day"
    : score>=4 ? "A decent beach day"
    : score>=2 ? "Doable — dress for it"
    : "Rough beach day, honestly";
  return { score, max:7, verdict, notes };
}

// ---------- derived: today's moments (tidepools, sunset, golden hour) ----------
function buildMoments(w, tides){
  const out=[];
  // daylight low tide -> tidepool window (best when low and in daylight)
  if(tides && w && w.sunrise && w.sunset){
    const sr=hm(w.sunrise), ss=hm(w.sunset);
    (tides||[]).filter(t=>t.type==="low").forEach(t=>{
      const m=hm(t.time);
      if(m!=null && sr!=null && ss!=null && m>=sr-30 && m<=ss+30){
        const great = t.heightFt<=1.0;
        out.push({ kind:"tidepool", icon:"🦀",
          title: great?"Great tidepooling window":"Low-tide window",
          detail:`${t.heightFt.toFixed(1)} ft low around ${fmtTime(t.time)}${great?" — a minus-ish tide, excellent for tidepools and exploring":" — decent for tidepools"}.` });
      }
    });
  }
  // sunset + golden hour + blue hour
  if(w && w.sunset){
    const gh = addMin(w.sunset,-60);      // golden hour: ~1hr before sunset
    const bhStart = w.sunset;             // blue hour: roughly sunset to ~30min after
    const bhEnd = addMin(w.sunset, 30);
    out.push({ kind:"sunset", icon:"🌅", title:"Golden &amp; blue hour",
      detail:`Golden hour ~${fmtTime(gh)} (warm, low light). Sunset ${fmtTime(w.sunset)}. Then blue hour ${fmtTime(bhStart)}–${fmtTime(bhEnd)} — the deep-blue afterglow photographers love.` });
  }
  return out;
}

// ---------- NWS Surf Zone Forecast: rip current risk (seasonal) ----------
async function getSurfZone(){
  const url=`https://tgftp.nws.noaa.gov/data/forecasts/marine/surf_zone/or/${NWS_SURF_ZONE}.txt`;
  const r=await fetch(url,{ headers:{ "User-Agent":NWS_UA }, cf:{cacheTtl:1800} });
  if(!r.ok) throw new Error(`surfzone ${r.status}`);
  const txt=await r.text();
  // grab the first ".TODAY..." (or ".REST OF TODAY...") block
  const block = txt.split(/\.[A-Z][A-Z ]+\.\.\./)[1] || txt;
  const grab = (label)=>{ const m=txt.match(new RegExp(label+"\\.*\\s*([^\\n.]+)","i")); return m?m[1].trim():null; };
  const rip = grab("Rip Current Risk");      // "Low" / "Moderate" / "High" (may be absent off-season)
  const surfHt = grab("Surf Height");
  const water = grab("Water Temperature");
  return { rip: rip||null, surfHeightText: surfHt||null, waterText: water||null };
}

// ---------- derived: rip current risk + known permanent rips ----------
function buildRip(spotKey, ripFc){
  const out = { official:null, known: KNOWN_RIPS[spotKey] || [] };
  if(ripFc && ripFc.rip){
    const lvl = ripFc.rip.toLowerCase();
    out.official = {
      level: lvl.includes("high") ? "high" : lvl.includes("mod") ? "moderate" : "low",
      label: ripFc.rip,
      text: lvl.includes("high") ? "Life-threatening rip currents are LIKELY in the surf zone today. Stay out of the water unless you're an experienced surf swimmer."
          : lvl.includes("mod") ? "Life-threatening rip currents are possible today. Only experienced surf swimmers should enter the water."
          : "Low general risk today — but rips still form near jetties, points, and river mouths. Know your exit.",
    };
  }
  return out;
}

// ---------- derived: best window to be at the beach today ----------
// Combines light wind + a dropping/low tide in daylight + low rain.
function buildBestWindow(w, tides){
  if(!w || !w.sunrise || !w.sunset) return null;
  const sr=hm(w.sunrise), ss=hm(w.sunset);
  // find a daylight low tide as the anchor (more beach, calmer, safer)
  const lows=(tides||[]).filter(t=>t.type==="low").map(t=>({m:hm(t.time),ft:t.heightFt,label:fmtTime(t.time)}))
    .filter(t=>t.m!=null && t.m>=sr && t.m<=ss);
  let anchor = lows.sort((a,b)=>a.ft-b.ft)[0]; // lowest daylight low
  let when, why=[];
  if(anchor){
    const start=Math.max(sr, anchor.m-120), end=Math.min(ss, anchor.m+120);
    when = `${fmtTime(min2iso(start))}–${fmtTime(min2iso(end))}`;
    why.push(`low tide ${anchor.ft.toFixed(1)}ft at ${anchor.label} (more beach, safer footing)`);
  } else {
    // no daylight low — just recommend afternoon before evening wind
    when = `${fmtTime(min2iso(Math.max(sr,13*60)))}–${fmtTime(min2iso(Math.min(ss,17*60)))}`;
    why.push("afternoon, before the evening wind fills in");
  }
  if(w.windKt!=null && w.windKt<10) why.push("light wind");
  if(w.rainPct!=null && w.rainPct<=30) why.push("low rain chance");
  return { when, why };
}

// ---------- derived: campfire conditions ----------
// Conditions read only — NOT a legality call. Links to official rules.
function buildCampfire(w, tides){
  if(!w) return null;
  let ok=true, notes=[];
  if(w.windKt!=null){
    if(w.windKt<12){ notes.push("wind is calm enough to keep a fire controlled"); }
    else { ok=false; notes.push(`wind is up (${w.windKt.toFixed(0)} kt) — fires spread fast and are hard to manage`); }
  }
  if(w.rainPct!=null && w.rainPct>60) notes.push("good chance of rain — pack covered kindling");
  // a low/dropping tide gives dry sand below the high-tide line (where fires belong)
  const eveningLow = (tides||[]).find(t=>t.type==="low" && hm(t.time)!=null && hm(t.time) >= 17*60);
  if(eveningLow) notes.push(`evening low tide ~${fmtTime(eveningLow.time)} exposes dry sand below the wrack line`);
  return {
    favorable: ok,
    summary: ok ? "Conditions look workable for a beach fire tonight." : "Conditions aren't great for a fire tonight.",
    notes,
    rulesNote:"Oregon allows beach fires below the vegetation line, under 3 ft across, on most ocean-shore beaches — but seasonal burn bans and local restrictions apply. Always check current rules before you light up.",
    rulesUrl:"https://stateparks.oregon.gov/index.cfm?do=v.page&id=143", // OR State Parks beach fire info
  };
}

// ---------- derived: best photo opportunity (the photographer's read) ----------
// Maps current conditions to what's worth shooting + how. Headline adapts to
// the moment; the dozen fundamentals get lightly reordered so the most relevant
// float to the top.
function buildPhoto(w, tides, surfFt){
  if(!w) return null;
  const nowM = (()=>{ const p=new Date().toLocaleString("sv-SE",{timeZone:"America/Los_Angeles"}).match(/(\d{2}):(\d{2})/); return p?(+p[1]*60+ +p[2]):null; })();
  const sunsetM = hm(w.sunset), sunriseM = hm(w.sunrise);

  const cloudy   = w.cloudPct!=null && w.cloudPct>=40 && w.cloudPct<=85; // broken cloud = drama
  const overcast = w.cloudPct!=null && w.cloudPct>85;
  const clear    = w.cloudPct!=null && w.cloudPct<40;
  const foggy    = !!w.foggy;
  const nearSunset  = sunsetM!=null && nowM!=null && Math.abs(nowM-sunsetM)<=75;
  const nearSunrise = sunriseM!=null && nowM!=null && Math.abs(nowM-sunriseM)<=75;
  const goldenNow = nearSunset || nearSunrise;
  const lowTideNow = (tides||[]).some(t=>t.type==="low" && hm(t.time)!=null && nowM!=null && Math.abs(hm(t.time)-nowM)<=90);
  const bigSurf = surfFt!=null && surfFt>=8;

  let headline, sub;
  if(foggy){
    headline="Moody, minimal fog shots";
    sub="Fog is a gift — it strips out clutter and turns the beach into clean negative space. Find one subject (a figure, a rock, a lone bird) against the soft grey, and underexpose slightly to hold the mood.";
  } else if(goldenNow && clear){
    headline="Golden-hour portraits & warm light";
    sub="Clear and near golden hour — ideal for family photos and warm portraits. Put the sun behind your subject for a glowing rim light and meter for their face.";
  } else if(nearSunset && cloudy){
    headline="Dramatic sunset — could be a good one";
    sub="Broken cloud near sunset is the recipe for color; the clouds catch the light after the sun drops. Don't pack up at sunset — the best color often lands 10–20 min after, into blue hour.";
  } else if(overcast){
    headline="Soft even light — detail & long exposures";
    sub="Flat overcast is a giant softbox: great for tide-pool detail, textures, and people without harsh shadows. The muted sky also suits silky long-exposure water shots.";
  } else if(lowTideNow){
    headline="Reflections on the wet sand";
    sub="Low tide leaves a mirror of wet sand — get low and catch the sky or sea stacks reflected in it. Tide pools also open up for macro and detail work.";
  } else if(bigSurf){
    headline="Powerful surf & wave action";
    sub="Big swell means dramatic wave shots — but stay on a safe height, never the waterline or rocks. Fast shutter (1/1000+) freezes the spray; slower blurs it to mist.";
  } else if(clear){
    headline="Clean, bright coastal scenes";
    sub="Clear light is harsh but honest — good for crisp wide shots of the coastline, deep blue water, and people in motion. Use the shoreline as a leading line.";
  } else {
    headline="Everyday coast — work the details";
    sub="No single dramatic element right now, so hunt the small stuff: textures, footprints, driftwood, patterns in the sand. The coast always gives something if you slow down.";
  }

  let techniques = [
    {t:"Shoot the golden hour", d:"The hour after sunrise / before sunset gives warm, low, flattering light — worth planning your trip around."},
    {t:"Stay for blue hour", d:"Don't leave at sunset — the 20–30 min after, when the sky goes deep blue, is magic for long exposures and calm sea."},
    {t:"Use the wet sand as a mirror", d:"At low tide, get low and shoot the reflection of sky, clouds, or sea stacks in the glassy wet sand."},
    {t:"Find a leading line", d:"Let the shoreline, a log, a fence, or a tide channel pull the eye from foreground into the scene."},
    {t:"Put a subject in the frame", d:"A lone figure, a dog, a bird — scale makes a big empty beach feel epic instead of flat."},
    {t:"Mind the horizon", d:"Keep it level and off-center — lower third for big skies, upper third for sand and reflections."},
    {t:"Expose for the sky at sunset", d:"Meter for the bright sky so colors stay rich; let the foreground silhouette, or add a touch of fill flash."},
    {t:"Slow the shutter on water", d:"A 1–4 second exposure turns waves to silky mist. Brace on a rock or use a small tripod; phone night mode can fake it."},
    {t:"Freeze the spray", d:"For crashing waves, a fast shutter (1/1000s+) freezes every droplet for dramatic power."},
    {t:"Backlight for rim light", d:"Put the sun behind your subject for a glowing outline. Meter for the face or it goes dark."},
    {t:"Read the clouds", d:"Broken clouds = the best sunsets (they catch color). Clear skies are cleaner but less dramatic. Fog = mood."},
    {t:"Protect your gear", d:"Salt spray and blowing sand wreck cameras. Keep a cloth handy, change lenses out of the wind, and never rinse anything in seawater."},
  ];
  const boost=(kw)=>{ const i=techniques.findIndex(x=>x.t.toLowerCase().includes(kw)); if(i>0) techniques.unshift(techniques.splice(i,1)[0]); };
  if(bigSurf) boost("freeze the spray");
  if(lowTideNow) boost("wet sand");
  if(overcast) boost("slow the shutter");
  if(nearSunset && cloudy) boost("expose for the sky");
  if(goldenNow) boost("golden hour");
  if(foggy) boost("read the clouds");

  return { headline, sub, techniques };
}

// ---------- helpers ----------
const r1=x=>(x==null||isNaN(x)?null:Math.round(x*10)/10);
function fmtTime(iso){ const m=(iso||"").match(/(\d{1,2}):(\d{2})/); if(!m)return iso; let h=+m[1];const ap=h>=12?"pm":"am";h=h%12||12;return `${h}:${m[2]}${ap}`; }
function hm(iso){ const m=(iso||"").match(/(\d{1,2}):(\d{2})/); return m?(+m[1]*60+ +m[2]):null; }
function min2iso(mins){ const h=Math.floor(mins/60), m=mins%60; return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`; }
function addMin(iso,delta){ const m=(iso||"").match(/T?(\d{1,2}):(\d{2})/); if(!m)return iso; let tot=+m[1]*60+ +m[2]+delta; tot=(tot+1440)%1440; const h=Math.floor(tot/60),mm=tot%60; return `${String(h).padStart(2,"0")}:${String(mm).padStart(2,"0")}`; }
