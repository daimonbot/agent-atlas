FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig.json vite.config.js vite.export.config.js ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
LABEL org.opencontainers.image.source="https://github.com/daimonbot/agent-atlas"
LABEL org.opencontainers.image.description="Provider-agnostic cost & agent-tree explorer for AI coding sessions."
WORKDIR /app
COPY package.json ./
COPY --from=build /app/dist ./dist
COPY src ./src
USER node
EXPOSE 4747
ENTRYPOINT ["node", "/app/src/cli.mjs"]
CMD ["serve", "--host", "0.0.0.0", "--port", "4747"]
