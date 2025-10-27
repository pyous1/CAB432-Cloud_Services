FROM node:18-bullseye

WORKDIR /app

# Install minimal LaTeX
RUN apt-get update && DEBIAN_FRONTEND=noninteractive \
    apt-get install -y \
        ghostscript \
        poppler-utils \
    && rm -rf /var/lib/apt/lists/*

# Copy dependency files
COPY package*.json ./

RUN npm install --only=production

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]