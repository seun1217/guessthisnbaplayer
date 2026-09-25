# 의존성이 전혀 없는 Node 앱이라 npm install 단계가 필요 없다.
FROM node:22-alpine

WORKDIR /app
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node data ./data
COPY --chown=node:node public ./public

ENV NODE_ENV=production
USER node
EXPOSE 3000

CMD ["node", "server.js"]
