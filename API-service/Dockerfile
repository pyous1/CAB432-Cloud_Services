# ============================
# PDF Converter API Dockerfile
# ============================

# Use official Node LTS
FROM node:18

# Set working directory
WORKDIR /app

# Copy package files first (for caching)
COPY package*.json ./

# Install only production dependencies
RUN npm install --omit=dev

# Copy the rest of the application
COPY . .

# Expose port (ECS will map it automatically)
EXPOSE 3000

# Start the API service
CMD ["node", "server.js"]

