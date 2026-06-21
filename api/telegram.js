// Bot de Telegram (Neurana) — agenda, alerta diaria (cron) y registro de gastos por lenguaje natural.
const TZ = "America/Caracas";
const TARIFAS = { tc15:{tipo:"Neurofeedback",fee:15}, tc30:{tipo:"Terapia cognitiva",fee:30}, mp60:{tipo:"Mapeo cerebral",fee:60} };
const CATS = ["Comida","Transporte","Servicios","Salud","Hogar","Ocio","Otros"];

function ymdInTZ(d){ return new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit"}).format(d).replace(/-/g,""); }
function parseDtStart(line){
  const v=line.split(":").pop().trim();
  if(/Z$/.test(v)){ const iso=v.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/,"$1-$2-$3T$4:$5:$6Z"); const d=new Date(iso);
    return {ymd:ymdInTZ(d),hhmm:new Intl.DateTimeFormat("es",{timeZone:TZ,hour:"2-digit",minute:"2-digit",hour12:false}).format(d)}; }
  return {ymd:v.slice(0,8),hhmm:v.length>=13?v.slice(9,11)+":"+v.slice(11,13):"--:--"};
}
function decodeSesion(s){ s=(s||"").trim();
  if(/gimnasio|neurocognitiv/i.test(s)) return {nombre:s,tipo:"Sesion grupal",fee:null};
  const m=s.match(/(tc|mp)\s?-?\s?(\d+)/i); if(!m) return {nombre:s,tipo:"Sesion",fee:null};
  const code=(m[1]+m[2]).toLowerCase(); const info=TARIFAS[code]||{tipo:m[1].toLowerCase()==="mp"?"Mapeo cerebral":"Terapia",fee:parseInt(m[2],10)};
  return {nombre:s.replace(m[0],"").replace(/\s{2,}/g," ").trim()||code,tipo:info.tipo,fee:info.fee};
}
async function fetchTodayAgenda(){
  const url=process.env.CALENDAR_ICS_URL; if(!url) return {message:"Falta CALENDAR_ICS_URL."};
  const text=await (await fetch(url)).text();
  const lines=text.replace(/\r?\n[ \t]/g,"").split(/\r?\n/);
  const today=ymdInTZ(new Date()); const events=[]; let cur=null;
  for(const line of lines){
    if(line.startsWith("BEGIN:VEVENT")) cur={};
    else if(line.startsWith("END:VEVENT")){ if(cur) events.push(cur); cur=null; }
    else if(cur){ if(line.startsWith("SUMMARY")) cur.summary=line.split(":").slice(1).join(":"); else if(line.startsWith("DTSTART")) cur.dt=parseDtStart(line); }
  }
  const hoy=events.filter(e=>e.dt&&e.dt.ymd===today).sort((a,b)=>a.dt.hhmm.localeCompare(b.dt.hhmm));
  if(!hoy.length) return {message:"Hoy no tienes sesiones agendadas."};
  let bruto=0; const filas=hoy.map(e=>{ const d=decodeSesion(e.summary); if(d.fee!=null) bruto+=d.fee; return e.dt.hhmm+"  "+d.nombre+" ("+d.tipo+(d.fee!=null?" - $"+d.fee:"")+")"; });
  return {message:"Agenda de hoy ("+hoy.length+" sesiones)\n"+filas.join("\n")+"\n\nBruto: $"+bruto+" - Tu parte (50%): $"+(bruto/2),bruto};
}
async function sendMessage(chatId,text){
  const token=process.env.TELEGRAM_BOT_TOKEN;
  await fetch("https://api.telegram.org/bot"+token+"/sendMessage",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:chatId,text,disable_web_page_preview:true})});
}

