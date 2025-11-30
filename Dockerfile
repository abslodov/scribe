FROM node:20-bullseye-slim

# Install build tools for native modules (Opus, Sodium)
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy source and build
COPY . .
RUN npm run build

# Start the bot
CMD ["npm", "start"]
