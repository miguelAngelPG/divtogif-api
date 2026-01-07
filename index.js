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

  res.json({ jobId });

  (async () => {
    // Configuración de rutas
    const jobDir = path.join(os.tmpdir(), `job-${jobId}`);
    const framesDir = path.join(jobDir, 'frames');
    const tempHtml = path.join(jobDir, 'input.html');
    const outputGif = path.join(jobDir, 'output.gif');
    
    // Archivo basura para que timecut no se queje
    const dummyOutput = path.join(jobDir, 'dummy.mp4'); 

    const safeFps = parseInt(fps || 30); 
    const safeWidth = makeEven(parseInt(width || 800));
    const safeHeight = makeEven(parseInt(height || 400));
    const safeDuration = parseInt(duration || 3);
    const safeBg = bg || 'transparent'; 

    try {
      if (!fs.existsSync(jobDir)) fs.mkdirSync(jobDir);
      if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir);

      // Inyección CSS
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

      console.log(`[Job ${jobId}] Iniciando captura Timecut...`);

      // 1. CAPTURA (Sin forzar pattern, dejamos el default)
      await timecut({
        url: `file://${tempHtml}`,
        viewport: { width: safeWidth, height: safeHeight },
        duration: safeDuration,
        fps: safeFps,
        tempDir: framesDir,     
        keepFrames: true,       // OBLIGATORIO
        logger: customLogger,
        launchArguments: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
        output: dummyOutput,    // Le damos un output dummy para asegurar que termine el proceso bien
      });

      sendEvent(jobId, { status: 'processing', progress: 85 });
      
      // 2. DETECTIVE DE ARCHIVOS (Aquí estaba el error antes)
      console.log(`[Job ${jobId}] Analizando frames generados...`);
      
      let files = [];
      if (fs.existsSync(framesDir)) {
        files = fs.readdirSync(framesDir).filter(f => f.endsWith('.png'));
      }

      if (files.length === 0) {
        throw new Error(`Timecut terminó pero la carpeta ${framesDir} está vacía. Intenta bajar la resolución.`);
      }

      // Ordenamos para ver el primero
      files.sort();
      const firstFile = files[0]; // Ejemplo: "image-1.png" o "image-000000001.png"
      console.log(`[Job ${jobId}] Primer archivo encontrado: ${firstFile}`);

      // 3. DECISIÓN DINÁMICA DE PATRÓN
      // Timecut por defecto suele usar image-1.png (sin ceros) O image-000001.png
      // Vamos a construir el input de FFmpeg basándonos en lo que vemos.
      
      let ffmpegInput = "";
      
      // Si el archivo tiene ceros a la izquierda (ej: image-001.png)
      if (firstFile.match(/image-0+\d+.png/)) {
        // Contamos cuántos dígitos tiene
        const digits = firstFile.match(/\d+/)[0].length;
        ffmpegInput = path.join(framesDir, `image-%0${digits}d.png`);
      } 
      // Si el archivo es simple (ej: image-1.png)
      else {
        ffmpegInput = path.join(framesDir, 'image-%d.png');
      }

      console.log(`[Job ${jobId}] Usando patrón FFmpeg: ${ffmpegInput}`);

      // 4. GENERACIÓN GIF ALTA CALIDAD
      const ffmpegCmd = `ffmpeg -f image2 -framerate ${safeFps} -i "${ffmpegInput}" -vf "split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" -loop 0 "${outputGif}"`;

      execSync(ffmpegCmd);

      sendEvent(jobId, { status: 'processing', progress: 100 });

      if (fs.existsSync(outputGif)) {
        sendEvent(jobId, { status: 'completed', url: `/download/${jobId}` });
      } else {
        throw new Error('FFmpeg no generó el GIF final.');
      }

    } catch (error) {
      console.error("Error Job:", error);
      sendEvent(jobId, { status: 'error', message: error.message });
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
      const jobDir = path.join(os.tmpdir(), `job-${jobId}`);
      try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch(e){}
    });
  } else {
    res.status(404).send('Archivo no encontrado');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Worker V5.3 (Detective Mode) listo en ${PORT}`));