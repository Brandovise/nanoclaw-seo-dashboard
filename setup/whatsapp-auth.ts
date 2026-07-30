/**
 * Step: whatsapp-auth — standalone WhatsApp authentication.
 *
 * Supports three methods:
 *   --method qr-browser    Opens a local HTTP server with a large scannable QR code
 *   --method qr-terminal   Prints QR code in the terminal
 *   --method pairing-code  Requests a pairing code (requires --phone <number>)
 *
 * On success, credentials are saved to store/auth/ and the process exits.
 */
import fs from 'fs';
import path from 'path';
import http from 'http';
import { createRequire } from 'module';
// Named import (not default) — see src/channels/whatsapp.ts for the why.
import { pino } from 'pino';

import {
  makeWASocket,
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import { emitStatus } from './status.js';

const AUTH_DIR = path.join(process.cwd(), 'store', 'auth');
const PAIRING_CODE_FILE = path.join(process.cwd(), 'store', 'pairing-code.txt');
const baileysLogger = pino({ level: 'silent' });

// proto is not available as a named ESM export — use createRequire (same as v1)
const _require = createRequire(import.meta.url);
const { proto } = _require('@whiskeysockets/baileys') as { proto: any };
try {
  const _generics = _require('@whiskeysockets/baileys/lib/Utils/generics') as Record<string, unknown>;
  _generics.getPlatformId = (browser: string): string => {
    const platformType =
      proto.DeviceProps.PlatformType[browser.toUpperCase() as keyof typeof proto.DeviceProps.PlatformType];
    return platformType ? platformType.toString() : '1';
  };
} catch {
  // QR auth still works without this patch
}

type AuthMethod = 'qr-browser' | 'qr-terminal' | 'pairing-code';

function parseArgs(args: string[]): { method: AuthMethod; phone?: string } {
  let method: AuthMethod = 'qr-terminal';
  let phone: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--method':
        method = args[++i] as AuthMethod;
        break;
      case '--phone':
        phone = args[++i];
        break;
    }
  }

  if (method === 'pairing-code' && !phone) {
    console.error('--phone is required for pairing-code method');
    process.exit(1);
  }

  return { method, phone };
}

/** Serve a web page with a large QR code. Returns cleanup function. */
function startQrServer(port: number): {
  updateQr: (qr: string) => void;
  close: () => void;
  url: string;
} {
  let currentQr = '';
  let waitingClients: Array<http.ServerResponse> = [];

  const server = http.createServer((_req, res) => {
    if (_req.url === '/poll') {
      // Long-poll endpoint for QR updates
      if (currentQr) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(currentQr);
      } else {
        waitingClients.push(res);
        // Timeout after 30s
        setTimeout(() => {
          const idx = waitingClients.indexOf(res);
          if (idx !== -1) {
            waitingClients.splice(idx, 1);
            res.writeHead(204);
            res.end();
          }
        }, 30000);
      }
      return;
    }

    if (_req.url === '/authenticated') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html><html><body style="display:flex;justify-content:center;align-items:center;height:100vh;margin:0;font-family:system-ui;font-size:2em;color:#22c55e">Authenticated!</body></html>`);
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html>
<html>
<head>
  <title>WhatsApp Auth</title>
  <script src="https://cdn.jsdelivr.net/npm/qrcode@1/build/qrcode.min.js"></script>
  <style>
    body { display:flex; flex-direction:column; justify-content:center; align-items:center; height:100vh; margin:0; font-family:system-ui; background:#111; color:#fff; }
    #qr { margin:2em 0; }
    canvas { border-radius: 12px; }
    .status { font-size:1.2em; opacity:0.7; }
  </style>
</head>
<body>
  <h2>Scan with WhatsApp</h2>
  <p class="status">Settings → Linked Devices → Link a Device</p>
  <div id="qr"></div>
  <p class="status" id="timer">Waiting for QR code...</p>
  <script>
    let lastQr = '';
    async function poll() {
      try {
        const res = await fetch('/poll');
        if (res.status === 200) {
          const qr = await res.text();
          if (qr && qr !== lastQr) {
            lastQr = qr;
            document.getElementById('qr').innerHTML = '';
            QRCode.toCanvas(qr, { width: 400, margin: 2 }, (err, canvas) => {
              if (!err) document.getElementById('qr').appendChild(canvas);
            });
            document.getElementById('timer').textContent = 'QR code ready — scan now';
          }
        }
      } catch {}
      setTimeout(poll, 1000);
    }
    poll();
  </script>
</body>
</html>`);
  });

  server.listen(port, '127.0.0.1');

  return {
    updateQr(qr: string) {
      currentQr = qr;
      for (const res of waitingClients) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(qr);
      }
      waitingClients = [];
    },
    close() {
      server.close();
    },
    url: `http://127.0.0.1:${port}`,
  };
}

