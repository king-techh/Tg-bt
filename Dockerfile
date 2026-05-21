FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY index.js ./

# Render needs a port exposed
EXPOSE $PORT

CMD ["node", "index.js"]
