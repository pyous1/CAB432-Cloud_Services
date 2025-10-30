# Base image
FROM node:18

# Create app directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the app
COPY . .

# Expose port 3000 (or change if your app uses another port)
EXPOSE 3000

# Start the app
CMD ["node", "authserver.js"]
