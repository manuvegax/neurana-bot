// neurana-bot — asistente personal: agenda (lectura), gastos, ingresos/carteras y agendar sesiones.
// Cerebro de intencion con Gemini; backend = Apps Script "Mis Gastos" (acciones addBot*).
const TZ = "America/Caracas";
const TARIFAS = { tc15:{t:"Neurofeedback",f:15}, tc30:{t:"Terapia cognitiva",f:30}, mp60:{t:"Mapeo cerebral",f:60} };

function base(){ return (process.env.GASTOS_WEBHOOK_URL||"").trim(); }
function tok(){ return encodeURIComponent((process.env.GASTOS_SECRET||"").trim()); }

async function sendMessage(chatId, text){
  const t = process.env.TELEGRAM_BOT_TOKEN;
  await fetch("https://api.telegram.org/bot"+t+"/sendMessage",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:chatId,text,disable_web_page_preview:true})});
}

// ---------- Backend (Apps Script) ----------
async function gasGet(action){
  const r = await fetch(base()+"?action="+action+"&token="+tok());
  return r.json();
}
async function gasPost(action, data){
  const r = await fetch(base()+"?token="+tok(),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action,data})});
  return r.json().catch(()=>({error:"respuesta no JSON"}));
}

// ---------- Agenda (lectura via iCal) ----------
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

// ---------- Cerebro de intencion (Gemini) ----------
async function classify(text, catalog){
  const key=process.env.GEMINI_API_KEY; if(!key) return null;
  const model=process.env.GEMINI_MODEL||"gemini-2.0-flash";
  const cats=(catalog.categories||[]).map(c=>({id:c.id,nombre:c.nombre}));
  const wallets=(catalog.wallets||[]).map(w=>({id:w.id,nombre:w.nombre,moneda:w.moneda}));
  const hoy=new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
  const prompt=
"Eres el cerebro de un bot financiero y de agenda clinica. Clasifica el mensaje y responde SOLO JSON valido, sin texto extra.\n"+
"Intenciones: gasto, ingreso, egreso, transferencia, agenda_consulta, agenda_crear, desconocido.\n"+
"Categorias de gasto validas (usa el id): "+JSON.stringify(cats)+".\n"+
"Carteras validas (usa el id): "+JSON.stringify(wallets)+".\n"+
"Formatos:\n"+
'gasto -> {"intent":"gasto","monto":num,"moneda":"USD|VES|COP|USDT","categoria":"<id>","nota":"texto corto"}\n'+
'ingreso -> {"intent":"ingreso","cartera":"<id>","monto":num,"moneda":"...","nota":"..."}\n'+
'egreso -> {"intent":"egreso","cartera":"<id>","monto":num,"moneda":"...","nota":"..."}\n'+
'transferencia -> {"intent":"transferencia","carteraOrigen":"<id>","carteraDestino":"<id>","montoOrigen":num,"montoDestino":num,"nota":"..."}\n'+
'agenda_consulta -> {"intent":"agenda_consulta","rango":"hoy|manana|semana"}\n'+
'agenda_crear -> {"intent":"agenda_crear","titulo":"texto","inicio":"YYYY-MM-DDTHH:mm:00-04:00","duracionMin":num,"nota":"..."}\n'+
'desconocido -> {"intent":"desconocido"}\n'+
"Reglas: monto es solo numero. 'bs'/'bolivares'->VES; 'usdt'->USDT; 'pesos'/'cop'->COP; si no se dice, USD. Verbos gaste/pague/compre->gasto; recibi/entraron/me llegaron/cobre->ingreso; retire/saque->egreso; cambie/pase/transferi X a Y->transferencia. Para gasto elige la categoria existente mas adecuada por su id. Hoy es "+hoy+" (zona "+TZ+").\n"+
"Mensaje: "+text;
  try{
    const r=await fetch("https://generativelanguage.googleapis.com/v1beta/models/"+model+":generateContent?key="+key,{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{temperature:0,responseMimeType:"application/json"}})
    });
    const j=await r.json();
    const t=j&&j.candidates&&j.candidates[0]&&j.candidates[0].content&&j.candidates[0].content.parts[0].text;
    return t?JSON.parse(t):null;
  }catch(e){ return null; }
}

function ref(msg){ return "telegram:"+msg.chat.id+":"+msg.message_id; }
function hoyISODate(){ return new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date()); }

