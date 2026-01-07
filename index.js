const express = require('express');
const timecut = require('timecut');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cors = require('cors');
const { execSync } = require('child_process');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors());

const clients = new Map();

const sendEvent = (jobId, data) => {
  const client = clients.get(jobId);
  if (client) client.write(`data: ${JSON.stringify(data)}\n\n`);
};

// Función para asegurar dimensiones pares (FFmpeg odia los impares)
const makeEven = (n) => Math.ceil(n / 2) * 2;

app.post('/start', async (req, res) => {
  // 1. Recibimos todos los parámetros
  const { html, css, width, height, duration, bg, fps } = req.body;
  const jobId = Date.now().toString();

  try {
    execSync('ffmpeg -version');
  } catch (e) {
    console.error("FFmpeg no encontrado");
    return res.status(500).json({ error: "Server misconfiguration: FFmpeg missing" });
  }
  
  res.json({ jobId });

  (async () => {
    // Definimos estructura de carpetas
    const jobDir = path.join(os.tmpdir(), `job-${jobId}`);
    const framesDir = path.join(jobDir, 'frames');
    const tempHtml = path.join(jobDir, 'input.html');
    const outputGif = path.join(jobDir, 'output.gif');

    // Configuración segura
    // Nota: 30 FPS para GIF es el estándar de calidad/peso. 
    // Si el usuario pide 60, se lo damos, pero pesará bastante.
    const safeFps = parseInt(fps || 30); 
    const safeWidth = makeEven(parseInt(width || 800));
    const safeHeight = makeEven(parseInt(height || 400));
    const safeDuration = parseInt(duration || 3);
    // Si no hay BG, usamos transparente, pero normalmente el front manda un color.
    const safeBg = bg || 'transparent'; 

    try {
      if (!fs.existsSync(jobDir)) fs.mkdirSync(jobDir);
      if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir);

      // 2. INYECCIÓN DE CSS (Solución al problema del fondo)
      // Agregamos un reset y forzamos el background en html y body con !important
      const fullContent = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            html, body {
              width: ${safeWidth}px;
              height: ${safeHeight}px;
              overflow: hidden;
              background-color: ${safeBg} !important; /* <--- CLAVE */
            }
            /* CSS del usuario */
            ${css}
          </style>
        </head>
        <body>${html}</body>
        </html>
      `;
      
      fs.writeFileSync(tempHtml, fullContent);

      const customLogger = (msg) => {
        // Logueamos progreso de captura (80% del proceso)
        if (msg.includes('Capturing Frame')) {
          const parts = msg.split(' ');
          const frameNum = parseInt(parts[2]);
          if (!isNaN(frameNum)) {
            const totalFrames = safeDuration * safeFps;
            const percent = Math.round((frameNum / totalFrames) * 80);
            sendEvent(jobId, { status: 'processing', progress: percent });
          }
        }
      };

      // 3. CAPTURA DE FRAMES (PNG Calidad 100%)
      // timecut solo saca las fotos, NO hace el GIF todavía.
      await timecut({
        url: `file://${tempHtml}`,
        viewport: { width: safeWidth, height: safeHeight },
        duration: safeDuration,
        fps: safeFps,
        tempDir: framesDir,
        logger: customLogger,
        launchArguments: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
        output: '' // Dejar vacío para que solo guarde los frames
      });

      sendEvent(jobId, { status: 'processing', progress: 85 });
      console.log(`[Job ${jobId}] Generando GIF con Paleta Optimizada...`);

      // 4. FFMPEG CON PALETTEGEN (Solución al problema de colores)
      // Este comando hace la magia:
      // a. Lee las imágenes.
      // b. Genera una paleta de 256 colores basada ÚNICAMENTE en tus imágenes (palettegen).
      // c. Aplica esa paleta con "dithering" para suavizar degradados (paletteuse).
      const framesPattern = path.join(framesDir, 'image-%09d.png');
      const ffmpegCmd = `ffmpeg -f image2 -framerate ${safeFps} -i "${framesPattern}" -vf "split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" -loop 0 "${outputGif}"`;

      execSync(ffmpegCmd);

      sendEvent(jobId, { status: 'processing', progress: 100 });

      if (fs.existsSync(outputGif)) {
        sendEvent(jobId, { status: 'completed', url: `/download/${jobId}` });
      } else {
        throw new Error('Error al generar el archivo final');
      }

    } catch (error) {
      console.error("Error Job:", error);
      sendEvent(jobId, { status: 'error', message: error.message });
      try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch(e){}
    }
  })();
});

// Endpoint SSE
app.get('/events/:jobId', (req, res) => {
  const { jobId } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  clients.set(jobId, res);
  req.on('close', () => clients.delete(jobId));
});

// Endpoint Descarga
app.get('/download/:jobId', (req, res) => {
  const { jobId } = req.params;
  const filePath = path.join(os.tmpdir(), `job-${jobId}`, 'output.gif');
  
  if (fs.existsSync(filePath)) {
    res.download(filePath, 'banner.gif', () => {
      // Limpieza post-descarga
      const jobDir = path.join(os.tmpdir(), `job-${jobId}`);
      try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch(e){}
    });
  } else {
    res.status(404).send('Archivo no encontrado');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Worker V5 (High Quality) listo en puerto ${PORT}`));