// ---- Gastos: cerebro de IA (Gemini) con fallback a reglas ----
async function parseExpenseAI(text){
  const key=process.env.GEMINI_API_KEY; if(!key) return null;
  const model=process.env.GEMINI_MODEL || "gemini-2.0-flash";
  const prompt="Eres un asistente que registra gastos. Del siguiente mensaje extrae el gasto y responde SOLO con JSON valido, sin texto extra: {\"monto\":numero,\"moneda\":\"USD\" o \"Bs\",\"categoria\":una de "+JSON.stringify(CATS)+",\"nota\":texto corto}. Si no hay un monto claro, usa monto 0. Mensaje: "+text;
  try{
    const r=await fetch("https://generativelanguage.googleapis.com/v1beta/models/"+model+":generateContent?key="+key,{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{temperature:0,responseMimeType:"application/json"}})
    });
    const j=await r.json();
    const t=j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts[0].text;
    if(!t) return null;
    const obj=JSON.parse(t);
    if(!obj || !Number(obj.monto)) return null;
    return {monto:Number(obj.monto),moneda:obj.moneda==="Bs"?"Bs":"USD",categoria:CATS.indexOf(obj.categoria)>=0?obj.categoria:"Otros",nota:String(obj.nota||"").slice(0,120)};
  }catch(e){ return null; }
}
function parseExpenseRules(text){
  const m=text.match(/(\d+(?:[.,]\d+)?)/); if(!m) return null;
  const monto=parseFloat(m[1].replace(",",".")); if(!monto) return null;
  const low=text.toLowerCase(); let categoria="Otros";
  const map={Comida:["comid","almuerz","desayun","cena","cafe","café","restau","mercado","comer","merienda"],Transporte:["gasolin","transport","taxi","uber","pasaj","bus","combust","carro","moto"],Servicios:["luz","agua","internet","telefon","servicio","recarga","plan","datos"],Salud:["salud","medic","farmacia","consulta","medicina"],Hogar:["hogar","casa","alquiler","renta","aseo","limpieza"],Ocio:["cine","salida","fiesta","ocio","juego","netflix"]};
  for(const c in map){ if(map[c].some(k=>low.includes(k))){categoria=c;break;} }
  const moneda=/\bbs\b|bol[ií]var/i.test(text)?"Bs":"USD";
  const nota=text.replace(/^(gast[eé]|pagu[eé]|compr[eé]|gasto)\s*/i,"").replace(/\s{2,}/g," ").trim();
  return {monto,moneda,categoria,nota:nota||text};
}
async function logExpense(chatId,text){
  let exp=await parseExpenseAI(text);
  if(!exp) exp=parseExpenseRules(text);
  if(!exp){ await sendMessage(chatId,"No encontre un monto. Ejemplo: gaste 20 en gasolina"); return; }
  const url=process.env.GASTOS_WEBHOOK_URL;
  if(!url){ await sendMessage(chatId,"Anotado (sin guardar, falta GASTOS_WEBHOOK_URL): $"+exp.monto+" - "+exp.categoria); return; }
  const payload={secret:process.env.GASTOS_SECRET||"",action:"addExpense",fecha:new Date().toISOString().slice(0,10),categoria:exp.categoria,monto:exp.monto,moneda:exp.moneda,montoCOP:0,nota:exp.nota};
  try{
    const r=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
    const j=await r.json().catch(()=>({}));
    if(j&&j.error){ await sendMessage(chatId,"No se pudo guardar: "+j.error); return; }
    await sendMessage(chatId,"✅ Gasto registrado: $"+exp.monto+" "+exp.moneda+" - "+exp.categoria+(exp.nota?(" ("+exp.nota+")"):""));
  }catch(e){ await sendMessage(chatId,"Error guardando: "+(e.message||e)); }
}

module.exports = async (req, res) => {
  if (req.query && req.query.cron === "1") {
    const secret=process.env.CRON_SECRET; const auth=req.headers["authorization"]||"";
    if(secret && auth!=="Bearer "+secret) return res.status(401).json({ok:false});
    const chatId=process.env.TELEGRAM_CHAT_ID;
    if(!chatId) return res.status(500).json({ok:false,error:"falta TELEGRAM_CHAT_ID"});
    await sendMessage(chatId,"Buenos dias, Manuel.\n\n"+(await fetchTodayAgenda()).message);
    return res.status(200).json({ok:true});
  }
  if(req.method!=="POST") return res.status(200).send("ok");
  const update=req.body||{}; const msg=update.message||update.edited_message;
  if(!msg||!msg.text) return res.status(200).json({ok:true});
  const chatId=String(msg.chat.id); const owner=process.env.TELEGRAM_CHAT_ID;
  if(owner && chatId!==String(owner)){ await sendMessage(chatId,"Este bot es privado."); return res.status(200).json({ok:true}); }
  const text=msg.text.trim(); const lower=text.toLowerCase();
  try{
    if(lower==="/start"){
      await sendMessage(chatId,"Hola Manuel, soy tu asistente.\n\n/hoy - agenda e ingresos de hoy\nO escribeme un gasto en lenguaje natural, ej:\n  gaste 20 en gasolina\n  almuerzo 8\n  pague 30 de luz\n\nCada manana te envio la agenda.");
    } else if(lower==="/hoy" || lower==="/ingresos"){
      await sendMessage(chatId,(await fetchTodayAgenda()).message);
    } else {
      await logExpense(chatId,text);
    }
  }catch(e){ await sendMessage(chatId,"Error: "+(e.message||e)); }
  return res.status(200).json({ok:true});
};
