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

# Runtime stage - minimal Node.js Alpine
FROM node:24-alpine

WORKDIR /app

# Install only dumb-init
RUN apk add --no-cache dumb-init && \
    rm -rf /var/cache/apk/*

# Copy only necessary built files from builder (standalone includes everything needed)
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Create required dirs and ensure non-root can write
RUN mkdir -p /app/data /app/.next/cache && \
    chown -R 1000:1000 /app

# Expose port
EXPOSE 3000

# Run as non-root user
USER 1000:1000

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start the application
CMD ["node", "server.js"]

# Set the NODE_ENV environment variable to production
ENV NODE_ENV=production
