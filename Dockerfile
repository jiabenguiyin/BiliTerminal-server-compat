FROM node:22-alpine

WORKDIR /app
COPY package.json server.js ./
COPY data ./data
RUN mkdir -p /app/logs

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
EXPOSE 3000

CMD ["node", "server.js"]
