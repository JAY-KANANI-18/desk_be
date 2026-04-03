# ---------- Stage 1: Builder ----------
FROM node:22-alpine AS builder

WORKDIR /app

# Needed for some native deps if ever required
RUN apk add --no-cache openssl

# Copy package files first for cache
COPY package*.json ./
COPY prisma ./prisma

# Install all deps for build
RUN npm i --legacy-peer-deps

# Generate Prisma client
RUN npx prisma generate

# Copy source
COPY . .

# Build NestJS app
RUN npm run build


# ---------- Stage 2: Production ----------
FROM node:20-alpine AS runner

WORKDIR /app

RUN apk add --no-cache openssl

ENV NODE_ENV=production

# Copy only needed files
COPY package*.json ./
COPY prisma ./prisma

# Install only production dependencies
RUN npm i --omit=dev && npm cache clean --force

# Generate Prisma client again in production image
RUN npx prisma generate

# Copy compiled app
COPY --from=builder /app/dist ./dist

# Expose NestJS port
EXPOSE 3000

# Default command for API
CMD ["node", "dist/main.js"]