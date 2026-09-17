# agent-hive 生产镜像（多阶段）
# 用法：
#   docker build -t agent-hive .
#   docker run -d -p 80:80 -v agent-hive-data:/app/data agent-hive
# 说明：真人通讯录（uc_staff）与 LLM 接入参数通过环境变量注入，
#       /app/data 为运行时数据卷（会话/工作区/凭据，勿打进镜像）。

# ---- 阶段 1：构建 TS → dist ----
FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY apps ./apps
COPY packages ./packages
RUN npm run build

# ---- 阶段 2：运行（仅生产依赖，拷贝 dist 与静态页）----
FROM node:24-alpine
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=80

# 预装 git：commit & push / 克隆能力直接可用，免运行时自举安装等待（自举仍作非容器环境兜底）
RUN apk add --no-cache git

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY apps/web ./apps/web
RUN mkdir -p data

EXPOSE 80
CMD ["node", "dist/apps/server/src/index.js"]
