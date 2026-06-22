// neurana-bot — asistente: agenda (lectura), gastos, ingresos/carteras y agendar sesiones.
// Clasificacion por REGLAS (principal) + Gemini (opcional). Backend = Apps Script "Mis Gastos".
const TZ = "America/Caracas";
const TARIFAS = { tc15:{t:"Neurofeedback",f:15}, tc30:{t:"Terapia cognitiva",f:30}, mp60:{t:"Mapeo cerebral",f:60} };

function base(){ return (process.env.GASTOS_WEBHOOK_URL||"").trim(); }
function tok(){ return encodeURIComponent((process.env.GASTOS_SECRET||"").trim()); }

async function sendMessage(chatId, text){
  const t = process.env.TELEGRAM_BOT_TOKEN;
  await fetch("https://api.telegram.org/bot"+t+"/sendMessage",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:chatId,text,disable_web_page_preview:true})});
}

// ---------- Backend ----------
async function gasGet(action){ const r = await fetch(base()+"?action="+action+"&token="+tok()); return r.json(); }
async function gasPost(action, data){
  const r = await fetch(base()+"?token="+tok(),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action,data})});
  return r.json().catch(()=>({error:"respuesta no JSON"}));
}

// ---------- Agenda (lectura iCal) ----------
function ymdInTZ(d){ return new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit"}).format(d).replace(/-/g,""); }
function parseDtStart(line){
  const v=line.split(":").pop().trim();
  if(/Z$/.test(v)){ const iso=v.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/,"$1-$2-$3T$4:$5:$6Z"); const d=new Date(iso);
    return {ymd:ymdInTZ(d),hhmm:new Intl.DateTimeFormat("es",{timeZone:TZ,hour:"2-digit",minute:"2-digit",hour12:false}).format(d)}; }
  return {ymd:v.slice(0,8),hhmm:v.length>=13?v.slice(9,11)+":"+v.slice(11,13):"--:--"};
}
function decodeSesion(s){ s=(s||"").trim();
  if(/gimnasio|neurocognitiv/i.test(s)) return {nombre:s,tipo:"Sesion grupal",fee:null};
  const m=s.match(/(tc|mp)\s?-?\s?(\d+)/i); if(!m) return {nombre:s,tipo:"",fee:null};
  const c=(m[1]+m[2]).toLowerCase(); const info=TARIFAS[c]||{t:m[1].toLowerCase()==="mp"?"Mapeo cerebral":"Terapia",f:parseInt(m[2],10)};
  return {nombre:s.replace(m[0],"").replace(/\s{2,}/g," ").trim()||c,tipo:info.t,fee:info.f};
}
async function readAgenda(rango){
  const url=process.env.CALENDAR_ICS_URL; if(!url) return "Falta CALENDAR_ICS_URL.";
  const text=await (await fetch(url)).text();
  const lines=text.replace(/\r?\n[ \t]/g,"").split(/\r?\n/);
  const events=[]; let cur=null;
  for(const line of lines){
    if(line.startsWith("BEGIN:VEVENT")) cur={};
    else if(line.startsWith("END:VEVENT")){ if(cur) events.push(cur); cur=null; }
    else if(cur){ if(line.startsWith("SUMMARY")) cur.summary=line.split(":").slice(1).join(":"); else if(line.startsWith("DTSTART")) cur.dt=parseDtStart(line); }
  }
  const today=new Date(); const todayK=ymdInTZ(today);
  const tmrwK=ymdInTZ(new Date(today.getTime()+86400000));
  let keep, titulo;
  if(rango==="manana"){ keep=e=>e.dt&&e.dt.ymd===tmrwK; titulo="Agenda de manana"; }
  else if(rango==="semana"){ const wk=[]; for(let i=0;i<7;i++) wk.push(ymdInTZ(new Date(today.getTime()+i*86400000))); keep=e=>e.dt&&wk.indexOf(e.dt.ymd)>=0; titulo="Agenda de los proximos 7 dias"; }
  else { keep=e=>e.dt&&e.dt.ymd===todayK; titulo="Agenda de hoy"; }
  const list=events.filter(keep).sort((a,b)=>(a.dt.ymd+a.dt.hhmm).localeCompare(b.dt.ymd+b.dt.hhmm));
  if(!list.length) return titulo+": sin sesiones.";
  let bruto=0; const filas=list.map(e=>{ const d=decodeSesion(e.summary); if(d.fee!=null) bruto+=d.fee; const dk=rango==="semana"?(e.dt.ymd.slice(6,8)+"/"+e.dt.ymd.slice(4,6)+" "):""; return dk+e.dt.hhmm+"  "+d.nombre+(d.tipo?" ("+d.tipo+(d.fee!=null?" $"+d.fee:"")+")":""); });
  return titulo+" ("+list.length+")\n"+filas.join("\n")+(bruto?("\n\nBruto: $"+bruto+" - Tu parte: $"+(bruto/2)):"");
}

