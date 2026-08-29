FROM node:20-slim

# poppler-utils provides pdftoppm/pdfinfo, used for PDF page rendering.
# sharp needs a few standard image libs, which are already covered by the
# node:20-slim base + npm's prebuilt sharp binaries — no extra apt packages
# needed for that part.
RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