// ---------- Manejo de cada intencion ----------
async function handle(msg, text){
  const chatId=String(msg.chat.id);
  const lower=text.toLowerCase();
  if(lower==="/start") return sendMessage(chatId,
    "Hola Manuel. Escribeme normal, yo entiendo:\n"+
    "- Gastos: 'gaste 12 en comida del gato'\n"+
    "- Ingresos: 'recibi 100$ por Zelle'\n"+
    "- Movimientos: 'cambie 100$ de Zelle a efectivo'\n"+
    "- Agenda: 'que tengo hoy', 'y manana', 'agenda de la semana'\n"+
    "- Agendar: 'agenda a Dylan manana 10:30 tc15'\n"+
    "- /deshacer para revertir lo ultimo.");
  if(lower==="/hoy") return sendMessage(chatId, await readAgenda("hoy"));
  if(lower==="/deshacer"||lower==="deshacer"){ const r=await gasPost("undoLastBotEvent",{chatId}); return sendMessage(chatId, r&&r.ok?"Listo, reverti lo ultimo.":("No pude deshacer: "+(r&&r.error||"?"))); }

  const catalog=await gasGet("getBotCatalog").catch(()=>({}));
  const it=await classify(text, catalog||{});
  if(!it||!it.intent||it.intent==="desconocido") return sendMessage(chatId,
    "No estoy seguro de que querias. Ejemplos: 'gaste 20 en gasolina', 'recibi 50$ por Zelle', 'que tengo manana'.");

  try{
    if(it.intent==="agenda_consulta") return sendMessage(chatId, await readAgenda(it.rango||"hoy"));

    if(it.intent==="agenda_crear"){
      const r=await gasPost("createSession",{reference:ref(msg),chatId,inicio:it.inicio,duracionMin:it.duracionMin||60,titulo:it.titulo||"Sesion",nota:it.nota||""});
      if(r&&r.ok) return sendMessage(chatId,"Agendado: "+(it.titulo||"Sesion")+" - "+(it.inicio||""));
      return sendMessage(chatId,"No pude agendar: "+((r&&r.error)||"?")+"\n(Si dice permisos de Calendar, hay que autorizar el acceso una vez.)");
    }

    if(it.intent==="gasto"){
      const moneda=it.moneda||"USD";
      const data={reference:ref(msg),chatId,fecha:hoyISODate(),categoria:it.categoria||"otros",monto:Number(it.monto)||0,moneda,montoCOP:moneda==="COP"?(Number(it.monto)||0):0,nota:it.nota||text};
      const r=await gasPost("addBotExpense",data);
      if(r&&(r.ok||r.id)) return sendMessage(chatId,"Gasto: "+data.monto+" "+moneda+" - "+data.categoria+(data.nota?(" ("+data.nota+")"):""));
      return sendMessage(chatId,"No pude registrar el gasto: "+((r&&r.error)||"?"));
    }

    if(it.intent==="ingreso"||it.intent==="egreso"||it.intent==="transferencia"){
      const data={reference:ref(msg),chatId,fecha:hoyISODate(),tipo:it.intent,nota:it.nota||text};
      if(it.intent==="ingreso"){ data.carteraDestino=it.cartera; data.monto=Number(it.monto)||0; data.montoDestino=Number(it.monto)||0; }
      else if(it.intent==="egreso"){ data.carteraOrigen=it.cartera; data.monto=Number(it.monto)||0; data.montoOrigen=Number(it.monto)||0; }
      else { data.carteraOrigen=it.carteraOrigen; data.carteraDestino=it.carteraDestino; data.montoOrigen=Number(it.montoOrigen)||0; data.montoDestino=Number(it.montoDestino||it.montoOrigen)||0; }
      const r=await gasPost("addBotWalletMovement",data);
      if(r&&(r.ok||r.id)){
        if(it.intent==="ingreso") return sendMessage(chatId,"Ingreso: "+data.monto+" a "+data.carteraDestino);
        if(it.intent==="egreso") return sendMessage(chatId,"Egreso: "+data.monto+" de "+data.carteraOrigen);
        return sendMessage(chatId,"Transferencia: "+data.montoOrigen+" "+data.carteraOrigen+" -> "+data.carteraDestino);
      }
      return sendMessage(chatId,"No pude registrar el movimiento: "+((r&&r.error)||"?"));
    }
  }catch(e){ return sendMessage(chatId,"Error: "+(e.message||e)); }
}

module.exports = async (req, res) => {
  if(req.query && req.query.cron==="1"){
    const secret=process.env.CRON_SECRET; const auth=req.headers["authorization"]||"";
    if(secret && auth!=="Bearer "+secret) return res.status(401).json({ok:false});
    const chatId=process.env.TELEGRAM_CHAT_ID;
    if(!chatId) return res.status(500).json({ok:false});
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