// ---------- Clasificacion por REGLAS ----------
function parseAmount(t){ const m=t.match(/(\d+(?:[.,]\d+)?)/); if(!m) return null; const n=parseFloat(m[1].replace(",",".")); return isNaN(n)?null:n; }
function detectMoneda(t){
  if(/\bbs\b|bol[ií]var/.test(t)) return "VES";
  if(/usdt/.test(t)) return "USDT";
  if(/\bpeso|\bcop\b/.test(t)) return "COP";
  return "USD";
}
function walletByKw(t, ws, moneda){
  t=(t||"").toLowerCase(); ws=ws||[];
  const map=[["zelle",["zelle"]],["binance_usdt",["binance","usdt"]],["sofitasa_bs",["sofitasa","banco"]],["efectivo_pesos",["efectivo peso","efectivo cop","pesos en efectivo"]],["efectivo_usd",["efectivo usd","efectivo dolar","efectivo dólar","efectivo"]]];
  for(const pair of map){ const idw=pair[0], keys=pair[1]; if(keys.some(k=>t.includes(k)) && ws.some(w=>w.id===idw)) return idw; }
  if(moneda==="VES" && ws.some(w=>w.id==="sofitasa_bs")) return "sofitasa_bs";
  if(moneda==="USDT" && ws.some(w=>w.id==="binance_usdt")) return "binance_usdt";
  if(moneda==="COP" && ws.some(w=>w.id==="efectivo_pesos")) return "efectivo_pesos";
  const byCur=ws.find(w=>w.moneda===moneda); if(byCur) return byCur.id;
  return ws[0]?ws[0].id:null;
}
function pickCategoria(t, catalog){
  const cats=(catalog.categories||[]);
  const groups=[
    [/gato|mascota|perro|veterinar/, ["mascota","gato","perro"]],
    [/comid|almuerz|desayun|cena|mercado|comer|merienda|caf[eé]/, ["aliment","comida"]],
    [/luz|agua|internet|tel[eé]fono|servicio|recarga|datos|plan/, ["servicio"]],
    [/gasolin|transport|taxi|uber|pasaj|\bbus\b|combust/, ["transport"]],
    [/salud|medic|farmacia|consulta|medicina/, ["salud"]],
    [/hogar|alquiler|renta|aseo|limpieza|casa/, ["hogar","casa"]]
  ];
  for(const g of groups){ if(g[0].test(t)){ const f=cats.find(c=> g[1].some(k=> (c.id+" "+(c.nombre||"")).toLowerCase().includes(k))); if(f) return f.id; } }
  const otros=cats.find(c=>/otro/i.test(c.id+" "+(c.nombre||""))); if(otros) return otros.id;
  return cats[0]?cats[0].id:"otros";
}
function classifyRules(text, catalog){
  const t=text.toLowerCase();
  if((/(que|qué)\s+tengo|mi agenda|que hay|qué hay/.test(t) || /^agenda\b/.test(t)) && !/agend(a|ar|ame|áme)\s+(a|al|la|una|sesion|sesión)/.test(t)){
    let rango="hoy"; if(/manana|mañana/.test(t)) rango="manana"; else if(/semana/.test(t)) rango="semana";
    return {intent:"agenda_consulta", rango};
  }
  const monto=parseAmount(t); const moneda=detectMoneda(t); const ws=(catalog.wallets||[]);
  if(/(cambi[eé]|transfer|pas[eé])/.test(t) && monto){
    const parts=t.split(/\ba\b/);
    const origen=walletByKw(parts[0]||t, ws, moneda);
    const destino=walletByKw(parts.slice(1).join(" ")||t, ws, null);
    return {intent:"transferencia", carteraOrigen:origen, carteraDestino:destino, montoOrigen:monto, montoDestino:monto, moneda};
  }
  if(/(recib[ií]|entr[oó]|entraron|me lleg|llegaron|cobr[eé]|me pagaron|abono|deposit)/.test(t) && monto){
    return {intent:"ingreso", cartera: walletByKw(t, ws, moneda), monto, moneda};
  }
  if(/(retir[eé]|saqu[eé])/.test(t) && monto){
    return {intent:"egreso", cartera: walletByKw(t, ws, moneda), monto, moneda};
  }
  if(monto && /(gast[eé]|pagu[eé]|compr[eé]|gasto|gaste)/.test(t)){
    return {intent:"gasto", monto, moneda, categoria: pickCategoria(t, catalog), nota:text};
  }
  if(monto){ return {intent:"gasto", monto, moneda, categoria: pickCategoria(t, catalog), nota:text}; }
  return {intent:"desconocido"};
}

