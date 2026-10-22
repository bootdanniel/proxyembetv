import './server.js';
import { setTunnelUrl } from './server.js';
import { spawn } from 'child_process';
import axios from 'axios';

console.log("Iniciando o Cloudflare Tunnel...");
const tunnel = spawn('cloudflared', [
    'tunnel', '--no-autoupdate', '--protocol', 'http2',
    '--url', 'http://localhost:3000', '--metrics', '127.0.0.1:20241'
]);

tunnel.on('error', (err) => console.error('[tunnel] FALHA AO EXECUTAR cloudflared:', err.message));

let urlEncontrada = false;
function capturar(s) {
    if (!urlEncontrada) {
        const m = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m) { setTunnelUrl(m[0]); urlEncontrada = true; }
    }
}
tunnel.stdout.on('data', d => { const s = String(d); console.log(`[tunnel]: ${s.trim()}`); capturar(s); });
tunnel.stderr.on('data', d => { const s = String(d); console.error(`[tunnel]: ${s.trim()}`); capturar(s); });

async function esperarTunnel() {
    for (let i = 0; i < 30; i++) {
        if (urlEncontrada) return;
        try {
            const res = await axios.get('http://127.0.0.1:20241/quicktunnel');
            if (res.data && res.data.hostname) { setTunnelUrl(`https://${res.data.hostname}`); urlEncontrada = true; return; }
        } catch (e) {}
        await new Promise(r => setTimeout(r, 1000));
    }
}
esperarTunnel();
