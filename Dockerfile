FROM node:24-alpine
LABEL org.opencontainers.image.source="https://github.com/daimonbot/agent-atlas"
LABEL org.opencontainers.image.description="Provider-agnostic cost & agent-tree explorer for AI coding sessions. Zero dependencies."
WORKDIR /app
COPY package.json ./
COPY src ./src
USER node
EXPOSE 4747
ENTRYPOINT ["node", "/app/src/cli.mjs"]
CMD ["serve", "--host", "0.0.0.0", "--port", "4747"]
