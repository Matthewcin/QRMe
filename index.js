const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
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

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage'
        ]
    }
});


// ============================================================
// QR DE WHATSAPP
// ============================================================

client.on('qr', (qr) => {
    console.log('Escanea este codigo QR con tu celular:');
    qrcodeTerminal.generate(qr, { small: true });
});


// ============================================================
// CLIENTE LISTO
// ============================================================

client.on('ready', () => {
    console.log('Cliente conectado y listo');
});


// ============================================================
// NIVELES DE CORRECCION DE ERRORES
// ============================================================
//
// Cuanto mas alto el nivel, mas "relleno" extra lleva el QR para
// poder leerse aunque este sucio, rayado, doblado o tapado en parte
// (por ejemplo con un logo en el centro). A cambio, queda con mas
// modulos negros: se ve mas denso y necesita imprimirse un poco mas
// grande para seguir siendo legible.
//
// L (~7%)  -> lo mas "limpio" y menos denso. Uso digital/pantalla,
//             o impresion grande y prolija, sin logo ni riesgo de
//             manchas o dobleces.
// M (~15%) -> el estandar para uso general: tarjetas, flyers,
//             folletos, empaques con buena impresion.
// Q (~25%) -> mas resistente. Carteles al aire libre, etiquetas de
//             producto, menus (grasa/liquidos), impresion industrial,
//             o un icono chico superpuesto.
// H (~30%) -> el mas resistente y el mas denso visualmente.
//             Obligatorio si va a llevar un logo o imagen en el
//             centro del QR. Tambien para grabado, bordado,
//             superficies irregulares, QR muy chico o mucho desgaste.

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


// ============================================================
// GENERAR QR ESTILIZADO
// ============================================================

async function generateStyledQR(url, errorCorrectionLevel) {

    const qr = QRCode.create(url, {
        errorCorrectionLevel: errorCorrectionLevel,
        margin: 4
    });

    const size = qr.modules.size;
    const data = qr.modules.data;

    const imageSize = 2000;

    // Margen blanco
    const margin = 100;

    // Tamaño de una celda
    const moduleSize =
        (imageSize - margin * 2) / size;

    // Qué tan redondeadas se ven las celdas de datos.
    // 0.5 = una celda sola queda como un círculo perfecto.
    // Bajalo (ej. 0.3) si preferís un estilo más "cuadrado suave".
    const cornerRatio = 0.5;
    const radius = moduleSize * cornerRatio;

    // Estilo de los 3 "ojos" (finder patterns):
    // 0 = esquinas 100% cuadradas, 0.5 = círculo perfecto.
    const eyeOuterRatio = 0.35;      // borde exterior negro
    const eyeInnerRatio = 0.25;      // agujero blanco interior
    const eyeRingThickness = 1.00;   // grosor del aro, en celdas (más bajo = más fino)
    const eyeCenterSize = 3.0;       // tamaño del cuadrado central, en celdas (siempre 100% cuadrado)


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


    // ========================================================
    // FINDER PATTERNS
    // ========================================================

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


    // ========================================================
    // FINDER PERSONALIZADO (igual que antes, esto ya se veía bien)
    // ========================================================

    function drawFinder(row, col) {

        const x = margin + col * moduleSize;
        const y = margin + row * moduleSize;

        const total = moduleSize * 7;


        // EXTERIOR NEGRO — cuadrado circular, tirando a círculo
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


        // INTERIOR BLANCO
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


        // CENTRO NEGRO — cuadrado, sin redondear
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


    // Dibujar los tres patrones
    drawFinder(0, 0);
    drawFinder(0, size - 7);
    drawFinder(size - 7, 0);


    // ========================================================
    // MÓDULOS NORMALES
    // ========================================================

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

            // Blanco
            if (!data[row * size + col]) {
                continue;
            }

            // Finder ya dibujado
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


    svg += `
        </svg>
    `;


    // ========================================================
    // SVG → PNG
    // ========================================================

    const png = await sharp(
        Buffer.from(svg)
    )
    .png()
    .toBuffer();


    return png;
}


// ============================================================
// RECIBIR MENSAJES
// ============================================================
//
// Flujo:
// 1) El usuario manda una URL (https://...)
// 2) El bot le pregunta qué nivel de corrección de errores quiere,
//    con la explicación de cada uno.
// 3) El usuario responde L / M / Q / H (o "bajo" / "medio" /
//    "cuartil" / "alto").
// 4) El bot genera el QR con ese nivel.

// Guarda, por cada chat, la URL que está esperando nivel de corrección
const pendingByChat = new Map();

client.on('message', async (message) => {

    const from = message.from;
    const text = message.body.trim();

    // -----------------------------------------------------
    // Está esperando que elija el nivel de corrección
    // -----------------------------------------------------
    if (pendingByChat.has(from)) {

        const level = LEVEL_ALIASES[text.toLowerCase()];

        if (!level) {
            await message.reply(
                'No entendí tu chimbada, Respondé con *L*, *M*, *Q* o *H* ' +
                '(o el nombre: bajo / medio / cuartil / alto).'
            );
            return;
        }

        const url = pendingByChat.get(from);
        pendingByChat.delete(from);

        try {

            console.log(
                `Generando QR estilizado para: ${url} (nivel ${level})`
            );

            const finalImage =
                await generateStyledQR(url, level);

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

            console.error(
                'Error generando QR:',
                error
            );

            await message.reply(
                'Uh, algo falló generando el QR. Probá de nuevo mandando la URL.'
            );
        }

        return;
    }

    // -----------------------------------------------------
    // Llega una URL nueva
    // -----------------------------------------------------
    if (text.startsWith('https://')) {

        pendingByChat.set(from, text);

        await message.reply(levelExplanationMessage());
    }
});


console.log(
    'Iniciando WhatsApp, espera un momento...'
);

client.initialize();