// ---------- Gemini (opcional, respaldo para casos complejos como agendar) ----------
async function classifyAI(text, catalog){
  const key=process.env.GEMINI_API_KEY; if(!key) return null;
  const model=process.env.GEMINI_MODEL||"gemini-2.0-flash";
  const cats=(catalog.categories||[]).map(c=>c.id);
  const ws=(catalog.wallets||[]).map(w=>w.id);
  const hoy=new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
  const prompt="Clasifica el mensaje y responde SOLO JSON. Intenciones: gasto, ingreso, egreso, transferencia, agenda_consulta, agenda_crear, desconocido. Categorias(id): "+JSON.stringify(cats)+". Carteras(id): "+JSON.stringify(ws)+". Formatos: gasto{intent,monto,moneda,categoria,nota}; ingreso/egreso{intent,cartera,monto,moneda,nota}; transferencia{intent,carteraOrigen,carteraDestino,montoOrigen,montoDestino,nota}; agenda_consulta{intent,rango:hoy|manana|semana}; agenda_crear{intent,titulo,inicio(ISO -04:00),duracionMin,nota}. Hoy="+hoy+". Mensaje: "+text;
  try{
    const r=await fetch("https://generativelanguage.googleapis.com/v1beta/models/"+model+":generateContent?key="+key,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{temperature:0,responseMimeType:"application/json"}})});
    const j=await r.json(); const tx=j&&j.candidates&&j.candidates[0]&&j.candidates[0].content&&j.candidates[0].content.parts[0].text;
    return tx?JSON.parse(tx):null;
  }catch(e){ return null; }
}

function ref(msg){ return "telegram:"+msg.chat.id+":"+msg.message_id; }
function hoyISODate(){ return new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date()); }

