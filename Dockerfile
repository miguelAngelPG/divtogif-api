FROM ghcr.io/puppeteer/puppeteer:latest

# Saltamos la descarga de Chromium de puppeteer local porque usamos la de la imagen base
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci

COPY . .

CMD [ "node", "index.js" ]