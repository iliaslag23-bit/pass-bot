FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

# El volumen persistente va en /data
VOLUME ["/data"]
ENV DB_PATH=/data/vault.db

CMD ["node", "bot.js"]
