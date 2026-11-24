FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && mkdir -p /data/rooms && chown -R node:node /data
COPY packages/contracts/ packages/contracts/
COPY packages/game-engine/ packages/game-engine/
COPY packages/basketball-ai/ packages/basketball-ai/
COPY apps/multiplayer-server/ apps/multiplayer-server/
ENV PORT=8787 ROOM_STORE=/data/rooms
USER node
VOLUME /data
EXPOSE 8787
CMD ["node", "apps/multiplayer-server/server.ts"]
