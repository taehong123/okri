FROM node:24
RUN npm install --global @openai/codex@0.163.0
RUN mkdir -p /workspace && chown node:node /workspace
USER node
WORKDIR /workspace
ENTRYPOINT ["codex", "app-server", "-c", "mcp_servers={}", "-c", "web_search=\"disabled\""]
