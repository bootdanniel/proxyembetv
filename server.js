import express from 'express';
import axios from 'axios';

const app = express();
const PORT = 3000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const CATALOG_URL = process.env.CATALOG_URL || 'https://raw.githubusercontent.com/bootdanniel/catalogo-embedtv/main/catalog.json';
const TTL_MS = 5 * 60 * 1000;            // recarrega o catálogo a cada 5 min
const DEFAULT_REF = 'https://embedtv.cc/';
const DEFAULT_ORIG = 'https://embedtv.cc';

let canais = new Map();       // id -> { url, referer, origin }  (primeiro servidor)
let servidores = new Map();   // id -> [ {url,referer,origin}, ... ]
let ultimaContagem = -1;

function montar(arr) {
  const c = new Map(), s = new Map();
  for (const item of arr) {
    if (!item || !item.id || !Array.isArray(item.servidores) || !item.servidores.length) continue;
    const lista = item.servidores
      .map(x => ({ url: x.url, referer: x.referer || DEFAULT_REF, origin: x.origin || DEFAULT_ORIG }))
      .filter(x => x.url);
    if (!lista.length) continue;
    s.set(item.id, lista);
    c.set(item.id, lista[0]);
  }
  return { c, s };
}

async function carregar(motivo) {
  try {
    const sep = CATALOG_URL.includes('?') ? '&' : '?';
    const r = await axios.get(CATALOG_URL + sep + 't=' + Date.now(), { timeout: 15000, responseType: 'json' });
    const arr = Array.isArray(r.data) ? r.data : (r.data && Array.isArray(r.data.canais) ? r.data.canais : null);
    if (!arr) { console.log(`[cat] ${motivo}: resposta nao e array valido, mantendo anterior.`); return; }
    const { c, s } = montar(arr);
    if (c.size === 0) { console.log(`[cat] ${motivo}: array sem ids validos, mantendo ${canais.size}.`); return; }
    canais = c; servidores = s;
    if (c.size !== ultimaContagem) { console.log(`[cat] ${motivo}: ${c.size} canais carregados.`); ultimaContagem = c.size; }
  } catch (e) {
    console.log(`[cat] ${motivo}: falha (${e.message}); mantendo ${canais.size} canais.`);
  }
}

await carregar('boot');
setInterval(() => carregar('ttl'), TTL_MS);

let tunnelUrl = null;
export function setTunnelUrl(url) { tunnelUrl = url; console.log(`[server] tunel: ${url}`); }
app.get('/tunnel-url', (req, res) => tunnelUrl ? res.json({ url: tunnelUrl }) : res.status(404).json({ error: 'URL ainda nao disponivel' }));

function lerCabecalho(stream, maxBytes) {
  return new Promise((resolve, reject) => {
    const parts = []; let len = 0, settled = false;
    const cleanup = () => { stream.removeListener('data', onData); stream.removeListener('end', onEnd); stream.removeListener('error', onErr); };
    const finish = (why) => { if (settled) return; settled = true; cleanup(); stream.pause(); resolve({ buf: Buffer.concat(parts), ended: why === 'end' }); };
    const onData = (c) => { parts.push(c); len += c.length; if (len >= maxBytes) finish('peek'); };
    const onEnd = () => finish('end');
    const onErr = (e) => { if (!settled) { settled = true; cleanup(); reject(e); } };
    stream.on('data', onData); stream.on('end', onEnd); stream.on('error', onErr);
  });
}

// nucleo: baixa target com referer/origin certos; se for playlist HLS reescreve segmentos (amarrando ao cid p/ manter o referer do canal)
async function servir(target, referer, origin, cid, res) {
  let upstream;
  try {
    upstream = await axios.get(target, {
      responseType: 'stream', timeout: 60000, maxContentLength: Infinity, validateStatus: () => true,
      headers: { 'Referer': referer, 'Origin': origin, 'User-Agent': UA }
    });
  } catch (e) { return res.status(502).send('Upstream error: ' + e.message); }

  const ct = (upstream.headers['content-type'] || '').toLowerCase();
  res.setHeader('Access-Control-Allow-Origin', '*');

  let head; try { head = await lerCabecalho(upstream.data, 2048); } catch (e) { return res.status(500).send('Read error: ' + e.message); }
  const preview = head.buf.toString('latin1').replace(/^\uFEFF/, '');
  const ehPlaylist = ct.includes('mpegurl') || /^\s*#EXTM3U\b/i.test(preview);

  if (ehPlaylist) {
    let corpo = head.buf;
    if (!head.ended) { for await (const ch of upstream.data) corpo = Buffer.concat([corpo, ch]); }
    const texto = corpo.toString('utf8').replace(/^\uFEFF/, '');
    const baseUrl = new URL(target);
    const sufixo = cid ? `&cid=${encodeURIComponent(cid)}` : '';
    const out = texto.split('\n').map(line => {
      const l = line.trim();
      if (!l || l.startsWith('#')) return line;
      return `/proxy?url=${encodeURIComponent(new URL(l, baseUrl).toString())}${sufixo}`;
    }).join('\n');
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    return res.send(out);
  }

  const cl = upstream.headers['content-length']; if (cl) res.setHeader('Content-Length', cl);
  res.setHeader('Content-Type', ct || 'application/octet-stream');
  upstream.data.on('error', (e) => { if (!res.headersSent) res.status(500).send(e.message); else res.destroy(); });
  res.write(head.buf);
  upstream.data.pipe(res);
}

// >>> rota por ID (o que o seu site vai usar)
app.get('/proxy/:id', (req, res) => {
  const id = req.params.id;
  const idx = parseInt(req.query.s) || 0;
  const lista = servidores.get(id);
  const canal = (lista && lista[idx]) || canais.get(id);
  if (!canal) return res.status(404).json({ error: 'canal nao encontrado no catalogo', id, catalogo: canais.size });
  servir(canal.url, canal.referer, canal.origin, id, res);
});

// >>> rota legada por URL (compatibilidade; continua "aberta" como no projeto 1)
app.get('/proxy', (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send('Missing url');
  const cid = req.query.cid;
  let referer = DEFAULT_REF, origin = DEFAULT_ORIG;
  if (cid && canais.has(cid)) { referer = canais.get(cid).referer; origin = canais.get(cid).origin; }
  servir(target, referer, origin, cid || null, res);
});

app.listen(PORT, '0.0.0.0', () => console.log(`Proxy embedtv (modo catalogo) na porta ${PORT}`));
