import express from 'express';
import axios from 'axios';

const app = express();
const PORT = 3000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
let tunnelUrl = null;

export function setTunnelUrl(url) {
    tunnelUrl = url;
    console.log(`[server] URL do tunel salva: ${url}`);
}

app.get('/tunnel-url', (req, res) => {
    if (tunnelUrl) res.json({ url: tunnelUrl });
    else res.status(404).json({ error: 'URL ainda nao disponivel' });
});

// Le ate maxBytes do stream SEM destruir o resto (pause/resume), p/ decidir playlist x binario
function lerCabecalho(stream, maxBytes) {
    return new Promise((resolve, reject) => {
        const parts = [];
        let len = 0, settled = false;
        const cleanup = () => {
            stream.removeListener('data', onData);
            stream.removeListener('end', onEnd);
            stream.removeListener('error', onErr);
        };
        const finish = (why) => {
            if (settled) return; settled = true;
            cleanup(); stream.pause();
            resolve({ buf: Buffer.concat(parts), ended: why === 'end' });
        };
        const onData = (c) => { parts.push(c); len += c.length; if (len >= maxBytes) finish('peek'); };
        const onEnd = () => finish('end');
        const onErr = (e) => { if (!settled) { settled = true; cleanup(); reject(e); } };
        stream.on('data', onData); stream.on('end', onEnd); stream.on('error', onErr);
    });
}

app.get('/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('Missing url');

    let upstream;
    try {
        upstream = await axios.get(targetUrl, {
            responseType: 'stream', timeout: 60000, maxContentLength: Infinity,
            validateStatus: () => true,
            headers: { 'Referer': 'https://embedtv.cc/', 'Origin': 'https://embedtv.cc', 'User-Agent': UA }
        });
    } catch (e) { return res.status(502).send('Upstream error: ' + e.message); }

    const ct = (upstream.headers['content-type'] || '').toLowerCase();
    res.setHeader('Access-Control-Allow-Origin', '*');

    let head;
    try { head = await lerCabecalho(upstream.data, 2048); }
    catch (e) { return res.status(500).send('Read error: ' + e.message); }

    const preview = head.buf.toString('latin1').replace(/^\uFEFF/, '');
    const ehPlaylist = ct.includes('mpegurl') || /^\s*#EXTM3U\b/i.test(preview);

    if (ehPlaylist) {
        let corpo = head.buf;
        if (!head.ended) { for await (const c of upstream.data) corpo = Buffer.concat([corpo, c]); }
        const texto = corpo.toString('utf8').replace(/^\uFEFF/, '');
        const baseUrl = new URL(targetUrl);
        const out = texto.split('\n').map(line => {
            const l = line.trim();
            if (!l || l.startsWith('#')) return line;
            return `/proxy?url=${encodeURIComponent(new URL(l, baseUrl).toString())}`;
        }).join('\n');
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        return res.send(out);
    }

    // binario/segmento: encaminha cru (peek + resto), preservando bytes
    const cl = upstream.headers['content-length'];
    if (cl) res.setHeader('Content-Length', cl);
    res.setHeader('Content-Type', ct || 'application/octet-stream');
    upstream.data.on('error', (e) => { if (!res.headersSent) res.status(500).send(e.message); else res.destroy(); });
    res.write(head.buf);
    upstream.data.pipe(res);
});

app.listen(PORT, '0.0.0.0', () => console.log(`Proxy embedtv rodando na porta ${PORT}`));
