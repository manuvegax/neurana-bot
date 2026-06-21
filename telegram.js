// Bot de Telegram (Neurana) — un solo archivo. Maneja mensajes y la alerta diaria (cron).
const TZ = "America/Caracas";
const TARIFAS = { tc15:{tipo:"Neurofeedback",fee:15}, tc30:{tipo:"Terapia cognitiva",fee:30}, mp60:{tipo:"Mapeo cerebral",fee:60} };
function ymdInTZ(d){ return new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit"}).format(d).replace(/-/g,""); }
function parseDtStart(line){
  const v=line.split(":").pop().trim();
  if(/Z$/.test(v)){ const iso=v.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/,"$1-$2-$3T$4:$5:$6Z"); const d=new Date(iso);
    return {ymd:ymdInTZ(d),hhmm:new Intl.DateTimeFormat("es",{timeZone:TZ,hour:"2-digit",minute:"2-digit",hour12:false}).format(d)}; }
  return {ymd:v.slice(0,8),hhmm:v.length>=13?v.slice(9,11)+":"+v.slice(11,13):"--:--"};
}
function decode(s){ s=(s||"").trim();
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
  let bruto=0; const filas=hoy.map(e=>{ const d=decode(e.summary); if(d.fee!=null) bruto+=d.fee; return e.dt.hhmm+"  "+d.nombre+" ("+d.tipo+(d.fee!=null?" - $"+d.fee:"")+")"; });
  return {message:"Agenda de hoy ("+hoy.length+" sesiones)\n"+filas.join("\n")+"\n\nBruto: $"+bruto+" - Tu parte (50%): $"+(bruto/2),bruto};
}
async function sendMessage(chatId,text){
  const token=process.env.TELEGRAM_BOT_TOKEN;
  await fetch("https://api.telegram.org/bot"+token+"/sendMessage",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id:chatId,text,disable_web_page_preview:true})});
}

module.exports = async (req, res) => {
  // --- Rama CRON: la llama Vercel cada manana (/api/telegram?cron=1) ---
  if (req.query && req.query.cron === "1") {
    const secret = process.env.CRON_SECRET; const auth = req.headers["authorization"] || "";
    if (secret && auth !== "Bearer " + secret) return res.status(401).json({ ok: false });
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!chatId) return res.status(500).json({ ok: false, error: "falta TELEGRAM_CHAT_ID" });
    await sendMessage(chatId, "Buenos dias, Manuel.\n\n" + (await fetchTodayAgenda()).message);
    return res.status(200).json({ ok: true });
  }
  // --- Rama WEBHOOK: mensajes que te llegan en Telegram ---
  if (req.method !== "POST") return res.status(200).send("ok");
  const update = req.body || {}; const msg = update.message || update.edited_message;
  if (!msg || !msg.text) return res.status(200).json({ ok: true });
  const chatId = String(msg.chat.id); const owner = process.env.TELEGRAM_CHAT_ID;
  if (owner && chatId !== String(owner)) { await sendMessage(chatId, "Este bot es privado."); return res.status(200).json({ ok: true }); }
  const text = msg.text.trim(); const lower = text.toLowerCase();
  try {
    if (lower === "/start") {
      await sendMessage(chatId, "Hola Manuel. Comandos:\n/hoy - agenda e ingresos de hoy\ngasto <monto> <concepto> - registra un gasto\n\nCada manana te envio la agenda.");
    } else if (lower === "/hoy" || lower === "/ingresos") {
      await sendMessage(chatId, (await fetchTodayAgenda()).message);
    } else if (lower.startsWith("gasto")) {
      const m = text.match(/gasto\s+(\d+(?:[.,]\d+)?)\s+(.*)/i);
      if (!m) { await sendMessage(chatId, "Formato: gasto <monto> <concepto>. Ej: gasto 20 luz"); }
      else {
        const monto = parseFloat(m[1].replace(",", ".")); const concepto = m[2].trim(); const url = process.env.GASTOS_WEBHOOK_URL;
        if (url) { await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tipo: "gasto", monto, concepto, fecha: new Date().toISOString() }) }); await sendMessage(chatId, "Gasto registrado: $" + monto + " - " + concepto); }
        else { await sendMessage(chatId, "Anotado (sin guardar, falta GASTOS_WEBHOOK_URL): $" + monto + " - " + concepto); }
      }
    } else { await sendMessage(chatId, "No entendi. Usa /hoy o: gasto 20 luz"); }
  } catch (e) { await sendMessage(chatId, "Error: " + (e.message || e)); }
  return res.status(200).json({ ok: true });
};
