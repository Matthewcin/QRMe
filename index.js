require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, RemoteAuth, MessageMedia } = require('whatsapp-web.js');
const { PostgresStore } = require('wwebjs-postgres');
const { Pool } = require('pg');
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

const store = new PostgresStore({ pool: pool });

const originalSave = store.save.bind(store);
store.save = async function(options) {
    const sessionName = options.session || 'RemoteAuth';
    const possiblePaths = [
        `${sessionName}.zip`,
        `session-${sessionName}.zip`,
        path.join('.wwebjs_auth', `${sessionName}.zip`),
        path.join('.wwebjs_auth', `session-${sessionName}.zip`),
        path.join('.wwebjs_cache', `${sessionName}.zip`),
        path.join('.wwebjs_cache', `session-${sessionName}.zip`)
    ];

    let foundPath = null;
    for (let i = 0; i < 15; i++) {
        foundPath = possiblePaths.find(p => fs.existsSync(p));
        if (foundPath) break;
        await new Promise(res => setTimeout(res, 300));
    }

    if (foundPath && foundPath !== `${sessionName}.zip`) {
        fs.copyFileSync(foundPath, `${sessionName}.zip`);
    }

    return await originalSave(options);
};

const originalExtract = store.extract.bind(store);
store.extract = async function(options) {
    const sessionName = options.session || 'RemoteAuth';
    const extractedPath = options.path || `${sessionName}.zip`;

    const authDir = path.join('.wwebjs_auth');
    if (!fs.existsSync(authDir)) {
        fs.mkdirSync(authDir, { recursive: true });
    }

    console.log('Descargando y extrayendo sesion...');
    await originalExtract(options);

    const targets = [
        path.join('.wwebjs_auth', `${sessionName}.zip`),
        path.join('.wwebjs_auth', `session-${sessionName}.zip`)
    ];

    for (const target of targets) {
        if (fs.existsSync(extractedPath) && !fs.existsSync(target)) {
            try {
                fs.copyFileSync(extractedPath, target);
            } catch (e) {}
        }
    }

    console.log('Pausando 10 segundos para liberar memoria RAM...');
    await new Promise(res => setTimeout(res, 10000));
};

const client = new Client({
    authStrategy: new RemoteAuth({
        store: store,
        backupSyncIntervalMs: 300000
    }),
    puppeteer: {
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--disable-software-rasterizer',
            '--disable-extensions',
            '--mute-audio',
            '--disable-background-networking',
            '--disable-default-apps',
            '--disable-sync',
            '--disable-translate',
            '--hide-scrollbars',
            '--metrics-recording-only',
            '--no-default-browser-check',
            '--safebrowsing-disable-auto-update',
            '--enable-low-end-device-mode',
            '--disable-component-update',
            '--disable-client-side-phishing-detection',
            '--disable-hang-monitor',
            '--disable-prompt-on-repost',
            '--disable-ipc-flooding-protection'
        ]
    }
});

client.on('qr', (qr) => {
    console.log('Escanea este codigo QR con tu celular:');
    qrcodeTerminal.generate(qr, { small: true });
});

client.on('remote_session_saved', () => {
    console.log('Sesion guardada exitosamente en PostgreSQL');
});

client.on('ready', () => {
    console.log('Cliente conectado y listo');
});

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

client.on('message', async (message) => {
    const from = message.from;
    const text = message.body.trim();

    if (pendingByChat.has(from)) {
        const level = LEVEL_ALIASES[text.toLowerCase()];

        if (!level) {
            await message.reply(
                'Respondé con *L*, *M*, *Q* o *H* ' +
                '(o el nombre: bajo / medio / cuartil / alto).'
            );
            return;
        }

        const url = pendingByChat.get(from);
        pendingByChat.delete(from);

        try {
            console.log(`Generando QR estilizado para: ${url} (nivel ${level})`);

            const finalImage = await generateStyledQR(url, level);

            const media = new MessageMedia(
                'image/png',
                finalImage.toString('base64'),
                'qr.png'
            );

            await message.reply(media, undefined, {
                caption: `QR generado con nivel de corrección *${level}*.`
            });

            console.log('QR enviado correctamente');

        } catch (error) {
            console.error('Error generando QR:', error);
            await message.reply('Uh, algo falló generando el QR. Probá de nuevo mandando la URL.');
        }

        return;
    }

    if (text.startsWith('https://')) {
        pendingByChat.set(from, text);

        if (!usuariosExplicados.has(from)) {
            await message.reply(levelExplanationMessage());
            usuariosExplicados.add(from);
        } else {
            await message.reply('Respondé con *L*, *M*, *Q* o *H* para generar el código.');
        }
    }
});

console.log('Iniciando WhatsApp, espera un momento...');
client.initialize();