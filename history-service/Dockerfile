# Use a small, production-ready Node.js base
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy the rest of your app
COPY . .

# Expose the port ECS expects
EXPOSE 3000

# Run the service
CMD ["node", "historyserver.js"]
