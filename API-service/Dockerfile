# Use a modern Node that ships pre-built native modules
FROM node:20-alpine

# Add build tools just in case any package compiles native code
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy only the dependency manifests first
COPY package*.json ./

# Clean install dependencies inside the container
RUN npm ci --omit=dev

# Then copy your actual source (but NOT node_modules)
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]

