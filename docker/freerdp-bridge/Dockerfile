# Termix RDP bridge — FreeRDP 3 with H.264, no decoding.
#
# Ubuntu ships FreeRDP 3 without H.264, so it is built from source here with
# -DWITH_FFMPEG=ON. That is the reason this lives in its own image rather than
# in the Termix one: only deployments that opt into the direct RDP path pay for
# the build, exactly as guacd is optional today.
#
# Drive and serial redirection are switched off: drive redirection needs FUSE,
# and Termix's own file manager already reaches these hosts. Printing is on --
# there is no other way to get a document out of a remote desktop.
#
# ALSA and PulseAudio are off too, and that one is not a size decision. This
# container has no sound card and must never look for one: remote audio is
# carried to the browser by rdpsnd_termix.c instead. Leaving ALSA built meant
# rdpsnd could pick it, which it did -- filling the log with card-not-found
# errors while the viewer heard nothing.

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
      -DWITH_ALSA=OFF \
      -DWITH_CUPS=OFF \
      -DWITH_MANPAGES=OFF \
      -DWITH_FUSE=OFF \
      -DCHANNEL_DRIVE=OFF \
      -DCHANNEL_PARALLEL=OFF \
      -DCHANNEL_SERIAL=OFF \
    && cmake --build build --parallel \
    && cmake --install build

# The audio device FreeRDP dlopens by name. Remote sound has to reach a
# browser rather than a sound card, and a device plugin is the supported place
# to intercept it -- the static addins built into the library are tried first
# and this is the fallback the loader reaches for "termix".
COPY printer_termix.c /src/bridge/printer_termix.c
RUN mkdir -p /usr/local/lib/freerdp3 \
    && gcc -O2 -Wall -Wextra -fPIC -shared \
      -o /usr/local/lib/freerdp3/libprinter-client-termix.so /src/bridge/printer_termix.c \
      $(pkg-config --cflags freerdp3 winpr3)

COPY rdpsnd_termix.c /src/bridge/rdpsnd_termix.c
RUN mkdir -p /usr/local/lib/freerdp3 \
    && gcc -O2 -Wall -Wextra -fPIC -shared \
      -o /usr/local/lib/freerdp3/librdpsnd-client-termix.so /src/bridge/rdpsnd_termix.c \
      $(pkg-config --cflags freerdp3 winpr3)

COPY bridge.c /src/bridge/bridge.c
# -rdynamic so the device above can resolve termix_audio_sink back into this
# binary: the plugin is dlopened into this process and the samples go up, not
# out.
RUN gcc -O2 -Wall -Wextra -rdynamic -o /usr/local/bin/termix-rdp-bridge /src/bridge/bridge.c \
      $(pkg-config --cflags --libs freerdp3 freerdp-client3 winpr3) -lpthread -lz -lwebp

FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      libssl3t64 libavcodec60 libavutil58 libswscale7 libcjson1 libkrb5-3 \
      libgsm1 zlib1g libwebp7 ca-certificates libusb-1.0-0 libasound2t64 \
      ghostscript \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --no-create-home --shell /usr/sbin/nologin termix

COPY --from=build /usr/local/lib/ /usr/local/lib/
COPY --from=build /usr/local/bin/termix-rdp-bridge /usr/local/bin/termix-rdp-bridge
RUN ldconfig

USER termix
ENV BRIDGE_PORT=3390
EXPOSE 3390

ENTRYPOINT ["/usr/local/bin/termix-rdp-bridge"]
