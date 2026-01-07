const express = require('express');
const timecut = require('timecut');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cors = require('cors');

const app = express();
// Aumentamos el límite por si mandan imágenes base64 en el HTML
app.use(express.json({ limit: '50mb' })); 
app.use(cors());

app.post('/render', async (req, res) => {
  const { html, css, width, height, duration } = req.body;
  
  const id = Date.now();
  // 1. Creamos una CARPETA ÚNICA para este trabajo dentro de /tmp
  // Así no chocamos con archivos del sistema
  const workDir = path.join(os.tmpdir(), `job-${id}`);
  
  // Archivos dentro de esa carpeta
  const tempHtml = path.join(workDir, 'input.html');
  const outputGif = path.join(workDir, 'output.gif');

  try {
    // Creamos la carpeta física
    if (!fs.existsSync(workDir)) {
      fs.mkdirSync(workDir);
    }

    const fullContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { margin: 0; padding: 0; overflow: hidden; }
          ${css}
        </style>
      </head>
      <body>${html}</body>
      </html>
    `;

    // Escribimos el HTML
    fs.writeFileSync(tempHtml, fullContent);

    console.log(`Iniciando render Job ${id} en ${workDir}...`);

    await timecut({
      url: `file://${tempHtml}`,
      output: outputGif,
      viewport: { 
        width: parseInt(width || 800), 
        height: parseInt(height || 400) 
      },
      duration: parseInt(duration || 3),
      fps: 30,
      // IMPORTANTE: Le decimos a timecut que use nuestra carpeta aislada
      tempDir: workDir, 
      launchArguments: [
        '--no-sandbox', 
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });

    // Enviamos el archivo
    if (fs.existsSync(outputGif)) {
      res.download(outputGif, 'banner.gif', (err) => {
        if (err) console.error("Error enviando:", err);
        
        // LIMPIEZA SEGURA:
        // Borramos la carpeta entera del trabajo y todo su contenido
        try {
          fs.rmSync(workDir, { recursive: true, force: true });
          console.log(`Job ${id} limpiado correctamente.`);
        } catch (e) {
          console.error("Error en limpieza:", e);
        }
      });
    } else {
      throw new Error("No se generó el archivo GIF de salida.");
    }

  } catch (error) {
    console.error("Error CRÍTICO renderizando:", error);
    
    // Intento de limpieza en caso de error
    try {
      if (fs.existsSync(workDir)) {
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    } catch(e) {}

    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Worker listo en puerto ${PORT}`));