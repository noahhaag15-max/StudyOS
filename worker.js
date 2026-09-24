/**
 * Study OS — Push-Worker (Cloudflare Workers)
 *
 * Aufgabe: Erinnerungen zuverlässig auch bei geschlossener App senden (Web Push, VAPID).
 * Datenschutz: Der Worker kennt NUR die Push-Adresse des Geräts und eine Liste fertiger Erinnerungen
 * (Zeitpunkt, Titel, Text) für die nächsten Tage. Er liest NICHT den Gist und hat keinen GitHub-Token.
 *
 * Bindings (Cloudflare-Dashboard):
 *   KV            KV-Namespace (Variablenname genau «KV»)
 *   ALLOWED_ORIGIN  z. B. https://DEIN-NAME.github.io   (nur diese Seite darf den Worker ansprechen)
 *   VAPID_SUBJECT   z. B. mailto:du@example.ch           (Kontakt für Push-Dienste)
 *   ANTHROPIC_KEY   optional, als Secret — nur für /extract (Lagebericht-Schnellerfassung) nötig, sonst leer lassen
 * Cron-Trigger: alle 5 Minuten (*​/5 * * * *)
 *
 * Endpunkte (alle ausser GET / brauchen den passenden Origin-Header):
 *   GET  /vapid                     → { publicKey }
 *   POST /subscribe  { id, sub }    → Gerät speichern
 *   POST /schedule   { id, items }  → Erinnerungen ersetzen  (items: [{ t, title, body, tag, url }], t = ms seit 1970)
 *   POST /unsubscribe{ id }         → Gerät und Erinnerungen löschen
 *   POST /test       { id }         → sofort eine Test-Erinnerung senden
 *   GET  /pending?id=               → fällige Erinnerungen abholen (macht der Service Worker beim Push-Signal)
 *   POST /extract    { text }       → Lagebericht-Meldung aus eingefügtem Text vorschlagen (JSON, kein GitHub-Bezug,
 *                                      antwortet mit { error: 'kein Schlüssel konfiguriert' }, wenn ANTHROPIC_KEY fehlt)
 *
 * Die VAPID-Schlüssel erzeugt der Worker beim ersten Aufruf selbst und legt sie im KV ab (Schlüssel «vapid»).
 */

const enc = new TextEncoder();
const ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_ITEMS = 400;

const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function corsHeaders(env, req) {
  const origin = req.headers.get('Origin') || '';
  const allowed = env.ALLOWED_ORIGIN || '';
  const ok = allowed ? origin === allowed : true;
  return {
    ok,
    headers: {
      'Access-Control-Allow-Origin': ok ? (allowed || '*') : 'null',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    },
  };
}
const json = (obj, status, extra) => new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, extra || {}) });

async function vapidKeys(env) {
  const have = await env.KV.get('vapid', 'json');
  if (have) return have;
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const priv = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const pub = b64u(await crypto.subtle.exportKey('raw', kp.publicKey));
  const k = { priv, pub };
  await env.KV.put('vapid', JSON.stringify(k));
  return k;
}

async function vapidAuth(env, endpoint) {
  const k = await vapidKeys(env);
  const header = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64u(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || 'mailto:studyos@example.com',
  })));
  const key = await crypto.subtle.importKey('jwk', k.priv, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(header + '.' + payload));
  return 'vapid t=' + header + '.' + payload + '.' + b64u(sig) + ', k=' + k.pub;
}

// Leeres Push-Signal (Inhalt holt der Service Worker bei /pending) — kein Verschlüsseln nötig
async function sendSignal(env, sub) {
  if (!sub || !sub.endpoint) return { r: 'gone', status: 0, detail: '' };
  try {
    const r = await fetch(sub.endpoint, { method: 'POST', headers: { Authorization: await vapidAuth(env, sub.endpoint), TTL: '3600', Urgency: 'normal' } });
    if (r.status === 404 || r.status === 410) return { r: 'gone', status: r.status, detail: '' };
    if (r.ok) return { r: 'ok', status: r.status, detail: '' };
    let d = ''; try { d = (await r.text()).slice(0, 200); } catch (e) { /* egal */ }
    return { r: 'error:' + r.status, status: r.status, detail: d };
  } catch (e) { return { r: 'error', status: 0, detail: String(e).slice(0, 200) }; }
}

const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
function cleanItems(items) {
  if (!Array.isArray(items)) return [];
  const now = Date.now(), out = [];
  for (const i of items) {
    const t = Number(i && i.t);
    if (!isFinite(t) || t < now - 3600e3 || t > now + 40 * 86400e3) continue;
    out.push({ t: Math.round(t), title: clip(i.title, 80), body: clip(i.body, 200), tag: clip(i.tag, 60), url: clip(i.url, 200) });
    if (out.length >= MAX_ITEMS) break;
  }
  return out.sort((a, b) => a.t - b.t);
}

