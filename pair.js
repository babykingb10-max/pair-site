const { makeid } = require('./id');
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

const router = express.Router();

function removeFile(filePath) {
    if (!fs.existsSync(filePath)) return false;
    fs.rmSync(filePath, { recursive: true, force: true });
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
    let num = req.query.number;

    if (!num) {
        return res.status(400).send({ error: 'A WhatsApp number is required.' });
    }

    const id = makeid(6);
    store.createEntry(id);
    let sessionHandled = false; // guards against duplicate 'open' events across reconnect attempts

    async function JUNEX() {
        const { state, saveCreds } = await useMultiFileAuthState('./temp/' + id);
        try {
            const { version } = await fetchLatestBaileysVersion();
            const logger = pino({ level: 'silent' });

            const client = makeWASocket({
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
                const { connection, lastDisconnect } = s;

                if (connection === 'open') {
                    if (sessionHandled) return; // already generated a session for this pairing, ignore repeat 'open' events
                    sessionHandled = true;
                    try {
                        // Normalize the JID: client.user.id can include a ":<device>" suffix
                        // on some forks (e.g. "255xxxxxxxxx:20@s.whatsapp.net"). Sending to
                        // that raw JID can get silently dropped — strip it to the base JID.
                        const selfJid = client.user.id.split(':')[0] + '@s.whatsapp.net';

                        // Grace period so the Signal session between this bot and the
                        // phone finishes syncing before we send anything — sending too
                        // early is what causes "Waiting for this message" on WhatsApp.
                        await delay(4000);
                        await client.sendMessage(selfJid, {
                            text: 'Generating your session, please wait a moment...'
                        });
                        console.log(`[${id}] Sent "generating" message to ${selfJid}`);
                        // Wait for creds.json to actually exist instead of guessing a fixed delay.
                        const data = await waitForCredsFile(__dirname + `/temp/${id}/creds.json`);
                        const b64data = Buffer.from(data).toString('base64');
                        const sessionText = 'ADEVOS-X:~' + b64data;

                        // Make the session available to the website, once.
                        store.setReady(id, sessionText);

                        let session;
                        try {
                            // Native "Copy" button under the session message.
                            session = await sendButtons(client, selfJid, {
                                text: sessionText,
                                footer: 'Adevos-X Tech',
                                buttons: [
                                    btn.copy('Copy', sessionText),
                                ],
                            });
                        } catch (btnErr) {
                            // Fallback for clients/forks where the native button isn't supported.
                            console.log('Copy button unsupported, sending plain text:', btnErr?.message);
                            session = await client.sendMessage(selfJid, { text: sessionText });
                        }
                        console.log(`[${id}] Sent session message`);
                        await client.sendMessage(selfJid, {
                            text: "SESSION ID GENERATED SUCCESSFULLY\n\n 1. Copy the session code above or return to the *Web Dashboard* to copy it directly.\n 2. *Do NEVER* share this Session ID with anyone. It gives full access to your WhatsApp account.\n 3. Paste this Session ID into your deployment environment variable *(SESSION_ID)* when setting up your Adevos-X Bot.\n\n> *Powered by Adevos-X Tech*"
                        }, { quoted: session });
                        console.log(`[${id}] Sent instructions message, waiting before closing socket`);
                        // Give the socket real time to flush these messages over the
                        // network before we tear it down — closing too soon can cut
                        // messages off before WhatsApp's servers ever receive them.
                        await delay(5000);
                        await client.ws.close();
                        removeFile('./temp/' + id);
                    } catch (e) {
                        console.log('Error sending session messages:', e);
                        sessionHandled = false; // allow a genuine retry on the next reconnect
                        store.setFailed(id, 'The device link did not finish in time. Please generate a new code and try again.');
                    }
                } else if (connection === 'close') {
                    const code = lastDisconnect?.error?.output?.statusCode;
                    if (code !== DisconnectReason.loggedOut) {
                        await delay(5000);
                        JUNEX();
                    } else {
                        store.setFailed(id, 'The connection was closed. Please generate a new code.');
                        removeFile('./temp/' + id);
                    }
                }
            });

            if (!client.authState.creds.registered) {
                await delay(1500);
                num = num.replace(/[^0-9]/g, '');
                const code = await client.requestPairingCode(num);
                if (!res.headersSent) {
                    await res.send({ id, code });
                }
            }

        } catch (err) {
            console.log('Pair service error:', err);
            removeFile('./temp/' + id);
            store.setFailed(id, 'Service currently unavailable.');
            if (!res.headersSent) {
                await res.send({ id, code: 'Service Currently Unavailable' });
            }
        }
    }

    await JUNEX();
});

module.exports = router;
