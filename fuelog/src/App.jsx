import { useState, useEffect, useCallback, useRef } from "react";

const USDA_API_KEY = "DOIVgIVffohDzG2bSgYzeTnScZmhb8gC7hfwDEx7";
const USDA_BASE    = "https://api.nal.usda.gov/fdc/v1";
const DB_NAME      = "FuelLogDB";
const DB_VERSION   = 1;

// ── IndexedDB helpers ────────────────────────────────────────────────────────
function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("log"))      db.createObjectStore("log",      { keyPath:"id" });
      if (!db.objectStoreNames.contains("meals"))    db.createObjectStore("meals",    { keyPath:"id" });
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath:"key" });
    };
    req.onsuccess = (e) => res(e.target.result);
    req.onerror   = (e) => rej(e.target.error);
  });
}
async function dbGetAll(store) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction(store, "readonly");
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}
async function dbPut(store, value) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction(store, "readwrite");
    const req = tx.objectStore(store).put(value);
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}
async function dbDelete(store, key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction(store, "readwrite");
    const req = tx.objectStore(store).delete(key);
    req.onsuccess = () => res();
    req.onerror   = () => rej(req.error);
  });
}

// ── Google Sheets sync ───────────────────────────────────────────────────────
async function syncToSheets(webhookUrl, entry) {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method:"POST", mode:"no-cors",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify(entry),
    });
  } catch (e) { console.warn("Sheets sync failed:", e); }
}

// ── Pure helpers ─────────────────────────────────────────────────────────────
const todayKey  = () => new Date().toISOString().slice(0,10);
const isWeekend = (d) => { const w = new Date(d+"T12:00:00").getDay(); return w===0||w===6; };
const fmtDate   = (d) => new Date(d+"T12:00:00").toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"});
const debounce  = (fn,ms) => { let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),ms); }; };

function getNutrient(food, id) {
  const hit = (food.foodNutrients||[]).find(n=>n.nutrientId===id||n.nutrient?.id===id);
  return hit?(hit.value??hit.amount??0):0;
}
function macrosOf(food, grams) {
  const f=grams/100;
  return {
    kcal:    Math.round(getNutrient(food,1008)*f),
    protein: Math.round(getNutrient(food,1003)*f*10)/10,
    carbs:   Math.round(getNutrient(food,1005)*f*10)/10,
    fat:     Math.round(getNutrient(food,1004)*f*10)/10,
    fiber:   Math.round(getNutrient(food,1079)*f*10)/10,
  };
}
function sumMacros(items) {
  return items.reduce((a,e)=>({
    kcal:a.kcal+(e.kcal||0), protein:a.protein+(e.protein||0),
    carbs:a.carbs+(e.carbs||0), fat:a.fat+(e.fat||0), fiber:a.fiber+(e.fiber||0),
  }),{kcal:0,protein:0,carbs:0,fat:0,fiber:0});
}

// ── Derived profile calculations ─────────────────────────────────────────────
function calcProfile(p) {
  const weightKg = p.weightLbs * 0.453592;
  const heightCm = (p.heightFt*12 + p.heightIn) * 2.54;
  const bmr = Math.round(10*weightKg + 6.25*heightCm - 5*p.age + 5);
  const multipliers = { sedentary:1.2, light:1.375, moderate:1.55, active:1.725, veryActive:1.9 };
  const tdee = Math.round(bmr * (multipliers[p.activityLevel]||1.55));
  const deficitPerDay = Math.round((p.lossPerWeek * 3500) / 7);
  const weekdayGoal = tdee - deficitPerDay;
  const weekendGoal = p.zigzag ? Math.round(tdee - deficitPerDay * 0.3) : weekdayGoal;
  const proteinGoal = Math.round(p.weightLbs * (p.proteinMultiplier||1.0));
  const fiberGoal   = p.age <= 50 ? 38 : 30;
  const sleepGoal   = p.age < 26 ? 9 : p.age < 65 ? 8 : 7;
  return { bmr, tdee, deficitPerDay, weekdayGoal, weekendGoal, proteinGoal, fiberGoal, sleepGoal };
}

function goalFor(d, profile) {
  const calc = calcProfile(profile);
  return isWeekend(d) && profile.zigzag ? calc.weekendGoal : calc.weekdayGoal;
}

// ── Default profile ───────────────────────────────────────────────────────────
const DEFAULT_PROFILE = {
  name:"", age:28, weightLbs:195, targetWeightLbs:180,
  heightFt:5, heightIn:11,
  activityLevel:"moderate",
  lossPerWeek:1.5,
  zigzag:true,
  proteinMultiplier:1.0,
  exerciseDaysPerWeek:6,
  sheetsUrl:"",
};

// ── Colors ───────────────────────────────────────────────────────────────────
const C = {
  bg:"#0d0f18", card:"#13162a", border:"#1e2240", accent:"#7c6af7",
  green:"#5eead4", yellow:"#fbbf24", red:"#f87171", pink:"#f472b6",
  blue:"#60a5fa", text:"#e2e4f0", muted:"#6b7280", dim:"#2a2f4a",
};

const S = {
  app:   {fontFamily:"'Inter','Segoe UI',sans-serif",background:C.bg,minHeight:"100vh",color:C.text,paddingBottom:60},
  hdr:   {background:`linear-gradient(135deg,#151828 0%,${C.bg} 100%)`,borderBottom:`1px solid ${C.border}`,padding:"14px 20px",display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:8},
  logo:  {fontSize:18,fontWeight:800,letterSpacing:"-0.5px",display:"flex",alignItems:"center",gap:7},
  tabs:  {display:"flex",gap:2,background:C.card,padding:"3px",borderRadius:11,border:`1px solid ${C.border}`,flexWrap:"wrap"},
  tab:   (a)=>({padding:"5px 11px",borderRadius:8,fontSize:11,fontWeight:600,cursor:"pointer",border:"none",background:a?C.accent:"transparent",color:a?"#fff":C.muted,transition:"all 0.15s",whiteSpace:"nowrap"}),
  main:  {maxWidth:860,margin:"0 auto",padding:"16px 14px 0"},
  card:  {background:C.card,border:`1px solid ${C.border}`,borderRadius:14,padding:"16px 18px",marginBottom:14},
  sec:   {fontSize:10,fontWeight:700,letterSpacing:"0.14em",textTransform:"uppercase",color:C.muted,marginBottom:10},
  row:   {display:"flex",gap:10,flexWrap:"wrap",alignItems:"center"},
  chip:  (c)=>({background:C.bg,borderRadius:10,padding:"9px 12px",flex:1,minWidth:76,textAlign:"center",borderTop:`2px solid ${c}`}),
  cVal:  {fontSize:19,fontWeight:800,fontVariantNumeric:"tabular-nums",lineHeight:1.1},
  cLbl:  {fontSize:10,color:C.muted,marginTop:3,letterSpacing:"0.05em",textTransform:"uppercase"},
  pb:    (h=6)=>({background:C.bg,borderRadius:99,height:h,overflow:"hidden",marginTop:5}),
  inp:   {background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,color:C.text,fontSize:13,padding:"8px 11px",outline:"none",boxSizing:"border-box"},
  lbl:   {fontSize:12,color:C.muted,fontWeight:600,marginBottom:4,display:"block"},
  btn:   (bg=C.accent,fg="#fff")=>({background:bg,color:fg,border:"none",borderRadius:8,fontSize:13,fontWeight:700,padding:"8px 15px",cursor:"pointer"}),
  ghost: {background:"none",border:`1px solid ${C.border}`,borderRadius:8,color:C.muted,fontSize:12,fontWeight:600,padding:"6px 12px",cursor:"pointer"},
  badge: (c)=>({background:c+"22",color:c,borderRadius:6,padding:"2px 7px",fontSize:11,fontWeight:600}),
  modal: {position:"fixed",inset:0,background:"rgba(0,0,0,0.78)",zIndex:200,display:"flex",alignItems:"flex-start",justifyContent:"center",padding:"20px 12px",overflowY:"auto"},
  mBox:  {background:C.card,border:`1px solid ${C.border}`,borderRadius:16,width:"100%",maxWidth:580,padding:"20px 18px"},
  fg:    {marginBottom:14},
};