// ── Lagebericht: Text einfügen → Meldung vorschlagen (Claude API, Key bleibt serverseitig als Secret) ──
function extractPrompt() {
  const today = new Date().toISOString().slice(0, 10);
  return 'Du liest einen eingefügten Nachrichtentext und schlägst daraus eine Meldung für ein privates Lageberichts-Archiv vor. '
    + 'Antworte AUSSCHLIESSLICH mit einem einzigen JSON-Objekt, ohne Erklärung, ohne Markdown-Codeblock, exakt in diesem Format:\n'
    + '{"laender":["XXX"],"datum":"JJJJ-MM-TT","kategorie":"beschaffung|entwicklung|einsatz|uebung|stationierung|politik|abkommen|export|krise|industrie|cyber|unfall|sonstiges","titel":"...","text":"...","sicherheit":"bestaetigt|wahrscheinlich|unbestaetigt","systeme":["..."],"ereignis":"rollout|erstflug|test|serie|auslieferung|indienst|ersteinsatz|verlust|ausmusterung|","tags":["..."]}\n\n'
    + 'Regeln:\n'
    + '- laender: ISO-3166-alpha-3-Codes (z. B. "USA","DEU","CHE"), mindestens eines, alle im Text klar betroffenen Länder.\n'
    + '- datum: Datum der Meldung/des Ereignisses, falls im Text erkennbar, sonst "' + today + '".\n'
    + '- kategorie: die am besten passende der vorgegebenen Kategorien. "entwicklung" für Rollouts, Erstflüge, Tests und Prototypen (auch ohne Beschaffung), "beschaffung" nur bei Kauf/Bestellung/Lieferung an Streitkräfte, "export" bei Verkauf ins Ausland, "stationierung" bei Verlegung/Stationierung von Truppen oder Systemen.\n'
    + '- systeme: konkrete Waffensysteme, Flugzeuge, Schiffe, Fahrzeuge usw., die im Text NAMENTLICH genannt werden (z. B. "J-36", "B-21", "Leopard 2A8"). Leere Liste, wenn keine genannt sind.\n'
    + '- ereignis: nur wenn eindeutig, sonst "" (leer). rollout=Vorstellung, erstflug=Erstflug, test=Test/Erprobung, serie=Serienproduktion, auslieferung=Erstauslieferung, indienst=Indienststellung, ersteinsatz=erster Einsatz, verlust=Verlust/Absturz, ausmusterung=Ausmusterung.\n'
    + '- titel: kurz (max. 80 Zeichen), sachlich, keine Wertung.\n'
    + '- text: 2 bis 5 Sätze Zusammenfassung, sachlich, keine eigene Meinung.\n'
    + '- sicherheit: "bestaetigt" nur bei klar berichteten Fakten ohne Konjunktiv. "wahrscheinlich" bei Formulierungen wie "dürfte", "mutmasslich", "Berichten zufolge", "soll". "unbestaetigt" bei Gerüchten oder einer einzelnen unbestätigten Quelle.\n'
    + '- tags: nur Einheiten, Programme oder Operationen, die im Text NAMENTLICH genannt werden (Systeme gehören in "systeme"). Nicht raten.\n'
    + '- Erfinde keine Fakten, die nicht im Text stehen. Im Zweifel sicherheit eine Stufe vorsichtiger wählen, statt einen Fakt zu behaupten.';
}
async function handleExtract(req, env, H) {
  const text = await req.text();
  if (text.length > 20000) return json({ error: 'gross' }, 413, H);
  let body; try { body = JSON.parse(text); } catch (e) { return json({ error: 'json' }, 400, H); }
  const input = clip(body && body.text, 6000).trim();
  if (!input) return json({ error: 'leer' }, 400, H);
  if (!env.ANTHROPIC_KEY) return json({ error: 'kein Schlüssel konfiguriert' }, 501, H);
  let r;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1000, system: extractPrompt(), messages: [{ role: 'user', content: input }] }),
    });
  } catch (e) { return json({ error: 'netz' }, 502, H); }
  if (!r.ok) return json({ error: 'anthropic:' + r.status }, 502, H);
  let data; try { data = await r.json(); } catch (e) { return json({ error: 'antwort' }, 502, H); }
  const out = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let parsed;
  try { parsed = JSON.parse(out); } catch (e) { const m = out.match(/\{[\s\S]*\}/); parsed = m ? safeParse(m[0]) : null; }
  if (!parsed || typeof parsed !== 'object') return json({ error: 'parse' }, 502, H);
  return json(parsed, 200, H);
}
function safeParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }

