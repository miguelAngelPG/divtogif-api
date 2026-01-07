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

// Forzar dimensiones pares (FFmpeg lo exige)
const makeEven = (n) => Math.ceil(n / 2) * 2;

app.post('/start', async (req, res) => {
  // 1. RECIBIMOS LA VARIABLE 'bg' y 'fps'
  const { html, css, width, height, duration, bg, fps } = req.body; // <--- CORRECCIÓN: Leemos bg
  const jobId = Date.now().toString();

   // Verificación rápida de FFmpeg
  try {
    execSync('ffmpeg -version');
  } catch (e) {
    console.error("FFmpeg no encontrado");
    return res.status(500).json({ error: "Server misconfiguration: FFmpeg missing" });
  }
  
  res.json({ jobId });

  (async () => {
    const jobDir = path.join(os.tmpdir(), `job-${jobId}`);
    const framesDir = path.join(jobDir, 'frames');
    const tempHtml = path.join(jobDir, 'input.html');
    const outputGif = path.join(jobDir, 'output.gif');

    // Usamos los valores o ponemos defaults de alta calidad
    const safeWidth = makeEven(parseInt(width || 800));
    const safeHeight = makeEven(parseInt(height || 400));
    const safeDuration = parseInt(duration || 3);
    const safeFps = parseInt(fps || 60); // <--- CORRECCIÓN: Por defecto 60 FPS para suavidad total
    const safeBg = bg || 'transparent';  // <--- CORRECCIÓN: Color de fondo seguro

    try {
      if (!fs.existsSync(jobDir)) fs.mkdirSync(jobDir);
      if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir);

      // 2. INYECTAMOS EL BACKGROUND CON !important Y CSS RESET
      // Esto garantiza que se vea idéntico al navegador
      const fullContent = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            /* Reset agresivo para evitar bordes blancos */
            * { margin: 0; padding: 0; box-sizing: border-box; }
            
            html, body {
              width: ${safeWidth}px;
              height: ${safeHeight}px;
              overflow: hidden;
              background-color: ${safeBg} !important; /* <--- AQUÍ FORZAMOS EL COLOR */
            }

            /* Tu CSS del usuario */
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
            // Calculamos el progreso basado en los FPS reales
            const totalFrames = safeDuration * safeFps;
            const percent = Math.round((frameNum / totalFrames) * 100);
            sendEvent(jobId, { status: 'processing', progress: percent });
          }
        }
      };

      await timecut({
        url: `file://${tempHtml}`,
        output: outputGif,
        viewport: { width: safeWidth, height: safeHeight },
        duration: safeDuration,
        fps: safeFps, // <--- Usamos 60 FPS (o lo que mande el usuario)
        tempDir: framesDir,
        logger: customLogger,
        launchArguments: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
      });

      if (fs.existsSync(outputGif)) {
        sendEvent(jobId, { status: 'completed', url: `/download/${jobId}` });
      } else {
        throw new Error('No se generó el GIF');
      }

    } catch (error) {
      console.error("Error:", error);
      sendEvent(jobId, { status: 'error', message: error.message });
      try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch(e){}
    }
  })();
});

// ... (El resto de endpoints /events y /download quedan igual) ...
// NO BORRES LOS ENDPOINTS QUE YA TENÍAS, SOLO CAMBIA EL POST /start
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
        const jobDir = path.join(os.tmpdir(), `job-${jobId}`);
        try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch(e){}
      });
    } else {
      res.status(404).send('Archivo no encontrado');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Worker V4 (Fix BG/FPS) listo en ${PORT}`));