// ── Ring ─────────────────────────────────────────────────────────────────────
function Ring({pct,size=104,stroke=9,color=C.accent}) {
  const r=(size-stroke)/2,cx=size/2,cy=size/2,circ=2*Math.PI*r;
  const dash=Math.min(pct/100,1)*circ,col=pct>105?C.red:pct>90?C.yellow:color;
  return (
    <svg width={size} height={size} style={{flexShrink:0}}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={C.dim} strokeWidth={stroke}/>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={col} strokeWidth={stroke} strokeLinecap="round"
        strokeDasharray={`${dash} ${circ}`} strokeDashoffset={circ/4} style={{transition:"stroke-dasharray 0.4s"}}/>
      <text x={cx} y={cy-4} textAnchor="middle" fill={col} fontSize="14" fontWeight="800">{Math.round(pct)}%</text>
      <text x={cx} y={cy+11} textAnchor="middle" fill={C.muted} fontSize="10">of goal</text>
    </svg>
  );
}

// ── FoodSearch ───────────────────────────────────────────────────────────────
function FoodSearch({onSelect,placeholder="Search foods…",compact=false}) {
  const [q,setQ]=useState("");
  const [res,setRes]=useState([]);
  const [busy,setBusy]=useState(false);
  const [open,setOpen]=useState(false);
  const ref=useRef(null);
  useEffect(()=>{
    const h=(e)=>{if(ref.current&&!ref.current.contains(e.target))setOpen(false);};
    document.addEventListener("mousedown",h);
    return()=>document.removeEventListener("mousedown",h);
  },[]);
  const search=useCallback(debounce(async(v)=>{
    if(!v.trim()){setRes([]);setOpen(false);return;}
    setBusy(true);
    try{
      const r=await fetch(`${USDA_BASE}/foods/search?query=${encodeURIComponent(v)}&pageSize=14&api_key=${USDA_API_KEY}`);
      const d=await r.json();
      setRes(d.foods||[]);setOpen(true);
    }catch{}finally{setBusy(false);}
  },380),[]);
  const pick=async(food)=>{
    setOpen(false);setQ("");setRes([]);
    try{
      const r=await fetch(`${USDA_BASE}/food/${food.fdcId}?api_key=${USDA_API_KEY}`);
      const detail=await r.json();
      const portions=(detail.foodPortions||[]).map(p=>({label:`${p.amount??1} ${p.modifier||p.measureUnit?.name||"serving"} (${Math.round(p.gramWeight)}g)`,grams:p.gramWeight}));
      portions.unshift({label:"100 g",grams:100});
      onSelect({...detail,_portions:portions});
    }catch{onSelect({...food,_portions:[{label:"100 g",grams:100}]});}
  };
  return (
    <div ref={ref} style={{position:"relative"}}>
      <input value={q} onChange={e=>{setQ(e.target.value);search(e.target.value);}}
        onFocus={()=>res.length&&setOpen(true)}
        placeholder={placeholder}
        style={{...S.inp,width:"100%",fontSize:compact?13:14,padding:compact?"8px 11px":"11px 14px"}}/>
      {open&&(
        <div style={{position:"absolute",top:"calc(100% + 5px)",left:0,right:0,background:"#1a1e38",border:`1px solid ${C.border}`,borderRadius:10,zIndex:150,maxHeight:260,overflowY:"auto",boxShadow:"0 8px 28px rgba(0,0,0,0.6)"}}>
          {busy&&<div style={{padding:"11px 14px",fontSize:13,color:C.muted}}>Searching…</div>}
          {res.map(f=>(
            <div key={f.fdcId} onClick={()=>pick(f)}
              style={{padding:"9px 14px",cursor:"pointer",borderBottom:`1px solid ${C.dim}`}}
              onMouseEnter={e=>e.currentTarget.style.background="#252a45"}
              onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
              <div style={{fontSize:13,fontWeight:500}}>{f.description}</div>
              <div style={{fontSize:11,color:C.muted}}>{f.brandOwner?`${f.brandOwner} · `:""}{Math.round(getNutrient(f,1008))} kcal/100g</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MacroRow({macros}) {
  return (
    <div style={{display:"flex",gap:12,flexWrap:"wrap",fontSize:12,marginTop:6}}>
      {[["Cal",macros.kcal,"",C.accent],["Pro",macros.protein,"g",C.blue],["Carb",macros.carbs,"g",C.yellow],["Fat",macros.fat,"g",C.pink],["Fib",macros.fiber,"g",C.green]].map(([l,v,u,c])=>(
        <span key={l} style={{color:C.muted}}>{l}: <strong style={{color:c}}>{v}{u}</strong></span>
      ))}
    </div>
  );
}

// ── Meal Builder Modal ────────────────────────────────────────────────────────
function MealBuilderModal({existing,onSave,onClose}) {
  const [name,setName]=useState(existing?.name||"");
  const [items,setItems]=useState(existing?.items||[]);
  const [pending,setPending]=useState(null);
  const [pSIdx,setPSIdx]=useState(0);
  const [pQty,setPQty]=useState(1);
  const addPending=()=>{
    if(!pending)return;
    const portions=pending._portions||[{label:"100 g",grams:100}];
    const grams=(portions[pSIdx]?.grams||100)*pQty;
    setItems(prev=>[...prev,{id:Date.now(),name:pending.description,serving:portions[pSIdx]?.label||"100g",grams,qty:pQty,...macrosOf(pending,grams)}]);
    setPending(null);setPSIdx(0);setPQty(1);
  };
  const totals=sumMacros(items);
  const canSave=name.trim()&&items.length>0;
  return (
    <div style={S.modal} onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={S.mBox}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
          <div style={{fontSize:15,fontWeight:800}}>{existing?"Edit Meal":"New Meal"}</div>
          <button onClick={onClose} style={{background:"none",border:"none",color:C.muted,fontSize:20,cursor:"pointer"}}>✕</button>
        </div>
        <input value={name} onChange={e=>setName(e.target.value)} placeholder="Meal name (e.g. Post-Climb Protein Bowl)"
          style={{...S.inp,width:"100%",marginBottom:12,fontSize:14}}/>
        <div style={{...S.sec,marginBottom:8}}>Add Ingredients</div>
        <FoodSearch onSelect={f=>{setPending(f);setPSIdx(0);setPQty(1);}} placeholder="Search ingredient…" compact/>
        {pending&&(
          <div style={{background:C.bg,borderRadius:10,padding:"11px 12px",marginTop:10,border:`1px solid ${C.border}`}}>
            <div style={{fontSize:13,fontWeight:600,marginBottom:7}}>{pending.description}</div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
              <select value={pSIdx} onChange={e=>setPSIdx(Number(e.target.value))} style={{...S.inp,flex:3,minWidth:110}}>
                {(pending._portions||[{label:"100 g",grams:100}]).map((s,i)=><option key={i} value={i}>{s.label}</option>)}
              </select>
              <input type="number" min="0.25" step="0.25" value={pQty} onChange={e=>setPQty(Math.max(0.25,parseFloat(e.target.value)||1))} style={{...S.inp,width:66}}/>
              <button onClick={addPending} style={S.btn()}>Add</button>
              <button onClick={()=>setPending(null)} style={S.ghost}>Cancel</button>
            </div>
            <MacroRow macros={macrosOf(pending,(pending._portions?.[pSIdx]?.grams||100)*pQty)}/>
          </div>
        )}
        {items.length>0&&(
          <div style={{marginTop:12}}>
            <div style={S.sec}>Ingredients ({items.length})</div>
            {items.map(it=>(
              <div key={it.id} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 0",borderBottom:`1px solid ${C.dim}`}}>
                <div style={{flex:1}}><div style={{fontSize:13,fontWeight:500}}>{it.name}</div><div style={{fontSize:11,color:C.muted}}>{it.qty!==1?`${it.qty}× `:""}{it.serving}</div></div>
                <div style={{fontSize:13,fontWeight:700,color:C.accent,minWidth:44,textAlign:"right"}}>{it.kcal} kcal</div>
                <div style={{fontSize:11,color:C.blue,minWidth:36,textAlign:"right"}}>{it.protein}g</div>
                <button onClick={()=>setItems(p=>p.filter(i=>i.id!==it.id))} style={{background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:14,padding:"0 3px"}}>✕</button>
              </div>
            ))}
            <div style={{padding:"8px 0 2px",display:"flex",justifyContent:"space-between",fontSize:12}}>
              <span style={{color:C.muted,fontWeight:600}}>TOTAL</span>
              <div style={{display:"flex",gap:12}}>
                <span style={{color:C.accent,fontWeight:700}}>{totals.kcal} kcal</span>
                <span style={{color:C.blue}}>{totals.protein}g pro</span>
                <span style={{color:C.yellow}}>{totals.carbs}g carb</span>
                <span style={{color:C.pink}}>{totals.fat}g fat</span>
              </div>
            </div>
          </div>
        )}
        <div style={{display:"flex",gap:8,marginTop:16}}>
          <button onClick={()=>canSave&&onSave({id:existing?.id||Date.now(),name:name.trim(),items,createdAt:existing?.createdAt||Date.now()})}
            style={{...S.btn(canSave?C.accent:C.dim),flex:1,opacity:canSave?1:0.5}}>
            {existing?"Save Changes":"Save Meal"}
          </button>
          <button onClick={onClose} style={S.ghost}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ── Settings Panel ────────────────────────────────────────────────────────────
function SettingsPanel({profile,onSave,onClose}) {
  const [p,setP]=useState({...profile});
  const set=(k,v)=>setP(prev=>({...prev,[k]:v}));
  const calc=calcProfile(p);
  const Field=({label,children})=>(
    <div style={S.fg}><label style={S.lbl}>{label}</label>{children}</div>
  );
  return (
    <div style={S.modal} onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{...S.mBox,maxWidth:520}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <div style={{fontSize:15,fontWeight:800}}>Profile & Settings</div>
          <button onClick={onClose} style={{background:"none",border:"none",color:C.muted,fontSize:20,cursor:"pointer"}}>✕</button>
        </div>

        <div style={{...S.sec}}>Personal Info</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
          <Field label="Name (optional)">
            <input value={p.name} onChange={e=>set("name",e.target.value)} style={{...S.inp,width:"100%"}} placeholder="Mel"/>
          </Field>
          <Field label="Age">
            <input type="number" value={p.age} onChange={e=>set("age",parseInt(e.target.value)||28)} style={{...S.inp,width:"100%"}}/>
          </Field>
          <Field label="Current Weight (lbs)">
            <input type="number" value={p.weightLbs} onChange={e=>set("weightLbs",parseFloat(e.target.value)||195)} style={{...S.inp,width:"100%"}}/>
          </Field>
          <Field label="Goal Weight (lbs)">
            <input type="number" value={p.targetWeightLbs} onChange={e=>set("targetWeightLbs",parseFloat(e.target.value)||180)} style={{...S.inp,width:"100%"}}/>
          </Field>
          <Field label="Height (ft)">
            <input type="number" value={p.heightFt} onChange={e=>set("heightFt",parseInt(e.target.value)||5)} style={{...S.inp,width:"100%"}}/>
          </Field>
          <Field label='Height (in remaining)'>
            <input type="number" min="0" max="11" value={p.heightIn} onChange={e=>set("heightIn",parseInt(e.target.value)||0)} style={{...S.inp,width:"100%"}}/>
          </Field>
        </div>

        <div style={S.sec}>Activity & Goals</div>
        <Field label="Activity Level">
          <select value={p.activityLevel} onChange={e=>set("activityLevel",e.target.value)} style={{...S.inp,width:"100%"}}>
            <option value="sedentary">Sedentary (desk job, no exercise)</option>
            <option value="light">Light (1–3 days/week)</option>
            <option value="moderate">Moderate (3–5 days/week)</option>
            <option value="active">Active (6–7 days hard training)</option>
            <option value="veryActive">Very Active (athlete / physical job)</option>
          </select>
        </Field>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
          <Field label="Exercise Days/Week">
            <input type="number" min="0" max="7" value={p.exerciseDaysPerWeek} onChange={e=>set("exerciseDaysPerWeek",parseInt(e.target.value)||0)} style={{...S.inp,width:"100%"}}/>
          </Field>
          <Field label="Target Loss (lbs/week)">
            <select value={p.lossPerWeek} onChange={e=>set("lossPerWeek",parseFloat(e.target.value))} style={{...S.inp,width:"100%"}}>
              <option value={0.5}>0.5 lbs/week (gentle)</option>
              <option value={1.0}>1.0 lbs/week (moderate)</option>
              <option value={1.5}>1.5 lbs/week (aggressive)</option>
              <option value={2.0}>2.0 lbs/week (max safe)</option>
            </select>
          </Field>
          <Field label="Protein Multiplier (g/lb)">
            <select value={p.proteinMultiplier} onChange={e=>set("proteinMultiplier",parseFloat(e.target.value))} style={{...S.inp,width:"100%"}}>
              <option value={0.7}>0.7 g/lb (minimum)</option>
              <option value={0.8}>0.8 g/lb (standard)</option>
              <option value={1.0}>1.0 g/lb (high — muscle preservation)</option>
              <option value={1.2}>1.2 g/lb (athlete)</option>
            </select>
          </Field>
          <Field label="Zigzag (higher weekends)">
            <select value={p.zigzag?"yes":"no"} onChange={e=>set("zigzag",e.target.value==="yes")} style={{...S.inp,width:"100%"}}>
              <option value="yes">Yes — cycle calories</option>
              <option value="no">No — same every day</option>
            </select>
          </Field>
        </div>

        {/* Live preview */}
        <div style={{background:C.bg,borderRadius:10,padding:"12px 14px",marginBottom:14,border:`1px solid ${C.border}`}}>
          <div style={{...S.sec,marginBottom:8}}>Calculated Targets Preview</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,fontSize:12}}>
            {[["BMR",calc.bmr+" kcal"],["TDEE",calc.tdee+" kcal"],["Daily Deficit",calc.deficitPerDay+" kcal"],["Weekday Goal",calc.weekdayGoal+" kcal"],["Weekend Goal",calc.weekendGoal+" kcal"],["Protein Target",calc.proteinGoal+"g/day"],["Fiber Target",calc.fiberGoal+"g/day"],["Sleep Target",calc.sleepGoal+"h/night"]].map(([l,v])=>(
              <div key={l} style={{display:"flex",justifyContent:"space-between",padding:"4px 0",borderBottom:`1px solid ${C.dim}`}}>
                <span style={{color:C.muted}}>{l}</span><span style={{fontWeight:700,color:C.accent}}>{v}</span>
              </div>
            ))}
          </div>
        </div>

        <div style={S.sec}>Google Sheets Sync</div>
        <Field label="Apps Script Web App URL">
          <input value={p.sheetsUrl} onChange={e=>set("sheetsUrl",e.target.value)}
            style={{...S.inp,width:"100%"}} placeholder="https://script.google.com/macros/s/…/exec"/>
        </Field>
        <div style={{fontSize:11,color:C.muted,marginBottom:14}}>Paste your Google Apps Script URL here to auto-sync every logged entry to your Google Sheet. See the Setup Guide for instructions.</div>

        <button onClick={()=>onSave(p)} style={{...S.btn(),width:"100%",fontSize:14,padding:"10px"}}>Save Profile</button>
      </div>
    </div>
  );
}

// ── CSV Export ────────────────────────────────────────────────────────────────
function exportCSV(logEntries) {
  const headers = ["Date","Day Type","Meal Slot","Food","Serving","Qty","Calories","Protein(g)","Carbs(g)","Fat(g)","Fiber(g)"];
  const rows = logEntries.map(e=>[
    e.date, isWeekend(e.date)?"Weekend":"Weekday", e.meal||"",
    `"${(e.name||"").replace(/"/g,'""')}"`,
    `"${(e.serving||"").replace(/"/g,'""')}"`,
    e.qty||1, e.kcal||0, e.protein||0, e.carbs||0, e.fat||0, e.fiber||0,
  ]);
  const csv = [headers, ...rows].map(r=>r.join(",")).join("\n");
  const blob = new Blob([csv],{type:"text/csv"});
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href=url; a.download=`fuelog_export_${todayKey()}.csv`; a.click();
  URL.revokeObjectURL(url);
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function FuelLog() {
  const [tab,setTab]             = useState("today");
  const [profile,setProfile]     = useState(DEFAULT_PROFILE);
  const [logMap,setLogMap]       = useState({});    // {date: [entries]}
  const [savedMeals,setSavedMeals] = useState([]);
  const [dbReady,setDbReady]     = useState(false);
  const [showSettings,setShowSettings] = useState(false);
  const [showBuilder,setShowBuilder]   = useState(false);
  const [editMeal,setEditMeal]         = useState(null);
  const [quickLog,setQuickLog]         = useState(null);
  const [syncStatus,setSyncStatus]     = useState(null); // "syncing"|"ok"|"fail"

  // food add state
  const [selFood,setSelFood]   = useState(null);
  const [servings,setServings] = useState([]);
  const [sIdx,setSIdx]         = useState(0);
  const [qty,setQty]           = useState(1);
  const [mealSlot,setMealSlot] = useState("Lunch");
  const [qlSlot,setQlSlot]     = useState("Lunch");

  // ── Load from IndexedDB on mount ──
  useEffect(()=>{
    (async()=>{
      try {
        const [logRows, mealRows, settingRows] = await Promise.all([
          dbGetAll("log"), dbGetAll("meals"), dbGetAll("settings"),
        ]);
        // Rebuild logMap
        const map={};
        for(const row of logRows){
          if(!map[row.date]) map[row.date]=[];
          map[row.date].push(row);
        }
        setLogMap(map);
        setSavedMeals(mealRows);
        const prof = settingRows.find(s=>s.key==="profile");
        if(prof) setProfile({...DEFAULT_PROFILE,...prof.value});
        setDbReady(true);
      } catch(e) {
        console.error("DB load error",e);
        setDbReady(true);
      }
    })();
  },[]);

  const calc = calcProfile(profile);

  const saveProfile = async(p) => {
    setProfile(p);
    await dbPut("settings",{key:"profile",value:p});
    setShowSettings(false);
  };

  // ── Add single food entry ──
  const handleFoodSelect = (food) => {
    const portions = food._portions||[{label:"100 g",grams:100}];
    setServings(portions); setSIdx(0); setQty(1); setSelFood(food);
  };

  const preview = (()=>{
    if(!selFood||!servings.length) return null;
    const grams=(servings[sIdx]?.grams||100)*qty;
    return{...macrosOf(selFood,grams),grams:Math.round(grams),serving:servings[sIdx]?.label||"100g"};
  })();

  const addEntry = async() => {
    if(!selFood||!preview) return;
    const entry={
      id:Date.now(), date:todayKey(), meal:mealSlot,
      name:selFood.description, serving:preview.serving, qty,
      kcal:preview.kcal, protein:preview.protein, carbs:preview.carbs, fat:preview.fat, fiber:preview.fiber,
    };
    await dbPut("log",entry);
    setLogMap(prev=>{const d=entry.date;return{...prev,[d]:[...(prev[d]||[]),entry]};});
    setSelFood(null); setServings([]);
    doSheetSync(entry);
  };

  const removeEntry = async(date,id) => {
    await dbDelete("log",id);
    setLogMap(prev=>({...prev,[date]:prev[date].filter(e=>e.id!==id)}));
  };

  // ── Log saved meal ──
  const logSavedMeal = async(meal, slot) => {
    const date=todayKey();
    const entries=meal.items.map(it=>({
      id:Date.now()+Math.random(), date, meal:slot,
      name:it.name, serving:it.serving, qty:it.qty,
      kcal:it.kcal, protein:it.protein, carbs:it.carbs, fat:it.fat, fiber:it.fiber||0,
    }));
    for(const e of entries){ await dbPut("log",e); doSheetSync(e); }
    setLogMap(prev=>({...prev,[date]:[...(prev[date]||[]),...entries]}));
    setQuickLog(null);
  };

  // ── Meals CRUD ──
  const saveMeal = async(meal) => {
    await dbPut("meals",meal);
    setSavedMeals(prev=>{const idx=prev.findIndex(m=>m.id===meal.id);return idx>=0?prev.map((m,i)=>i===idx?meal:m):[...prev,meal];});
    setShowBuilder(false); setEditMeal(null);
  };
  const deleteMeal = async(id) => {
    await dbDelete("meals",id);
    setSavedMeals(prev=>prev.filter(m=>m.id!==id));
  };

  // ── Google Sheets sync ──
  const doSheetSync = async(entry) => {
    if(!profile.sheetsUrl) return;
    setSyncStatus("syncing");
    try{
      await syncToSheets(profile.sheetsUrl,entry);
      setSyncStatus("ok"); setTimeout(()=>setSyncStatus(null),2500);
    }catch{setSyncStatus("fail"); setTimeout(()=>setSyncStatus(null),3000);}
  };

  // ── Derived ──
  const today      = todayKey();
  const todayGoal  = goalFor(today, profile);
  const todayLog   = logMap[today]||[];
  const totals     = sumMacros(todayLog);
  const remaining  = todayGoal - totals.kcal;
  const pct        = todayGoal>0?(totals.kcal/todayGoal)*100:0;
  const proteinPct = calc.proteinGoal>0?(totals.protein/calc.proteinGoal)*100:0;

  const SLOTS = ["Breakfast","Lunch","Dinner","Snack"];
  const bySlot = SLOTS.reduce((a,m)=>({...a,[m]:todayLog.filter(e=>e.meal===m)}),{});

  const weekDays    = Array.from({length:7},(_,i)=>{const d=new Date();d.setDate(d.getDate()-6+i);return d.toISOString().slice(0,10);});
  const weekKcal    = weekDays.map(d=>(logMap[d]||[]).reduce((s,e)=>s+e.kcal,0));
  const weeklyTotal = weekKcal.reduce((a,b)=>a+b,0);
  const weeklyGoal  = weekDays.reduce((s,d)=>s+goalFor(d,profile),0);
  const weeklyDef   = weeklyGoal - weeklyTotal;
  const lbsLeft     = Math.max(0,profile.weightLbs-profile.targetWeightLbs);
  const daysToGoal  = lbsLeft>0?Math.round((lbsLeft*3500)/Math.max(calc.deficitPerDay,1)):0;
  const goalDateStr = (()=>{const d=new Date();d.setDate(d.getDate()+daysToGoal);return d.toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"});})();
  const streak      = (()=>{let s=0,d=new Date();while((logMap[d.toISOString().slice(0,10)]||[]).length>0){s++;d.setDate(d.getDate()-1);}return s;})();
  const pastDays    = Object.keys(logMap).filter(d=>d!==today).sort((a,b)=>b.localeCompare(a)).slice(0,14);
  const allEntries  = Object.values(logMap).flat().sort((a,b)=>b.date.localeCompare(a.date));

  // ── Personalized tips ──
  const tips = [
    {icon:"🥩",title:"Protein Target",text:`Based on your weight of ${profile.weightLbs} lbs and a ${profile.proteinMultiplier}g/lb multiplier, aim for ${calc.proteinGoal}g protein daily. This is the #1 lever for preserving muscle during your cut.`},
    {icon:"⚡",title:"Zigzag Strategy",text:profile.zigzag?`Your ${calc.weekdayGoal} kcal weekdays and ${calc.weekendGoal} kcal weekends cycle your intake to prevent metabolic adaptation and refuel glycogen before hard sessions.`:`You're eating ${calc.weekdayGoal} kcal every day. Consider enabling zigzag in settings to add refeed days and prevent adaptation.`},
    {icon:"💧",title:"Hydration",text:`At ${profile.weightLbs} lbs, aim for at least ${Math.round(profile.weightLbs*0.5)} oz of water daily (~${Math.round(profile.weightLbs*0.5/8)} cups). Drink 16 oz before meals to reduce intake by up to 13%.`},
    {icon:"😴",title:"Sleep",text:`At age ${profile.age} with ${profile.exerciseDaysPerWeek} exercise days/week, you need ${calc.sleepGoal}h sleep minimum. With heavy training, aim for the upper end — poor sleep raises ghrelin and adds ~300 kcal of hunger the next day.`},
    {icon:"🏋️",title:"Training in a Deficit",text:`With ${profile.exerciseDaysPerWeek} training days/week and a ${calc.deficitPerDay} kcal/day deficit, keep lifting heavy. If your strength is holding, your muscle is protected.`},
    {icon:"📊",title:"Track Everything",text:`You're targeting ${calc.weekdayGoal} kcal on weekdays. Research shows people underestimate intake by 20–50% — oils, sauces, and drinks are the most common hidden sources.`},
    {icon:"🔄",title:"Diet Breaks",text:`After 6–8 weeks of your current ${profile.lossPerWeek} lbs/week deficit, consider a 1–2 week break at ${calc.tdee} kcal maintenance to restore leptin and sustain long-term adherence.`},
  ];
  const tip = tips[new Date().getDay()%tips.length];

  // ── RENDER TODAY ──────────────────────────────────────────────────────────
  const renderToday = () => (
    <>
      <div style={S.card}>
        <div style={S.sec}>{fmtDate(today)} · {isWeekend(today)&&profile.zigzag?"Weekend Refeed 🔄":"Weekday Cut ✂️"}</div>
        <div style={{display:"flex",gap:16,alignItems:"center",flexWrap:"wrap"}}>
          <Ring pct={pct}/>
          <div style={{flex:1,minWidth:150}}>
            <div style={{fontSize:36,fontWeight:900,color:C.accent,lineHeight:1}}>{totals.kcal.toLocaleString()}</div>
            <div style={{fontSize:12,color:C.muted,marginBottom:7}}>kcal of <strong style={{color:C.text}}>{todayGoal.toLocaleString()}</strong> goal</div>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:13,marginBottom:3}}>
              <span style={{color:C.muted}}>Remaining</span>
              <span style={{fontWeight:700,color:remaining>=0?C.green:C.red}}>{remaining>=0?remaining:Math.abs(remaining)+" over"} kcal</span>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:12}}>
              <span style={{color:C.muted}}>TDEE · Deficit</span>
              <span style={{color:C.muted}}>{calc.tdee} · {calc.deficitPerDay} kcal</span>
            </div>
          </div>
        </div>
        <div style={{...S.row,marginTop:12}}>
          {[{l:"Protein",v:totals.protein,u:"g",g:calc.proteinGoal,c:C.blue},{l:"Carbs",v:totals.carbs,u:"g",g:null,c:C.yellow},{l:"Fat",v:totals.fat,u:"g",g:null,c:C.pink},{l:"Fiber",v:totals.fiber,u:"g",g:calc.fiberGoal,c:C.green}].map(m=>(
            <div key={m.l} style={S.chip(m.c)}>
              <div style={{...S.cVal,color:m.c}}>{m.v.toFixed(1)}{m.u}</div>
              {m.g&&<div style={{fontSize:10,color:C.muted}}>/{m.g}{m.u}</div>}
              <div style={S.cLbl}>{m.l}</div>
              {m.g&&<div style={S.pb()}><div style={{height:"100%",width:`${Math.min((m.v/m.g)*100,100)}%`,background:m.c,borderRadius:99,transition:"width 0.4s"}}/></div>}
            </div>
          ))}
        </div>
        {proteinPct<60&&<div style={{marginTop:10,background:"#60a5fa11",border:"1px solid #60a5fa33",borderRadius:8,padding:"9px 12px",fontSize:13,color:C.blue}}>⚠️ <strong>Protein low ({totals.protein}g / {calc.proteinGoal}g target).</strong> Prioritize lean protein at your next meal.</div>}
      </div>

      {/* Add Food */}
      <div style={S.card}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
          <div style={S.sec}>Add Food</div>
          <div style={{display:"flex",gap:6,alignItems:"center"}}>
            {syncStatus&&<span style={{fontSize:11,color:syncStatus==="ok"?C.green:syncStatus==="fail"?C.red:C.yellow}}>{syncStatus==="syncing"?"↑ syncing…":syncStatus==="ok"?"✓ synced":"⚠ sync failed"}</span>}
            <button onClick={()=>setTab("meals")} style={{...S.ghost,fontSize:11}}>📋 My Meals</button>
          </div>
        </div>
        <FoodSearch onSelect={handleFoodSelect} placeholder="Search any food, brand, or ingredient…"/>
        {selFood&&servings.length>0&&(
          <div style={{marginTop:10}}>
            <div style={{...S.row,gap:8}}>
              <select value={sIdx} onChange={e=>setSIdx(Number(e.target.value))} style={{...S.inp,flex:3,minWidth:110}}>
                {servings.map((s,i)=><option key={i} value={i}>{s.label}</option>)}
              </select>
              <input type="number" min="0.25" step="0.25" value={qty} onChange={e=>setQty(Math.max(0.25,parseFloat(e.target.value)||1))} style={{...S.inp,width:66}}/>
              <select value={mealSlot} onChange={e=>setMealSlot(e.target.value)} style={{...S.inp,minWidth:88}}>
                {SLOTS.map(m=><option key={m}>{m}</option>)}
              </select>
              <button onClick={addEntry} style={S.btn()}>+ Add</button>
            </div>
            {preview&&<MacroRow macros={preview}/>}
          </div>
        )}
        {savedMeals.length>0&&(
          <div style={{marginTop:14}}>
            <div style={{...S.sec,marginBottom:8}}>Quick-Log Saved Meal</div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              {savedMeals.map(m=>{const mt=sumMacros(m.items);return(
                <div key={m.id} onClick={()=>{setQuickLog(m);setQlSlot("Lunch");}}
                  style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:10,padding:"9px 12px",cursor:"pointer",minWidth:120,flex:1,maxWidth:180}}
                  onMouseEnter={e=>e.currentTarget.style.borderColor=C.accent}
                  onMouseLeave={e=>e.currentTarget.style.borderColor=C.border}>
                  <div style={{fontSize:13,fontWeight:600,marginBottom:3}}>{m.name}</div>
                  <div style={{fontSize:11,color:C.accent,fontWeight:700}}>{mt.kcal} kcal</div>
                  <div style={{fontSize:10,color:C.muted}}>{m.items.length} item{m.items.length!==1?"s":""} · {mt.protein}g pro</div>
                </div>
              );})}
            </div>
          </div>
        )}
      </div>

      {/* Log */}
      <div style={S.card}>
        <div style={S.sec}>Today's Log</div>
        {todayLog.length===0?<div style={{fontSize:13,color:C.dim,textAlign:"center",padding:"14px 0"}}>Nothing logged yet.</div>:(
          SLOTS.map(m=>bySlot[m].length>0&&(
            <div key={m} style={{marginBottom:12}}>
              <div style={{fontSize:11,fontWeight:700,color:C.muted,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:5}}>
                {m} · {bySlot[m].reduce((s,e)=>s+e.kcal,0)} kcal
              </div>
              {bySlot[m].map(e=>(
                <div key={e.id} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 0",borderBottom:`1px solid ${C.dim}`}}>
                  <span style={{flex:1,fontSize:13}}>{e.name}</span>
                  <span style={{fontSize:11,color:C.muted,minWidth:64}}>{e.qty!==1?`${e.qty}× `:""}{e.serving}</span>
                  <span style={{fontSize:13,fontWeight:700,color:C.accent,minWidth:42,textAlign:"right"}}>{e.kcal}</span>
                  <span style={{fontSize:11,color:C.blue,minWidth:34,textAlign:"right"}}>{e.protein}g</span>
                  <button onClick={()=>removeEntry(today,e.id)} style={{background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:13,padding:"0 2px"}}>✕</button>
                </div>
              ))}
            </div>
          ))
        )}
      </div>

      {/* Tip */}
      <div style={{...S.card,borderColor:C.accent+"44",background:`linear-gradient(135deg,${C.card} 0%,#1a1628 100%)`}}>
        <div style={S.sec}>Personalized Tip</div>
        <div style={{display:"flex",gap:12,alignItems:"flex-start"}}>
          <span style={{fontSize:26}}>{tip.icon}</span>
          <div><div style={{fontWeight:700,fontSize:14,marginBottom:4}}>{tip.title}</div><div style={{fontSize:13,color:C.muted,lineHeight:1.6}}>{tip.text}</div></div>
        </div>
      </div>
    </>
  );

  // ── RENDER MEALS ──────────────────────────────────────────────────────────
  const renderMeals = () => (
    <>
      <div style={{...S.card,background:`linear-gradient(135deg,${C.card},#1a1628)`}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div><div style={{fontSize:16,fontWeight:800,marginBottom:3}}>My Meals</div><div style={{fontSize:13,color:C.muted}}>Build reusable meals and log them instantly.</div></div>
          <button onClick={()=>{setEditMeal(null);setShowBuilder(true);}} style={{...S.btn(),whiteSpace:"nowrap",marginLeft:10}}>+ New Meal</button>
        </div>
      </div>
      {savedMeals.length===0?(
        <div style={{...S.card,textAlign:"center",padding:"30px 20px"}}>
          <div style={{fontSize:30,marginBottom:10}}>🍽️</div>
          <div style={{fontSize:15,fontWeight:700,marginBottom:6}}>No saved meals yet</div>
          <div style={{fontSize:13,color:C.muted,marginBottom:14}}>Create meals like "Post-Climb Bowl" or "Weekday Breakfast" and log them in one tap.</div>
          <button onClick={()=>{setEditMeal(null);setShowBuilder(true);}} style={S.btn()}>Create Your First Meal</button>
        </div>
      ):(
        savedMeals.map(meal=>{
          const mt=sumMacros(meal.items);
          return (
            <div key={meal.id} style={S.card}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
                <div><div style={{fontSize:15,fontWeight:700}}>{meal.name}</div><div style={{fontSize:12,color:C.muted,marginTop:2}}>{meal.items.length} ingredient{meal.items.length!==1?"s":""}</div></div>
                <div style={{display:"flex",gap:6}}>
                  <button onClick={()=>{setEditMeal(meal);setShowBuilder(true);}} style={S.ghost}>Edit</button>
                  <button onClick={()=>deleteMeal(meal.id)} style={{...S.ghost,color:C.red,borderColor:C.red+"44"}}>Delete</button>
                </div>
              </div>
              <div style={{...S.row,marginBottom:10}}>
                {[{l:"Cal",v:mt.kcal,c:C.accent},{l:"Protein",v:mt.protein+"g",c:C.blue},{l:"Carbs",v:mt.carbs+"g",c:C.yellow},{l:"Fat",v:mt.fat+"g",c:C.pink}].map(m=>(
                  <div key={m.l} style={{background:C.bg,borderRadius:8,padding:"7px 10px",textAlign:"center",flex:1,minWidth:52}}>
                    <div style={{fontSize:15,fontWeight:800,color:m.c}}>{m.v}</div>
                    <div style={{fontSize:10,color:C.muted,marginTop:2}}>{m.l}</div>
                  </div>
                ))}
              </div>
              {meal.items.map(it=>(
                <div key={it.id} style={{display:"flex",alignItems:"center",gap:8,padding:"5px 0",borderTop:`1px solid ${C.dim}`}}>
                  <span style={{flex:1,fontSize:12}}>{it.name}</span>
                  <span style={{fontSize:11,color:C.muted}}>{it.qty!==1?`${it.qty}× `:""}{it.serving}</span>
                  <span style={{fontSize:12,fontWeight:600,color:C.accent,minWidth:40,textAlign:"right"}}>{it.kcal} kcal</span>
                </div>
              ))}
              <div style={{display:"flex",gap:6,marginTop:12,alignItems:"center",flexWrap:"wrap"}}>
                <span style={{fontSize:12,color:C.muted}}>Log to:</span>
                {SLOTS.map(slot=>(
                  <button key={slot} onClick={()=>logSavedMeal(meal,slot)}
                    style={{...S.btn(C.dim+"88"),fontSize:11,padding:"5px 10px",border:`1px solid ${C.border}`}}
                    onMouseEnter={e=>e.currentTarget.style.background=C.accent}
                    onMouseLeave={e=>e.currentTarget.style.background=C.dim+"88"}>
                    {slot}
                  </button>
                ))}
              </div>
            </div>
          );
        })
      )}
    </>
  );

  // ── RENDER WEEK ───────────────────────────────────────────────────────────
  const renderWeek = () => {
    const maxK=Math.max(...weekKcal,500);
    return (
      <>
        <div style={S.card}>
          <div style={S.sec}>7-Day Overview</div>
          <div style={{...S.row,marginBottom:14}}>
            {[{l:"Week Total",v:weeklyTotal.toLocaleString()+" kcal",c:C.accent},{l:"Week Goal",v:weeklyGoal.toLocaleString()+" kcal",c:C.muted},{l:"Net Deficit",v:(weeklyDef>=0?"+":"")+weeklyDef.toLocaleString()+" kcal",c:weeklyDef>=0?C.green:C.red},{l:"Est. Loss",v:(weeklyDef/3500>=0?"+":"")+(weeklyDef/3500).toFixed(2)+" lbs",c:weeklyDef>=0?C.green:C.red}].map(c=>(
              <div key={c.l} style={{...S.chip(c.c),minWidth:86}}><div style={{...S.cVal,fontSize:14,color:c.c}}>{c.v}</div><div style={S.cLbl}>{c.l}</div></div>
            ))}
          </div>
          <div style={{display:"flex",gap:5,alignItems:"flex-end",height:110,padding:"0 2px"}}>
            {weekDays.map((d,i)=>{
              const kcal=weekKcal[i],goal=goalFor(d,profile),h=kcal?(kcal/maxK)*100:2,over=kcal>goal,isT=d===today,we=isWeekend(d);
              return (
                <div key={d} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
                  <div style={{fontSize:9,color:over?C.red:C.muted,fontWeight:600}}>{kcal||""}</div>
                  <div style={{flex:1,width:"100%",display:"flex",flexDirection:"column",justifyContent:"flex-end"}}>
                    <div style={{height:`${h}%`,minHeight:3,borderRadius:"3px 3px 0 0",background:isT?C.accent:over?C.red:we?C.yellow:C.green,opacity:isT?1:0.75,transition:"height 0.4s"}}/>
                    <div style={{height:1,background:C.dim}}/>
                  </div>
                  <div style={{fontSize:9,color:isT?C.accent:C.muted,fontWeight:isT?700:400}}>{new Date(d+"T12:00:00").toLocaleDateString("en-US",{weekday:"short"}).slice(0,2)}</div>
                </div>
              );
            })}
          </div>
          <div style={{fontSize:11,color:C.muted,marginTop:8}}><span style={{color:C.green}}>■</span> Weekday &nbsp;<span style={{color:C.yellow}}>■</span> Weekend &nbsp;<span style={{color:C.red}}>■</span> Over &nbsp;<span style={{color:C.accent}}>■</span> Today</div>
        </div>
        <div style={S.card}>
          <div style={S.sec}>Goal Projection</div>
          <div style={{...S.row,gap:14}}>
            <div style={{flex:1}}>
              <div style={{fontSize:26,fontWeight:900,color:C.green}}>{goalDateStr}</div>
              <div style={{fontSize:13,color:C.muted,marginTop:3}}>Projected date to reach <strong style={{color:C.text}}>{profile.targetWeightLbs} lbs</strong></div>
              <div style={{fontSize:12,color:C.muted,marginTop:6}}>~{daysToGoal} days · {lbsLeft} lbs at {profile.lossPerWeek} lbs/week</div>
            </div>
            <div style={{...S.badge(C.green),fontSize:13,padding:"6px 12px"}}>🔥 {streak}-day streak</div>
          </div>
          <div style={S.pb(10)}><div style={{height:"100%",width:`${Math.min(((profile.weightLbs-profile.targetWeightLbs-lbsLeft)/Math.max(profile.weightLbs-profile.targetWeightLbs,1))*100,100)}%`,background:C.green,borderRadius:99}}/></div>
          <div style={{fontSize:11,color:C.muted,marginTop:4,display:"flex",justifyContent:"space-between"}}><span>Start: {profile.weightLbs} lbs</span><span>Goal: {profile.targetWeightLbs} lbs</span></div>
        </div>
        {profile.zigzag&&<div style={S.card}>
          <div style={S.sec}>Your Zigzag Plan</div>
          <div style={{fontSize:13,color:C.muted,marginBottom:10,lineHeight:1.55}}>Cycling calories prevents metabolic adaptation and refuels glycogen for weekend sessions.</div>
          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
            {["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map((day,i)=>{
              const we=i>=5;
              return(<div key={day} style={{flex:1,minWidth:52,background:C.bg,borderRadius:9,padding:"9px 6px",textAlign:"center",borderTop:`2px solid ${we?C.yellow:C.accent}`}}>
                <div style={{fontSize:11,fontWeight:700,color:we?C.yellow:C.accent,marginBottom:3}}>{day}</div>
                <div style={{fontSize:13,fontWeight:800}}>{we?calc.weekendGoal.toLocaleString():calc.weekdayGoal.toLocaleString()}</div>
                <div style={{fontSize:10,color:C.muted}}>kcal</div>
              </div>);
            })}
          </div>
        </div>}
      </>
    );
  };

  // ── RENDER HISTORY ────────────────────────────────────────────────────────
  const renderHistory = () => (
    <>
      <div style={{...S.card,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div><div style={S.sec}>Past 14 Days</div></div>
        <button onClick={()=>exportCSV(allEntries)} style={{...S.btn(C.green,"#0d0f18"),fontSize:12}}>⬇ Export CSV</button>
      </div>
      <div style={S.card}>
        {pastDays.length===0?<div style={{fontSize:13,color:C.dim,textAlign:"center",padding:"14px 0"}}>No history yet.</div>:(
          pastDays.map(day=>{
            const entries=logMap[day]||[],dayKcal=entries.reduce((s,e)=>s+e.kcal,0),dayGoal=goalFor(day,profile),dayProt=entries.reduce((s,e)=>s+e.protein,0),over=dayKcal>dayGoal;
            return (
              <div key={day} style={{display:"flex",alignItems:"center",gap:9,padding:"9px 0",borderBottom:`1px solid ${C.dim}`}}>
                <div style={{minWidth:84,fontSize:13}}>{fmtDate(day)}</div>
                <div style={{flex:2,minWidth:60}}><div style={S.pb(5)}><div style={{height:"100%",width:`${Math.min((dayKcal/dayGoal)*100,100)}%`,background:over?C.red:isWeekend(day)?C.yellow:C.green,borderRadius:99}}/></div></div>
                <div style={{fontSize:13,fontWeight:700,color:over?C.red:C.green,minWidth:68,textAlign:"right"}}>{dayKcal.toLocaleString()} kcal</div>
                <div style={{fontSize:11,color:C.blue,minWidth:48,textAlign:"right"}}>{dayProt.toFixed(0)}g pro</div>
                <div style={{...S.badge(over?C.red:C.green)}}>{over?"Over":"✓"}</div>
              </div>
            );
          })
        )}
      </div>
    </>
  );

  // ── RENDER GUIDE ──────────────────────────────────────────────────────────
  const renderGuide = () => (
    <>
      <div style={S.card}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
          <div style={S.sec}>Your Stats & Targets</div>
          <button onClick={()=>setShowSettings(true)} style={S.btn()}>✏️ Edit Profile</button>
        </div>
        {[
          ["Name", profile.name||"Not set"],
          ["Age / Stats", `${profile.age}yo · ${profile.heightFt}'${profile.heightIn}" · ${profile.weightLbs} lbs → ${profile.targetWeightLbs} lbs`],
          ["BMR", `${calc.bmr} kcal/day`],
          ["Est. TDEE", `${calc.tdee} kcal/day`],
          ["Daily Deficit", `${calc.deficitPerDay} kcal → ${profile.lossPerWeek} lbs/week`],
          ["Weekday Goal", `${calc.weekdayGoal} kcal`],
          ["Weekend Goal", `${calc.weekendGoal} kcal${profile.zigzag?" (zigzag refeed)":""}`],
          ["Protein Target", `${calc.proteinGoal}g/day (${profile.proteinMultiplier}g/lb)`],
          ["Fiber Target", `${calc.fiberGoal}g/day`],
          ["Sleep Target", `${calc.sleepGoal}h/night`],
          ["Google Sheets", profile.sheetsUrl?"✓ Connected":"Not connected"],
        ].map(([l,v])=>(
          <div key={l} style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:`1px solid ${C.dim}`,fontSize:13}}>
            <span style={{color:C.muted}}>{l}</span><span style={{fontWeight:600,maxWidth:"58%",textAlign:"right"}}>{v}</span>
          </div>
        ))}
      </div>
      <div style={S.card}>
        <div style={S.sec}>Personalized Fat Loss Principles</div>
        {tips.map(t=>(
          <div key={t.title} style={{display:"flex",gap:11,padding:"11px 0",borderBottom:`1px solid ${C.dim}`}}>
            <span style={{fontSize:20,flexShrink:0}}>{t.icon}</span>
            <div><div style={{fontWeight:700,fontSize:13,marginBottom:3}}>{t.title}</div><div style={{fontSize:12,color:C.muted,lineHeight:1.65}}>{t.text}</div></div>
          </div>
        ))}
      </div>
    </>
  );

  if(!dbReady) return (
    <div style={{...S.app,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,color:C.muted}}>
      Loading FuelLog…
    </div>
  );

  return (
    <div style={S.app}>
      <div style={S.hdr}>
        <div style={S.logo}>
          <span>⚡</span>
          <span>Fuel<span style={{color:C.accent}}>Log</span></span>
          <span style={{fontSize:10,color:C.muted,fontWeight:400,marginLeft:4}}>Pro</span>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
          <div style={S.tabs}>
            {[["today","Today"],["meals","Meals"],["week","Week"],["history","History"],["guide","Guide"]].map(([id,label])=>(
              <button key={id} style={S.tab(tab===id)} onClick={()=>setTab(id)}>{label}</button>
            ))}
          </div>
          <button onClick={()=>setShowSettings(true)} title="Settings" style={{background:"none",border:`1px solid ${C.border}`,borderRadius:8,color:C.muted,fontSize:16,padding:"4px 9px",cursor:"pointer"}}>⚙️</button>
        </div>
      </div>
      <div style={S.main}>
        {tab==="today"   && renderToday()}
        {tab==="meals"   && renderMeals()}
        {tab==="week"    && renderWeek()}
        {tab==="history" && renderHistory()}
        {tab==="guide"   && renderGuide()}
      </div>

      {showSettings&&<SettingsPanel profile={profile} onSave={saveProfile} onClose={()=>setShowSettings(false)}/>}
      {showBuilder&&<MealBuilderModal existing={editMeal} onSave={saveMeal} onClose={()=>{setShowBuilder(false);setEditMeal(null);}}/>}
      {quickLog&&(
        <div style={S.modal} onClick={e=>e.target===e.currentTarget&&setQuickLog(null)}>
          <div style={{...S.mBox,maxWidth:380}}>
            <div style={{fontSize:15,fontWeight:800,marginBottom:4}}>{quickLog.name}</div>
            <MacroRow macros={sumMacros(quickLog.items)}/>
            <div style={{marginTop:14,marginBottom:8}}><div style={{...S.sec,marginBottom:8}}>Log to which slot?</div>
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {SLOTS.map(slot=>(
                  <button key={slot} onClick={()=>logSavedMeal(quickLog,slot)}
                    style={{...S.btn(slot===qlSlot?C.accent:C.dim+"88"),flex:1,fontSize:12}}
                    onMouseEnter={e=>e.currentTarget.style.background=C.accent}
                    onMouseLeave={e=>e.currentTarget.style.background=slot===qlSlot?C.accent:C.dim+"88"}>
                    {slot}
                  </button>
                ))}
              </div>
            </div>
            <button onClick={()=>setQuickLog(null)} style={{...S.ghost,width:"100%",marginTop:4}}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
