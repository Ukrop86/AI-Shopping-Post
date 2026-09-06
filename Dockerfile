FROM node:22

# libheif-examples дає heif-convert: ffmpeg у цьому образі не читає HEIC/HEIF
# (формат фото з iPhone за замовчуванням), тож без нього такі фото довелося б
# відхиляти на завантаженні.
RUN apt-get update && apt-get install -y ffmpeg fonts-dejavu-core libheif-examples

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY . .

RUN npm run build

EXPOSE 8080

CMD ["npm", "run", "start"]