FROM node:20-bookworm-slim

# System deps for PDF tooling
RUN apt-get update && apt-get install -y --no-install-recommends \
    ghostscript \
 && rm -rf /var/lib/apt/lists/*

# App setup
WORKDIR /app
COPY package.json /app/package.json
COPY package-lock.json /app/package-lock.json
RUN npm ci
COPY index.js /app/index.js
RUN mkdir -p /app/public
COPY index.html /app/public/index.html

EXPOSE 3000
CMD ["node", "index.js"]