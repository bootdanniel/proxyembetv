FROM node:18-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && \
    curl -fL --retry 3 -o /usr/local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && \
    chmod +x /usr/local/bin/cloudflared && \
    cloudflared --version && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 3000
CMD ["node", "start.js"]
