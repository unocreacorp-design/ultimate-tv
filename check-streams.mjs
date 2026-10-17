// Revisa todos los canales de Ultimate TV y guarda en status.json los que transmiten ahora y son seguros.
// Lo ejecuta GitHub Actions cada 4 horas. Un canal se aprueba solo si:
//  - su lista .m3u8 responde por https con un certificado válido (Node rechaza certificados malos),
//  - no redirige a una dirección sin cifrar,
//  - permite reproducirse desde la página (cabecera CORS),
//  - y el siguiente archivo del video (variante o segmento) también responde por https.
// También revisa los logos: solo se aprueban los que cargan por https con certificado válido y son imágenes.
import fs from "node:fs";

const ORIGIN = "https://unocreacorp-design.github.io";
const UA = "Mozilla/5.0 (Linux; Android 12; Android TV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const WORKERS = 80;
const TIMEOUT = 8000;

async function getJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error(url + " " + r.status); return r.json(); }

async function head(url, n = 1024) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { signal: ctl.signal, redirect: "follow", headers: { Origin: ORIGIN, "User-Agent": UA } });
    let txt = "";
    if (r.ok && r.body) {
      const reader = r.body.getReader(); const dec = new TextDecoder();
      while (txt.length < n) { const c = await reader.read(); if (c.done) break; txt += dec.decode(c.value, { stream: true }); }
      try { await reader.cancel(); } catch {}
    }
    return { ok: r.ok, finalUrl: r.url, acao: r.headers.get("access-control-allow-origin") || "", type: r.headers.get("content-type") || "", txt };
  } catch { return null; } finally { clearTimeout(timer); }
}
const corsOk = (a) => a === "*" || a.includes(ORIGIN);

async function checkStream(url) {
  if (!url.startsWith("https://")) return false;
  const r = await head(url, 4096);
  if (!r || !r.ok || !r.finalUrl.startsWith("https://") || !corsOk(r.acao) || !r.txt.includes("#EXTM3U")) return false;
  // Siguiente archivo del video: debe ser https y responder
  const next = r.txt.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
  if (!next) return true;
  let nextUrl; try { nextUrl = new URL(next, r.finalUrl).href; } catch { return false; }
  if (!nextUrl.startsWith("https://")) return false;
  const n = await head(nextUrl, 64);
  return !!(n && n.ok && n.finalUrl.startsWith("https://") && corsOk(n.acao));
}
async function checkLogo(url) {
  if (!url.startsWith("https://")) return false;
  const r = await head(url, 16);
  return !!(r && r.ok && r.finalUrl.startsWith("https://") && /^image\//i.test(r.type));
}
async function runPool(items, fn, label) {
  const ok = []; let next = 0, done = 0;
  await Promise.all(Array.from({ length: WORKERS }, async () => {
    while (next < items.length) {
      const it = items[next++];
      if (await fn(it)) ok.push(it);
      if (++done % 1000 === 0) console.log(`${label}: ${done}/${items.length}, aprobados ${ok.length}`);
    }
  }));
  return ok.sort();
}

// 1) Canales
const streamsByUrl = new Map();
const streams = await getJSON("https://iptv-org.github.io/api/streams.json");
for (const s of streams) if (!s.referrer && !s.user_agent) streamsByUrl.set(s.url, s.channel || null);
const freeLogos = new Map();
try {
  const t = await (await fetch("https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8")).text();
  let logo = "";
  for (const raw of t.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("#EXTINF")) logo = (line.match(/tvg-logo="([^"]*)"/) || [])[1] || "";
    else if (/^https?:\/\//.test(line) && /\.m3u8?(\?|$)/i.test(line)) { if (!streamsByUrl.has(line)) streamsByUrl.set(line, null); if (logo) freeLogos.set(line, logo); logo = ""; }
  }
} catch (e) { console.warn("Free-TV no disponible:", e.message); }
const ok = await runPool([...streamsByUrl.keys()], checkStream, "canales");

// 2) Logos de los canales aprobados
const okChannels = new Set(ok.map((u) => streamsByUrl.get(u)).filter(Boolean));
const logoUrls = new Set();
try { for (const l of await getJSON("https://iptv-org.github.io/api/logos.json")) if (okChannels.has(l.channel)) logoUrls.add(l.url); } catch (e) { console.warn("logos:", e.message); }
for (const u of ok) if (freeLogos.has(u)) logoUrls.add(freeLogos.get(u));
const logos = await runPool([...logoUrls], checkLogo, "logos");

fs.writeFileSync("status.json", JSON.stringify({ updated: new Date().toISOString(), checked: streamsByUrl.size, ok, logos }));
console.log(`Listo: ${ok.length} de ${streamsByUrl.size} canales aprobados; ${logos.length} logos seguros.`);