async function handle(req, env) {
  const url = new URL(req.url), path = url.pathname.replace(/\/+$/, '') || '/';
  const cors = corsHeaders(env, req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors.headers });
  if (path === '/') return new Response('Study OS Push-Worker läuft.', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  if (!cors.ok) return json({ error: 'origin' }, 403, cors.headers);
  const H = cors.headers;

  if (path === '/vapid' && req.method === 'GET') return json({ publicKey: (await vapidKeys(env)).pub }, 200, H);

  if (path === '/pending' && req.method === 'GET') {
    const id = url.searchParams.get('id') || '';
    if (!ID_RE.test(id)) return json({ error: 'id' }, 400, H);
    const list = (await env.KV.get('pend:' + id, 'json')) || [];
    if (list.length) await env.KV.delete('pend:' + id);
    return json(list, 200, H);
  }

  // Lagebericht-Schnellerfassung: kein Geräte-/GitHub-Bezug, darum vor der generischen id-Prüfung behandelt.
  if (path === '/extract' && req.method === 'POST') return handleExtract(req, env, H);

  if (req.method !== 'POST') return json({ error: 'method' }, 405, H);
  const text = await req.text();
  if (text.length > 200000) return json({ error: 'gross' }, 413, H);
  let body; try { body = JSON.parse(text); } catch (e) { return json({ error: 'json' }, 400, H); }
  const id = body && body.id;
  if (!ID_RE.test(id || '')) return json({ error: 'id' }, 400, H);

  if (path === '/subscribe') {
    const s = body.sub;
    if (!s || typeof s.endpoint !== 'string' || !/^https:\/\//.test(s.endpoint)) return json({ error: 'sub' }, 400, H);
    await env.KV.put('dev:' + id, JSON.stringify({ sub: { endpoint: s.endpoint, keys: s.keys || {} }, at: Date.now() }));
    return json({ ok: true }, 200, H);
  }
  if (path === '/schedule') {
    const items = cleanItems(body.items);
    const old = (await env.KV.get('sched:' + id, 'json')) || {};
    await env.KV.put('sched:' + id, JSON.stringify({ items, last: old.last || 0, updated: Date.now() }));
    return json({ ok: true, n: items.length }, 200, H);
  }
  if (path === '/unsubscribe') {
    await Promise.all(['dev:', 'sched:', 'pend:'].map((p) => env.KV.delete(p + id)));
    return json({ ok: true }, 200, H);
  }
  if (path === '/test') {
    const dev = await env.KV.get('dev:' + id, 'json');
    if (!dev) return json({ error: 'kein Gerät' }, 404, H);
    const pend = (await env.KV.get('pend:' + id, 'json')) || [];
    pend.push({ title: 'Study OS', body: 'Test: Erinnerungen funktionieren ✓', tag: 'test', url: './' });
    await env.KV.put('pend:' + id, JSON.stringify(pend.slice(-20)), { expirationTtl: 86400 });
    const r = await sendSignal(env, dev.sub);
    if (r.r === 'gone') await Promise.all(['dev:', 'sched:', 'pend:'].map((p) => env.KV.delete(p + id)));
    return json({ result: r.r, status: r.status, detail: r.detail, endpoint: new URL(dev.sub.endpoint).hostname }, 200, H);
  }
  return json({ error: 'pfad' }, 404, H);
}

// Cron: fällige Erinnerungen bereitstellen und das Gerät anstossen
async function runDue(env) {
  const now = Date.now(); let cursor, sent = 0;
  do {
    const l = await env.KV.list({ prefix: 'sched:', cursor, limit: 100 });
    for (const k of l.keys) {
      const id = k.name.slice(6);
      const s = await env.KV.get(k.name, 'json');
      if (!s || !Array.isArray(s.items)) continue;
      const due = s.items.filter((i) => i.t <= now && i.t > (s.last || 0) && i.t > now - 45 * 60e3);
      if (!due.length) continue;
      const dev = await env.KV.get('dev:' + id, 'json');
      if (!dev) continue;
      const pend = (await env.KV.get('pend:' + id, 'json')) || [];
      due.forEach((i) => pend.push({ title: i.title, body: i.body, tag: i.tag, url: i.url || './' }));
      await env.KV.put('pend:' + id, JSON.stringify(pend.slice(-20)), { expirationTtl: 86400 });
      s.last = Math.max(...due.map((i) => i.t));
      s.items = s.items.filter((i) => i.t > now - 3600e3);
      await env.KV.put(k.name, JSON.stringify(s));
      const r = (await sendSignal(env, dev.sub)).r; sent++;
      if (r === 'gone') await Promise.all(['dev:', 'sched:', 'pend:'].map((p) => env.KV.delete(p + id)));
    }
    cursor = l.list_complete ? undefined : l.cursor;
  } while (cursor);
  return sent;
}

export default {
  async fetch(req, env) { try { return await handle(req, env); } catch (e) { return json({ error: 'intern' }, 500); } },
  async scheduled(event, env, ctx) { ctx.waitUntil(runDue(env)); },
};
