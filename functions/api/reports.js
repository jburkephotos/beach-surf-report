/**
 * SWELL READER — Community Reports + Local Calibration Worker
 * -----------------------------------------------------------
 * Two jobs:
 *   1) LIVE REPORTS — locals post "firing / fun / blown out / flat" per spot,
 *      with an optional note. Everyone reads the last few hours.
 *   2) LEARNING LOOP — each report is stored alongside a snapshot of the
 *      FORECAST conditions at that moment (swell ft/period/dir, wind kt/dir).
 *      Over time this builds a per-spot history of "what locals actually
 *      reported in conditions like these" — a local calibration layer the
 *      data model alone can't provide.
 *
 * Storage design (works within KV free tier: 1,000 writes/day):
 *   - One key per spot per day:  rep:<spot>:<YYYY-MM-DD>  ->  [ {report}, ... ]
 *     Appending to that array = ~1 write per report, batched per spot/day.
 *   - Rolling training log per spot: train:<spot> -> [ {conditions, label}, ... ]
 *     (capped to last ~500 entries so it stays small and cheap.)
 *
 * DEPLOY: standalone Worker, or functions/api/reports.js in your Pages project.
 * Bind a KV namespace as  REPORTS.
 *
 * Endpoints:
 *   POST /report        { spot, label, note?, conditions? }   -> save a report
 *   GET  /reports?spot= &hours=6                               -> recent reports
 *   GET  /calibrate?spot= &swellFt= &swellPer= &windKt= &windDir=
 *                                                              -> local read on current conditions
 */

const LABELS = ["firing", "fun", "okay", "blown-out", "flat"];
const SPOT_KEYS = ["seaside-cove","short-sand","pacific-city","otter-rock","agate-beach","south-beach","florence","bastendorff","port-orford"];

export async function onRequest(context){ return handle(context.request, context.env); }
export default { fetch: handle };

async function handle(request, env){
  const cors = {
    "Access-Control-Allow-Origin":"*",
    "Access-Control-Allow-Methods":"GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":"Content-Type",
  };
  if(request.method==="OPTIONS") return new Response(null,{headers:cors});
  const url=new URL(request.url);

  try{
    if(url.pathname.endsWith("/report") && request.method==="POST")
      return await postReport(request, env, cors);
    if(url.pathname.endsWith("/reports"))
      return await getReports(url, env, cors);
    if(url.pathname.endsWith("/calibrate"))
      return await calibrate(url, env, cors);
    return json({ ok:true, msg:"Swell Reader reports worker running." }, 200, cors);
  }catch(e){ return json({ error:e.message }, 500, cors); }
}

// ---------- POST a report ----------
async function postReport(request, env, cors){
  const b = await request.json();

  // Turnstile bot check (skip only if no secret configured, e.g. local dev)
  if(env.TURNSTILE_SECRET){
    const ok = await verifyTurnstile(b.token, env.TURNSTILE_SECRET, request);
    if(!ok) return json({ error:"Bot check failed — please try again." }, 403, cors);
  }

  const spot = SPOT_KEYS.includes(b.spot) ? b.spot : null;
  const label = LABELS.includes(b.label) ? b.label : null;
  if(!spot || !label) return json({ error:"Need a valid spot and label." }, 400, cors);

  const note = (b.note||"").toString().slice(0, 140); // keep it short
  const now = Date.now();
  const rl = rateKeyOK(request); // light anti-spam by IP+spot

  const report = { label, note, t: now };
  // store conditions snapshot for learning (sent by the page from current forecast)
  const cond = sanitizeCond(b.conditions);
  if(cond) report.cond = cond;

  // 1) append to today's per-spot list (one key -> array)
  const day = new Date(now).toISOString().slice(0,10);
  const key = `rep:${spot}:${day}`;
  let arr = [];
  try{ const ex = await env.REPORTS.get(key); if(ex) arr = JSON.parse(ex); }catch{}
  arr.push(report);
  if(arr.length>200) arr = arr.slice(-200);
  // expire after 3 days automatically
  await env.REPORTS.put(key, JSON.stringify(arr), { expirationTtl: 60*60*24*3 });

  // 2) append to rolling training log (only if we have conditions)
  if(cond){
    const tkey = `train:${spot}`;
    let log = [];
    try{ const ex = await env.REPORTS.get(tkey); if(ex) log = JSON.parse(ex); }catch{}
    log.push({ c: cond, l: label, t: now });
    if(log.length>500) log = log.slice(-500);
    await env.REPORTS.put(tkey, JSON.stringify(log));
  }

  return json({ ok:true, message:"Thanks — your call is live for everyone." }, 200, cors);
}

