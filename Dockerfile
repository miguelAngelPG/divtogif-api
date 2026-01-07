# Usamos una imagen ligera de Node (Debian)
FROM node:18-slim

# 1. Instalamos las librerías necesarias para correr Chrome en Linux
# Esto descarga Google Chrome Stable oficial y sus dependencias
RUN apt-get update \
    && apt-get install -y wget gnupg \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/googlechrome-linux-keyring.gpg \
    && sh -c 'echo "deb [arch=amd64 signed-by=/usr/share/keyrings/googlechrome-linux-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# 2. Configuramos el directorio de trabajo
WORKDIR /usr/src/app

# 3. Instalamos dependencias de Node
COPY package*.json ./
# npm ci es más rápido y seguro para entornos de producción
RUN npm ci

# 4. Copiamos el código
COPY . .

# 5. Variables de entorno CRUCIALES
# Le decimos a Puppeteer: "No descargues tu Chrome, usa el que instalé yo arriba"
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# Comando de inicio
CMD [ "node", "index.js" ]