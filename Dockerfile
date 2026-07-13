# TeamUp — BTech project team finder
# node:22-slim (Debian/glibc), not alpine: better-sqlite3 ships prebuilt binaries
# for glibc Linux, avoiding a native compile toolchain in the image.
FROM node:22-slim

WORKDIR /app

# install dependencies first (cached unless package files change)
COPY package*.json ./
RUN npm ci --omit=dev

# copy the rest of the app
COPY . .

# store the SQLite database on a volume so accounts survive container restarts
ENV DATA_DIR=/data
RUN mkdir -p /data
VOLUME /data

ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
