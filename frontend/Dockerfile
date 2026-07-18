# Frontend: Next.js production build.
FROM node:20-alpine AS build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 3000
# API_BASE_URL points the /api/* rewrite at the backend service (compose sets it).
CMD ["npm", "run", "start"]
