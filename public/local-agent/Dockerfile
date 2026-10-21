FROM golang:1.27.3 AS go
FROM node:24
COPY --from=go /usr/local/go /usr/local/go
ENV PATH="/usr/local/go/bin:${PATH}" GOPATH="/workspace/.okri-go" GOMODCACHE="/workspace/.okri-go/pkg/mod" GOCACHE="/tmp/okri-go-build" GOPROXY="off" GOSUMDB="off" GOTOOLCHAIN="local" GOMAXPROCS="2"
RUN npm install --global @openai/codex@0.163.0
RUN mkdir -p /workspace && chown node:node /workspace
USER node
WORKDIR /workspace
ENTRYPOINT ["codex", "app-server", "-c", "mcp_servers={}", "-c", "web_search=\"disabled\""]