async function handle(msg, text){
  const chatId=String(msg.chat.id); const lower=text.toLowerCase();
  if(lower==="/start") return sendMessage(chatId,
    "Hola Manuel. Escribeme normal:\n- 'gaste 12 en comida del gato'\n- 'recibi 100$ por Zelle'\n- 'entraron 500 bs en sofitasa'\n- 'cambie 100$ de Zelle a efectivo'\n- 'que tengo hoy' / 'y manana' / 'agenda de la semana'\n- /deshacer para revertir lo ultimo.");
  if(lower==="/hoy") return sendMessage(chatId, await readAgenda("hoy"));
  if(lower==="/deshacer"||lower==="deshacer"){ const r=await gasPost("undoLastBotEvent",{chatId}); return sendMessage(chatId, r&&r.ok?"Listo, reverti lo ultimo.":("No pude deshacer: "+((r&&r.error)||"?"))); }

  const catalog=await gasGet("getBotCatalog").catch(()=>({}));
  let it=classifyRules(text, catalog||{});
  if(!it||it.intent==="desconocido"){ const ai=await classifyAI(text, catalog||{}); if(ai&&ai.intent) it=ai; }
  if(!it||!it.intent||it.intent==="desconocido") return sendMessage(chatId,
    "No estoy seguro de que querias. Ejemplos: 'gaste 20 en gasolina', 'recibi 50$ por Zelle', 'que tengo manana'.");

  try{
    if(it.intent==="agenda_consulta") return sendMessage(chatId, await readAgenda(it.rango||"hoy"));
    if(it.intent==="agenda_crear"){
      const r=await gasPost("createSession",{reference:ref(msg),chatId,inicio:it.inicio,duracionMin:it.duracionMin||60,titulo:it.titulo||"Sesion",nota:it.nota||""});
      if(r&&r.ok) return sendMessage(chatId,"Agendado: "+(it.titulo||"Sesion")+" - "+(it.inicio||""));
      return sendMessage(chatId,"No pude agendar: "+((r&&r.error)||"?")+"\n(Si menciona permisos de Calendar, hay que autorizar el acceso una vez.)");
    }
    if(it.intent==="gasto"){
      const moneda=it.moneda||"USD";
      const data={reference:ref(msg),chatId,fecha:hoyISODate(),categoria:it.categoria||"otros",monto:Number(it.monto)||0,moneda,montoCOP:moneda==="COP"?(Number(it.monto)||0):0,nota:it.nota||text};
      const r=await gasPost("addBotExpense",data);
      if(r&&(r.ok||r.id)) return sendMessage(chatId,"Gasto: "+data.monto+" "+moneda+" - "+data.categoria+(data.nota?(" ("+data.nota+")"):""));
      return sendMessage(chatId,"No pude registrar el gasto: "+((r&&r.error)||JSON.stringify(r)||"?"));
    }
    if(it.intent==="ingreso"||it.intent==="egreso"||it.intent==="transferencia"){
      const mon=it.moneda||"USD";
      const data={reference:ref(msg),chatId,fecha:hoyISODate(),tipo:it.intent,nota:it.nota||text};
      if(it.intent==="ingreso"){ data.carteraDestino=it.cartera; data.monto=Number(it.monto)||0; data.montoDestino=Number(it.monto)||0; data.monedaDestino=mon; }
      else if(it.intent==="egreso"){ data.carteraOrigen=it.cartera; data.monto=Number(it.monto)||0; data.montoOrigen=Number(it.monto)||0; data.monedaOrigen=mon; }
      else { data.carteraOrigen=it.carteraOrigen; data.carteraDestino=it.carteraDestino; data.montoOrigen=Number(it.montoOrigen)||0; data.montoDestino=Number(it.montoDestino||it.montoOrigen)||0; data.monedaOrigen=mon; data.monedaDestino=mon; }
      const r=await gasPost("addBotWalletMovement",data);
      if(r&&(r.ok||r.id)){
        if(it.intent==="ingreso") return sendMessage(chatId,"Ingreso: "+data.monto+" "+mon+" a "+data.carteraDestino);
        if(it.intent==="egreso") return sendMessage(chatId,"Egreso: "+data.monto+" "+mon+" de "+data.carteraOrigen);
        return sendMessage(chatId,"Transferencia: "+data.montoOrigen+" "+data.carteraOrigen+" -> "+data.carteraDestino);
      }
      return sendMessage(chatId,"No pude registrar el movimiento: "+((r&&r.error)||JSON.stringify(r)||"?"));
    }
  }catch(e){ return sendMessage(chatId,"Error: "+(e.message||e)); }
}

module.exports = async (req, res) => {
  if(req.query && req.query.cron==="1"){
    const secret=process.env.CRON_SECRET; const auth=req.headers["authorization"]||"";
    if(secret && auth!=="Bearer "+secret) return res.status(401).json({ok:false});
    const chatId=process.env.TELEGRAM_CHAT_ID; if(!chatId) return res.status(500).json({ok:false});
    await sendMessage(chatId,"Buenos dias, Manuel.\n\n"+await readAgenda("hoy"));
    return res.status(200).json({ok:true});
  }
  if(req.method!=="POST") return res.status(200).send("ok");
  const update=req.body||{}; const msg=update.message||update.edited_message;
  if(!msg||!msg.text) return res.status(200).json({ok:true});
  const owner=process.env.TELEGRAM_CHAT_ID;
  if(owner && String(msg.chat.id)!==String(owner)){ await sendMessage(String(msg.chat.id),"Bot privado."); return res.status(200).json({ok:true}); }
  try{ await handle(msg, msg.text.trim()); }catch(e){ try{ await sendMessage(String(msg.chat.id),"Error: "+(e.message||e)); }catch(_){} }
  return res.status(200).json({ok:true});
};
