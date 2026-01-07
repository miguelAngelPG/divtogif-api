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

const makeEven = (n) => Math.ceil(n / 2) * 2;

app.post('/start', async (req, res) => {
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
    // Definimos rutas
    const jobDir = path.join(os.tmpdir(), `job-${jobId}`);
    const framesDir = path.join(jobDir, 'frames'); // Aquí van las fotos
    const tempHtml = path.join(jobDir, 'input.html');
    const outputGif = path.join(jobDir, 'output.gif');

    const safeFps = parseInt(fps || 30); 
    const safeWidth = makeEven(parseInt(width || 800));
    const safeHeight = makeEven(parseInt(height || 400));
    const safeDuration = parseInt(duration || 3);
    const safeBg = bg || 'transparent'; 

    try {
      // 1. Crear carpetas
      if (!fs.existsSync(jobDir)) fs.mkdirSync(jobDir);
      if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir);

      // 2. HTML + CSS Inyectado
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
              background-color: ${safeBg} !important;
            }
            ${css}
          </style>
        </head>
        <body>${html}</body>
        </html>
      `;
      
      fs.writeFileSync(tempHtml, fullContent);

      const customLogger = (msg) => {
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

      // 3. CAPTURA DE FRAMES
      await timecut({
        url: `file://${tempHtml}`,
        viewport: { width: safeWidth, height: safeHeight },
        duration: safeDuration,
        fps: safeFps,
        tempDir: framesDir,     // Usar nuestra carpeta
        keepFrames: true,       // <--- ¡LA SOLUCIÓN! (No borrar fotos al terminar)
        logger: customLogger,
        launchArguments: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
        output: '',             // No generar video aquí
        screenshotPattern: 'image-%d.png' // Nombre simple: image-1.png, image-2.png
      });

      sendEvent(jobId, { status: 'processing', progress: 85 });
      
      // DIAGNÓSTICO
      console.log(`[Job ${jobId}] Verificando frames en ${framesDir}...`);
      if (fs.existsSync(framesDir)) {
        const files = fs.readdirSync(framesDir);
        console.log(`Archivos encontrados: ${files.length}`);
        if (files.length === 0) throw new Error("Timecut no generó imágenes.");
      } else {
        throw new Error("La carpeta frames desapareció (keepFrames falló).");
      }

      console.log(`[Job ${jobId}] Iniciando FFmpeg High Quality...`);

      // 4. FFMPEG MANUAL
      // Usamos %d para coincidir con image-1.png, image-2.png...
      const framesPattern = path.join(framesDir, 'image-%d.png');
      
      // Comando palettegen para máxima calidad de color
      const ffmpegCmd = `ffmpeg -f image2 -framerate ${safeFps} -i "${framesPattern}" -vf "split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" -loop 0 "${outputGif}"`;

      execSync(ffmpegCmd);

      sendEvent(jobId, { status: 'processing', progress: 100 });

      if (fs.existsSync(outputGif)) {
        sendEvent(jobId, { status: 'completed', url: `/download/${jobId}` });
      } else {
        throw new Error('FFmpeg terminó pero no creó el GIF.');
      }

    } catch (error) {
      console.error("Error Job:", error);
      sendEvent(jobId, { status: 'error', message: error.message });
      // Limpieza SOLO si hay error grave
      try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch(e){}
    }
  })();
});

app.get('/events/:jobId', (req, res) => {
  const { jobId } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  clients.set(jobId, res);
  req.on('close', () => clients.delete(jobId));
});

app.get('/download/:jobId', (req, res) => {
  const { jobId } = req.params;
  const filePath = path.join(os.tmpdir(), `job-${jobId}`, 'output.gif');
  
  if (fs.existsSync(filePath)) {
    res.download(filePath, 'banner.gif', () => {
      // Limpieza FINAL exitosa
      const jobDir = path.join(os.tmpdir(), `job-${jobId}`);
      try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch(e){}
    });
  } else {
    res.status(404).send('Archivo no encontrado');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Worker V5.2 (KeepFrames) listo en ${PORT}`));