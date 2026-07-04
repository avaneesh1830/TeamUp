# TeamUp — BTech project team finder
FROM node:22-alpine

WORKDIR /app

# install dependencies first (cached unless package files change)
COPY package*.json ./
RUN npm ci --omit=dev

# copy the rest of the app
COPY . .

# store the database on a volume so accounts survive container restarts
ENV DATA_DIR=/data
RUN mkdir -p /data
VOLUME /data

ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
