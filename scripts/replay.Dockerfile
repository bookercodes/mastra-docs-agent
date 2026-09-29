FROM node:24-bookworm-slim

WORKDIR /app
COPY scripts/replay-kapa.ts ./scripts/replay-kapa.ts

ENV NODE_ENV=production
ENV REPLAY_STATE_FILE=/data/replay-state.json

CMD ["node", "--experimental-strip-types", "scripts/replay-kapa.ts"]
