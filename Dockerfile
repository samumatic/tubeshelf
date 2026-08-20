# Build stage
FROM node:24-alpine AS builder

WORKDIR /app

# Update packages for security, and add the toolchain node-gyp needs to
# compile native modules (better-sqlite3 has no prebuilt binary for musl/
# Alpine yet, so it always builds from source here)
RUN apk update && apk upgrade && \
    apk add --no-cache python3 make g++ && \
    rm -rf /var/cache/apk/*

# Copy package files
COPY package.json package-lock.json* yarn.lock* pnpm-lock.yaml* .npmrc* ./

# Install dependencies
RUN npm ci || npm install

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Runtime stage - minimal Node.js Alpine
FROM node:24-alpine

WORKDIR /app

# Install dumb-init for proper signal handling and update packages for security
RUN apk update && apk upgrade && apk add --no-cache dumb-init && \
    rm -rf /var/cache/apk/*

# Copy only necessary built files from builder (standalone includes everything needed)
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Copy lib folder (needed for CLI commands)
COPY --from=builder /app/lib ./lib

# Copy CLI script (keep standalone server.js from Next build)
COPY --from=builder /app/cli.js ./
COPY cli ./
COPY entrypoint.sh ./

# Make scripts executable
RUN chmod +x ./cli.js ./server.js ./cli ./entrypoint.sh

# Remove npm to avoid shipping known vulnerabilities in the runtime image
# (runtime doesn't need npm or npx)
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Create symlink for easy CLI access
RUN ln -s /app/cli /usr/local/bin/cli

# Create required writable dirs for non-root runtime user
RUN mkdir -p /app/data /app/.next/cache && \
    chown 1000:1000 /app/data /app/.next/cache

# Expose port
EXPOSE 3000

# Use entrypoint script for proper signal handling and privilege dropping
ENTRYPOINT ["/app/entrypoint.sh"]

# Start the application with the server script
CMD ["node", "server.js"]

# Set the NODE_ENV environment variable to production
ENV NODE_ENV=production
