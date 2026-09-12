# Termix RDP bridge — FreeRDP 3 with H.264, no decoding.
#
# Ubuntu ships FreeRDP 3 without H.264, so it is built from source here with
# -DWITH_FFMPEG=ON. That is the reason this lives in its own image rather than
# in the Termix one: only deployments that opt into the direct RDP path pay for
# the build, exactly as guacd is optional today.
#
# Drive/printer/serial redirection are switched off: drive redirection needs
# FUSE, and none of them are in the first prototype's scope anyway.

FROM ubuntu:24.04 AS build

ARG FREERDP_TAG=3.17.1
ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake ninja-build git ca-certificates pkg-config \
      libssl-dev libx11-dev libxext-dev libxinerama-dev libxcursor-dev \
      libxdamage-dev libxv-dev libxkbfile-dev libasound2-dev libcups2-dev \
      libxml2-dev libxrandr-dev libxi-dev libavutil-dev libavcodec-dev \
      libswscale-dev libusb-1.0-0-dev libudev-dev libdbus-glib-1-dev \
      libpulse-dev libgsm1-dev libkrb5-dev libcjson-dev uuid-dev zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone --depth 1 --branch "${FREERDP_TAG}" https://github.com/FreeRDP/FreeRDP.git

# Client and server binaries are not needed — only the libraries the bridge
# links against. WITH_FFMPEG is what brings in H.264 codec negotiation.
RUN cmake -GNinja -S FreeRDP -B build \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_INSTALL_PREFIX=/usr/local \
      -DWITH_FFMPEG=ON \
      -DWITH_DSP_FFMPEG=ON \
      -DWITH_SERVER=OFF \
      -DWITH_SAMPLE=OFF \
      -DWITH_CLIENT_SDL=OFF \
      -DWITH_X11=OFF \
      -DWITH_WAYLAND=OFF \
      -DWITH_PULSE=OFF \
      -DWITH_CUPS=OFF \
      -DWITH_MANPAGES=OFF \
      -DWITH_FUSE=OFF \
      -DCHANNEL_DRIVE=OFF \
      -DCHANNEL_PRINTER=OFF \
      -DCHANNEL_PARALLEL=OFF \
      -DCHANNEL_SERIAL=OFF \
    && cmake --build build --parallel \
    && cmake --install build

COPY bridge.c /src/bridge/bridge.c
RUN gcc -O2 -Wall -Wextra -o /usr/local/bin/termix-rdp-bridge /src/bridge/bridge.c \
      $(pkg-config --cflags --libs freerdp3 freerdp-client3 winpr3) -lpthread -lz -lwebp

FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      libssl3t64 libavcodec60 libavutil58 libswscale7 libcjson1 libkrb5-3 \
      libgsm1 zlib1g libwebp7 ca-certificates libusb-1.0-0 libasound2t64 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --no-create-home --shell /usr/sbin/nologin termix

COPY --from=build /usr/local/lib/ /usr/local/lib/
COPY --from=build /usr/local/bin/termix-rdp-bridge /usr/local/bin/termix-rdp-bridge
RUN ldconfig

USER termix
ENV BRIDGE_PORT=3390
EXPOSE 3390

ENTRYPOINT ["/usr/local/bin/termix-rdp-bridge"]
