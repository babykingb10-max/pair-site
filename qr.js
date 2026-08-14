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

router.get('/', async (req, res) => {
    const id = makeid(6);
    store.createEntry(id);

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
                    try {
                        await client.sendMessage(client.user.id, {
                            text: '*Generating your session, please wait a moment...*'
                        });
                        // Short pause so creds.json has time to finish saving to disk.
                        await delay(6000);
                        let data = fs.readFileSync(__dirname + `/temp/${id}/creds.json`);
                        await delay(2000);
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
                        store.setFailed(id, 'Could not finish generating the session.');
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
