require('dotenv').config();
const { default: makeWASocket, DisconnectReason, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const { Pool } = require('pg');
const pino = require('pino');
const qrcodeTerminal = require('qrcode-terminal');
const express = require('express');
const QRCode = require('qrcode');
const sharp = require('sharp');

const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('Bot Activo'));

app.listen(port, () => {
    console.log(`Servidor en puerto ${port}`);
});

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

async function usePostgresAuthState(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS whatsapp_sessions (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    `);

    const readData = async (key) => {
        try {
            const res = await pool.query('SELECT value FROM whatsapp_sessions WHERE key = $1', [key]);
            if (res.rows.length === 0) return null;
            return JSON.parse(res.rows[0].value, BufferJSON.reviver);
        } catch (error) {
            return null;
        }
    };

    const writeData = async (data, key) => {
        try {
            const jsonString = JSON.stringify(data, BufferJSON.replacer);
            await pool.query(`
                INSERT INTO whatsapp_sessions (key, value)
                VALUES ($1, $2)
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
            `, [key, jsonString]);
        } catch (error) {
            console.error(`Error guardando ${key}:`, error);
        }
    };

    const removeData = async (key) => {
        try {
            await pool.query('DELETE FROM whatsapp_sessions WHERE key = $1', [key]);
        } catch (error) {}
    };

    const creds = await readData('creds') || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    for (const id of ids) {
                        const key = `${type}-${id}`;
                        let value = await readData(key);
                        data[id] = value;
                    }
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category of Object.keys(data)) {
                        for (const id of Object.keys(data[category])) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) {
                                tasks.push(writeData(value, key));
                            } else {
                                tasks.push(removeData(key));
                            }
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => {
            return writeData(creds, 'creds');
        }
    };
}

const LEVEL_ALIASES = {
    'l': 'L', 'bajo': 'L',
    'm': 'M', 'medio': 'M',
    'q': 'Q', 'cuartil': 'Q', 'alto': 'Q',
    'h': 'H', 'maximo': 'H', 'máximo': 'H'
};

function levelExplanationMessage() {
    return (
        '¿Qué *nivel de corrección de errores* querés usar para este QR?\n\n' +
        'Cuanto más alto el nivel, más resistente queda el código a manchas, ' +
        'roces, dobleces o a taparlo parcialmente (ej. con un logo) — pero ' +
        'también queda visualmente más denso y necesita imprimirse un poco ' +
        'más grande para seguir siendo legible.\n\n' +
        '*L — Bajo* (recupera ~7%)\n' +
        'El más limpio y menos denso. Para uso digital/pantalla, o impresión ' +
        'grande y prolija, sin logo superpuesto ni riesgo de manchas.\n\n' +
        '*M — Medio* (recupera ~15%)\n' +
        'El estándar para uso general: tarjetas de presentación, flyers, ' +
        'folletos, empaques con buena impresión.\n\n' +
        '*Q — Cuartil* (recupera ~25%)\n' +
        'Más resistente. Carteles al aire libre, etiquetas de producto, ' +
        'menús (grasa/líquidos), impresión industrial, o si vas a superponer ' +
        'un ícono chico.\n\n' +
        '*H — Alto* (recupera ~30%)\n' +
        'El más resistente, pero el más denso. *Obligatorio si vas a poner un ' +
        'logo o imagen en el centro del QR*, porque eso tapa una parte del ' +
        'código. También conviene para grabado, bordado, superficies ' +
        'irregulares, QR muy chico o mucho desgaste esperado.\n\n' +
        '👉 En resumen: sin logo y con buena impresión → *L* o *M*. ' +
        'Con logo encima, se va a ensuciar, o se imprime en condiciones ' +
        'difíciles → *Q* o *H*.\n\n' +
        'Respondé con *L*, *M*, *Q* o *H* para generar el código.'
    );
}

async function generateStyledQR(url, errorCorrectionLevel) {
    const qr = QRCode.create(url, {
        errorCorrectionLevel: errorCorrectionLevel,
        margin: 4
    });

    const size = qr.modules.size;
    const data = qr.modules.data;
    const imageSize = 2000;
    const margin = 100;
    const moduleSize = (imageSize - margin * 2) / size;

    const cornerRatio = 0.5;
    const radius = moduleSize * cornerRatio;

    const eyeOuterRatio = 0.35;
    const eyeInnerRatio = 0.25;
    const eyeRingThickness = 1.00;
    const eyeCenterSize = 3.0;

    let svg = `
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="${imageSize}"
            height="${imageSize}"
            viewBox="0 0 ${imageSize} ${imageSize}"
        >
        <rect
            width="${imageSize}"
            height="${imageSize}"
            fill="white"
        />
    `;

    const finderPatterns = [
        { row: 0, col: 0 },
        { row: 0, col: size - 7 },
        { row: size - 7, col: 0 }
    ];

    function isFinder(row, col) {
        for (const finder of finderPatterns) {
            if (
                row >= finder.row &&
                row < finder.row + 7 &&
                col >= finder.col &&
                col < finder.col + 7
            ) {
                return true;
            }
        }
        return false;
    }

    function drawFinder(row, col) {
        const x = margin + col * moduleSize;
        const y = margin + row * moduleSize;
        const total = moduleSize * 7;
        const outerRadius = total * eyeOuterRatio;

        svg += `
            <rect
                x="${x}"
                y="${y}"
                width="${total}"
                height="${total}"
                rx="${outerRadius}"
                ry="${outerRadius}"
                fill="black"
            />
        `;

        const whiteOffset = moduleSize * eyeRingThickness;
        const whiteSize = total - whiteOffset * 2;
        const innerRadius = whiteSize * eyeInnerRatio;

        svg += `
            <rect
                x="${x + whiteOffset}"
                y="${y + whiteOffset}"
                width="${whiteSize}"
                height="${whiteSize}"
                rx="${innerRadius}"
                ry="${innerRadius}"
                fill="white"
            />
        `;

        const centerSize = moduleSize * eyeCenterSize;

        svg += `
            <rect
                x="${x + (total - centerSize) / 2}"
                y="${y + (total - centerSize) / 2}"
                width="${centerSize}"
                height="${centerSize}"
                fill="black"
            />
        `;
    }

    drawFinder(0, 0);
    drawFinder(0, size - 7);
    drawFinder(size - 7, 0);

    function isDark(row, col) {
        if (row < 0 || row >= size || col < 0 || col >= size) return false;
        return !!data[row * size + col];
    }

    function roundedModulePath(x, y, w, h, r) {
        const { tl, tr, br, bl } = r;
        return `
            M ${x + tl} ${y}
            H ${x + w - tr}
            A ${tr} ${tr} 0 0 1 ${x + w} ${y + tr}
            V ${y + h - br}
            A ${br} ${br} 0 0 1 ${x + w - br} ${y + h}
            H ${x + bl}
            A ${bl} ${bl} 0 0 1 ${x} ${y + h - bl}
            V ${y + tl}
            A ${tl} ${tl} 0 0 1 ${x + tl} ${y}
            Z
        `;
    }

    let modulesPath = '';

    for (let row = 0; row < size; row++) {
        for (let col = 0; col < size; col++) {
            if (!data[row * size + col]) {
                continue;
            }

            if (isFinder(row, col)) {
                continue;
            }

            const up = isDark(row - 1, col);
            const down = isDark(row + 1, col);
            const left = isDark(row, col - 1);
            const right = isDark(row, col + 1);

            const r = {
                tl: (!up && !left) ? radius : 0,
                tr: (!up && !right) ? radius : 0,
                br: (!down && !right) ? radius : 0,
                bl: (!down && !left) ? radius : 0
            };

            const x = margin + col * moduleSize;
            const y = margin + row * moduleSize;

            modulesPath += roundedModulePath(x, y, moduleSize, moduleSize, r);
        }
    }

    svg += `<path d="${modulesPath}" fill="black" />`;
    svg += `</svg>`;

    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    return png;
}

const pendingByChat = new Map();
const usuariosExplicados = new Set();

async function startBot() {
    const { state, saveCreds } = await usePostgresAuthState(pool);

    const sock = makeWASocket({
        auth: state,
        logger: pio({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('Escanea este codigo QR con tu celular:');
            qrcodeTerminal.generate(qr, { small: true });
        }

        if (connection === 'open') {
            console.log('Cliente conectado y listo');
        } else if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexion cerrada. Reconectando...', shouldReconnect);
            if (shouldReconnect) {
                startBot();
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();

        if (pendingByChat.has(from)) {
            const level = LEVEL_ALIASES[text.toLowerCase()];

            if (!level) {
                await sock.sendMessage(from, { 
                    text: 'Respondé con *L*, *M*, *Q* o *H* (o el nombre: bajo / medio / cuartil / alto).' 
                });
                return;
            }

            const url = pendingByChat.get(from);
            pendingByChat.delete(from);

            try {
                console.log(`Generando QR estilizado para: ${url} (nivel ${level})`);

                const finalImage = await generateStyledQR(url, level);

                await sock.sendMessage(from, {
                    image: finalImage,
                    caption: `QR generado con nivel de corrección *${level}*.`
                });

                console.log('QR enviado correctamente');

            } catch (error) {
                console.error('Error generando QR:', error);
                await sock.sendMessage(from, { 
                    text: 'Uh, algo falló generando el QR. Probá de nuevo mandando la URL.' 
                });
            }

            return;
        }

        if (text.startsWith('https://')) {
            pendingByChat.set(from, text);

            if (!usuariosExplicados.has(from)) {
                await sock.sendMessage(from, { text: levelExplanationMessage() });
                usuariosExplicados.add(from);
            } else {
                await sock.sendMessage(from, { text: 'Respondé con *L*, *M*, *Q* o *H* para generar el código.' });
            }
        }
    });
}

console.log('Iniciando WhatsApp, espera un momento...');
startBot();