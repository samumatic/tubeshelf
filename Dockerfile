# Build stage
FROM node:24-alpine AS builder

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* yarn.lock* pnpm-lock.yaml* ./

# Install dependencies
RUN npm ci || npm install

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Runtime stage
FROM node:24-alpine

WORKDIR /app

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Copy built application from builder
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/static ./.next/static

# Create required dirs and ensure non-root can write
RUN mkdir -p /app/data /app/.next/cache && \
    chown -R 1000:1000 /app

# Expose port
EXPOSE 3000

# Do not set a fixed USER here; compose will run with PUID/PGID

# Run as non-root user (uid:gid 1000:1000)
USER 1000:1000

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start the application
CMD ["node", "server.js"]

# Set the NODE_ENV environment variable to production
ENV NODE_ENV=production
