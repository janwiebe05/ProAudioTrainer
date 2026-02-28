FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY src/ ./src/
RUN mkdir -p uploads src/data

ENV PORT=3001
ENV NODE_ENV=production

EXPOSE 3001

CMD ["node", "src/server.js"]
