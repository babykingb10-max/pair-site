const { makeid } = require('./id');
const QRCode = require('qrcode');
const express = require('express');
const fs = require('fs');
const pino = require('pino');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    Browsers,
    delay,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion,
    DisconnectReason,
} = require("@whiskeysockets/baileys");
const { sendButtons, btn } = require('wolfbtns');
const store = require('./store');

let router = express.Router();

function removeFile(FilePath) {
    if (!fs.existsSync(FilePath)) return false;
    fs.rmSync(FilePath, { recursive: true, force: true });
}

/**
 * Waits for creds.json to actually exist on disk instead of trusting a
 * fixed sleep. Polls every second for up to `timeoutMs`.
 */
async function waitForCredsFile(filePath, timeoutMs = 20000, intervalMs = 1000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (fs.existsSync(filePath)) {
            try {
                const data = fs.readFileSync(filePath);
                if (data && data.length > 0) return data;
            } catch (e) {
                // file may still be mid-write, keep polling
            }
        }
        await delay(intervalMs);
    }
    throw new Error('creds.json was not created in time — the device link likely did not finish.');
}

router.get('/', async (req, res) => {
    const id = makeid(6);
    store.createEntry(id);
    let sessionHandled = false; // guards against duplicate 'open' events across reconnect attempts

    async function JUNEX() {
        const { state, saveCreds } = await useMultiFileAuthState('./temp/' + id);
        try {
            const { version } = await fetchLatestBaileysVersion();
            const logger = pino({ level: 'silent' });

            let client = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, logger),
                },
                printQRInTerminal: false,
                logger,
                browser: Browsers.ubuntu('Chrome'),
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 10000,
            });

            client.ev.on('creds.update', saveCreds);

            client.ev.on('connection.update', async (s) => {
                const { connection, lastDisconnect, qr } = s;

                if (qr && !res.headersSent) {
                    res.setHeader('X-Session-Id', id);
                    res.setHeader('Access-Control-Expose-Headers', 'X-Session-Id');
                    await res.end(await QRCode.toBuffer(qr));
                }

                if (connection === 'open') {
                    if (sessionHandled) return; // already generated a session for this pairing, ignore repeat 'open' events
                    sessionHandled = true;
                    try {
                        // Grace period so the Signal session between this bot and the
                        // phone finishes syncing before we send anything — sending too
                        // early is what causes "Waiting for this message" on WhatsApp.
                        await delay(4000);
                        await client.sendMessage(client.user.id, {
                            text: '*Generating your session, please wait a moment...*'
                        });
                        // Wait for creds.json to actually exist instead of guessing a fixed delay.
                        let data = await waitForCredsFile(__dirname + `/temp/${id}/creds.json`);
                        let b64data = Buffer.from(data).toString('base64');
                        let sessionText = 'ADEVOS-X:~' + b64data;

                        store.setReady(id, sessionText);

                        let session;
                        try {
                            // Native "Copy" button under the session message.
                            session = await sendButtons(client, client.user.id, {
                                text: sessionText,
                                footer: 'Adevos-X Tech',
                                buttons: [
                                    btn.copy('Copy', sessionText),
                                ],
                            });
                        } catch (btnErr) {
                            console.log('Copy button unsupported, sending plain text:', btnErr?.message);
                            session = await client.sendMessage(client.user.id, { text: sessionText });
                        }
                        await client.sendMessage(client.user.id, {
                            text: "SESSION ID GENERATED SUCCESSFULLY\n\n 1. Copy the session code above or return to the *Web Dashboard* to copy it directly.\n 2. *Do NEVER* share this Session ID with anyone. It gives full access to your WhatsApp account.\n 3. Paste this Session ID into your deployment environment variable *(SESSION_ID)* when setting up your Adevos-X Bot.\n\n> *Powered by Adevos-X Tech*"
                        }, { quoted: session });
                        await delay(500);
                        await client.ws.close();
                        removeFile('./temp/' + id);
                    } catch (e) {
                        console.log('Error sending session messages:', e);
                        sessionHandled = false; // allow a genuine retry on the next reconnect
                        store.setFailed(id, 'The device link did not finish in time. Please scan a new QR code and try again.');
                    }
                } else if (connection === 'close') {
                    const code = lastDisconnect?.error?.output?.statusCode;
                    if (code !== DisconnectReason.loggedOut) {
                        await delay(5000);
                        JUNEX();
                    } else {
                        store.setFailed(id, 'The connection was closed. Please scan a new QR code.');
                        removeFile('./temp/' + id);
                    }
                }
            });

        } catch (err) {
            console.log('QR service error:', err);
            store.setFailed(id, 'Service is currently unavailable.');
            if (!res.headersSent) {
                await res.json({ code: 'Service is Currently Unavailable' });
            }
            removeFile('./temp/' + id);
        }
    }

    return await JUNEX();
});

module.exports = router;
