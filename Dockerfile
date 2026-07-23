FROM node:20-bullseye-slim

# Install Python and dependencies required by MediaPipe, OpenCV, and Pillow
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-dev \
    ffmpeg \
    libsm6 \
    libxext6 \
    libjpeg-dev \
    zlib1g-dev \
    libpng-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package.json package-lock.json ./
RUN npm install

COPY requirements.txt ./
RUN python3 -m pip install --no-cache-dir -r requirements.txt

COPY . ./
RUN npm run build

EXPOSE 3000
CMD ["npm", "start"]