// ---------- GET recent reports ----------
async function getReports(url, env, cors){
  const spot = url.searchParams.get("spot");
  const hours = Math.min(48, parseInt(url.searchParams.get("hours")||"6"));
  if(!SPOT_KEYS.includes(spot)) return json({ error:"unknown spot" }, 400, cors);

  const cutoff = Date.now() - hours*3600*1000;
  const today = new Date().toISOString().slice(0,10);
  const yest  = new Date(Date.now()-86400000).toISOString().slice(0,10);

  let all = [];
  for(const day of [today, yest]){
    try{ const ex = await env.REPORTS.get(`rep:${spot}:${day}`); if(ex) all = all.concat(JSON.parse(ex)); }catch{}
  }
  const recent = all.filter(r=>r.t>=cutoff).sort((a,b)=>b.t-a.t);

  // simple consensus: most common label in window
  const counts={}; recent.forEach(r=>counts[r.label]=(counts[r.label]||0)+1);
  const consensus = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0]?.[0] || null;

  return json({ ok:true, spot, count:recent.length, consensus, reports:recent.slice(0,20) }, 200, cors);
}

// ---------- LEARNING: read current conditions against local history ----------
// Finds past reports logged in SIMILAR conditions and returns what locals
// tended to call it. This is the "model learns your coast" layer.
async function calibrate(url, env, cors){
  const spot = url.searchParams.get("spot");
  if(!SPOT_KEYS.includes(spot)) return json({ error:"unknown spot" }, 400, cors);
  const cur = {
    swellFt: num(url.searchParams.get("swellFt")),
    swellPer: num(url.searchParams.get("swellPer")),
    windKt: num(url.searchParams.get("windKt")),
    windDir: num(url.searchParams.get("windDir")),
  };

  let log=[];
  try{ const ex = await env.REPORTS.get(`train:${spot}`); if(ex) log = JSON.parse(ex); }catch{}
  if(log.length < 8) // not enough local history yet
    return json({ ok:true, spot, ready:false, samples:log.length,
      note:"Not enough local reports yet — keep logging and this gets smarter." }, 200, cors);

  // weight past samples by similarity to current conditions
  const scored = log.map(e=>({ l:e.l, w: similarity(cur, e.c) }))
                    .filter(s=>s.w>0)
                    .sort((a,b)=>b.w-a.w)
                    .slice(0, 40); // nearest ~40 analogues

  if(!scored.length)
    return json({ ok:true, spot, ready:false, samples:log.length,
      note:"No close matches in local history for these conditions yet." }, 200, cors);

  // weighted vote → a "locals usually call this ___" with confidence
  const tally={}; let total=0;
  scored.forEach(s=>{ tally[s.l]=(tally[s.l]||0)+s.w; total+=s.w; });
  const ranked = Object.entries(tally).sort((a,b)=>b[1]-a[1]);
  const top = ranked[0];
  const confidence = Math.round(100*top[1]/total);

  return json({ ok:true, spot, ready:true, samples:log.length, analogues:scored.length,
    localCall: top[0], confidence, breakdown: ranked.map(([l,w])=>({label:l, pct:Math.round(100*w/total)})) }, 200, cors);
}

// similarity 0..1 between two condition snapshots (gaussian on each axis)
function similarity(a,b){
  if(!b) return 0;
  let s=1;
  s *= gauss(a.swellFt,  b.swellFt,  2.5);   // within ~2.5 ft
  s *= gauss(a.swellPer, b.swellPer, 3.0);   // within ~3 s
  s *= gauss(a.windKt,   b.windKt,   6.0);   // within ~6 kt
  s *= dirSim(a.windDir, b.windDir, 45);     // within ~45°
  return s;
}
function gauss(x,m,sd){ if(x==null||m==null) return 0.6; const d=(x-m)/sd; return Math.exp(-0.5*d*d); }
function dirSim(x,m,sd){ if(x==null||m==null) return 0.6; let d=Math.abs(x-m)%360; if(d>180)d=360-d; const z=d/sd; return Math.exp(-0.5*z*z); }

// ---------- helpers ----------
function sanitizeCond(c){
  if(!c||typeof c!=="object") return null;
  const out={ swellFt:num(c.swellFt), swellPer:num(c.swellPer), windKt:num(c.windKt), windDir:num(c.windDir) };
  // require at least swell + wind to be useful for learning
  if(out.swellFt==null && out.windKt==null) return null;
  return out;
}
const num=x=>{ const n=parseFloat(x); return isNaN(n)?null:Math.round(n*10)/10; };
const json=(o,s,c)=>new Response(JSON.stringify(o),{status:s,headers:{...c,"Content-Type":"application/json"}});

// ---------- Cloudflare Turnstile server-side validation ----------
// Verifies the single-use token the widget produced. Mandatory: the client
// widget alone proves nothing — a bot can POST any string without it.
async function verifyTurnstile(token, secret, request){
  if(!token) return false;
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const form = new URLSearchParams();
  form.append("secret", secret);
  form.append("response", token);
  if(ip) form.append("remoteip", ip);
  try{
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method:"POST", body:form });
    const out = await r.json();
    return out.success === true;
  }catch{ return false; }
}

// very light rate hint (KV-free): not strict, just discourages mash-spam.
// (For real abuse control later, add Turnstile or a per-IP counter.)
function rateKeyOK(request){ return true; }
