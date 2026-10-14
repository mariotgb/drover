FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
    dpkg fakeroot rpm binutils ca-certificates python3 imagemagick lsof \
    libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 xdg-utils libatspi2.0-0 \
    libuuid1 libsecret-1-0 libgbm1 libasound2 xvfb xauth xdotool \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci && node node_modules/electron/install.js
COPY . .
ENV CSC_IDENTITY_AUTO_DISCOVERY=false
CMD ["npm", "run", "dist:linux"]
