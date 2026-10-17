// Revisa todos los canales de Ultimate TV y guarda en status.json los que transmiten ahora.
// Lo ejecuta GitHub Actions cada 4 horas. Un canal cuenta como "con señal" si su lista .m3u8
// responde y además permite reproducirse desde la página (cabecera CORS).
import fs from "node:fs";

const ORIGIN = "https://unocreacorp-design.github.io";
const UA = "Mozilla/5.0 (Linux; Android 12; Android TV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const WORKERS = 48;
const TIMEOUT = 10000;

async function getJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error(url + " " + r.status); return r.json(); }

const urls = new Set();
const streams = await getJSON("https://iptv-org.github.io/api/streams.json");
for (const s of streams) if (!s.referrer && !s.user_agent) urls.add(s.url);
try {
  const t = await (await fetch("https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8")).text();
  for (const line of t.split(/\r?\n/)) { const u = line.trim(); if (/^https?:\/\//.test(u) && /\.m3u8?(\?|$)/i.test(u)) urls.add(u); }
} catch (e) { console.warn("Free-TV no disponible:", e.message); }

async function check(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { signal: ctl.signal, redirect: "follow", headers: { Origin: ORIGIN, "User-Agent": UA } });
    if (!r.ok) return false;
    const acao = r.headers.get("access-control-allow-origin") || "";
    if (acao !== "*" && !acao.includes(ORIGIN)) return false;
    const reader = r.body.getReader(); const dec = new TextDecoder(); let txt = "";
    while (txt.length < 512) { const c = await reader.read(); if (c.done) break; txt += dec.decode(c.value, { stream: true }); }
    try { await reader.cancel(); } catch {}
    return txt.includes("#EXTM3U");
  } catch { return false; } finally { clearTimeout(timer); }
}

const list = [...urls]; const ok = []; let next = 0, done = 0;
await Promise.all(Array.from({ length: WORKERS }, async () => {
  while (next < list.length) {
    const u = list[next++];
    if (await check(u)) ok.push(u);
    if (++done % 500 === 0) console.log(`${done}/${list.length} revisados, ${ok.length} con señal`);
  }
}));
ok.sort();
fs.writeFileSync("status.json", JSON.stringify({ updated: new Date().toISOString(), checked: list.length, ok }));
console.log(`Listo: ${ok.length} de ${list.length} canales con señal.`);