export async function run(args: string[]): Promise<void> {
  const { method, phone } = parseArgs(args);

  // Clean previous auth if present
  if (fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) {
    emitStatus('WHATSAPP_AUTH', {
      STATUS: 'already-authenticated',
      AUTH_DIR,
    });
    return;
  }

  fs.mkdirSync(AUTH_DIR, { recursive: true });

  let qrServer: ReturnType<typeof startQrServer> | undefined;
  if (method === 'qr-browser') {
    qrServer = startQrServer(9437);

    emitStatus('WHATSAPP_AUTH', {
      STATUS: 'qr-browser-started',
      URL: qrServer.url,
    });
    // Try to open browser
    const { exec } = await import('child_process');
    const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    exec(`${openCmd} ${qrServer.url}`);
  }

  return new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      emitStatus('WHATSAPP_AUTH', { STATUS: 'failed', ERROR: 'timeout' });
      qrServer?.close();
      process.exit(1);
    }, 120_000);

    let succeeded = false;
    function succeed(): void {
      if (succeeded) return;
      succeeded = true;
      clearTimeout(timeout);
      try { if (fs.existsSync(PAIRING_CODE_FILE)) fs.unlinkSync(PAIRING_CODE_FILE); } catch {}
      emitStatus('WHATSAPP_AUTH', { STATUS: 'authenticated' });
      qrServer?.close();
      resolve();
      // Give a moment for creds to flush, then exit
      setTimeout(() => process.exit(0), 1000);
    }

    async function connectSocket(isReconnect = false): Promise<void> {
      const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
      const { version } = await fetchLatestWaWebVersion({}).catch(() => ({ version: undefined }));

      const sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
        },
        printQRInTerminal: false,
        logger: baileysLogger,
        browser: Browsers.macOS('Chrome'),
      });

      // Request pairing code only on first connect (not reconnect after 515)
      if (!isReconnect && method === 'pairing-code' && phone && !state.creds.registered) {
        setTimeout(async () => {
          try {
            const code = await sock.requestPairingCode(phone);
            fs.writeFileSync(PAIRING_CODE_FILE, code, 'utf-8');
            emitStatus('WHATSAPP_AUTH', {
              STATUS: 'pairing-code-ready',
              CODE: code,
              REMINDER_TO_ASSISTANT: 'Your next user-visible message MUST include this CODE in plain text.',
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            emitStatus('WHATSAPP_AUTH', { STATUS: 'failed', ERROR: message });
            process.exit(1);
          }
        }, 3000);
      }

      sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          if (method === 'qr-browser' && qrServer) {
            qrServer.updateQr(qr);
          } else if (method === 'qr-terminal') {
            (async () => {
              try {
                const QRCode = await import('qrcode');
                const qrText = await QRCode.toString(qr, { type: 'terminal' });
                console.log('\nWhatsApp QR code — scan with WhatsApp > Linked Devices:\n');
                console.log(qrText);
              } catch {
                console.log('QR code (raw):', qr);
              }
            })();
          }
        }

        if (connection === 'open') {
          succeed();
          sock.end(undefined);
        }

        if (connection === 'close') {
          const reason = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
          if (reason === DisconnectReason.loggedOut) {
            clearTimeout(timeout);
            emitStatus('WHATSAPP_AUTH', { STATUS: 'failed', ERROR: 'logged_out' });
            qrServer?.close();
            process.exit(1);
          } else if (reason === DisconnectReason.timedOut) {
            clearTimeout(timeout);
            emitStatus('WHATSAPP_AUTH', { STATUS: 'failed', ERROR: 'qr_timeout' });
            qrServer?.close();
            process.exit(1);
          } else if (reason === 515) {
            // 515 = stream error, happens after pairing succeeds but before
            // registration completes. Reconnect to finish the handshake.
            connectSocket(true);
          }
        }
      });

      sock.ev.on('creds.update', saveCreds);
    }

    connectSocket();
  });
}
