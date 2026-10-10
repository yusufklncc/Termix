# Direct RDP

Reaches an RDP host without guacd. A helper container runs FreeRDP 3, takes the
H.264 frames the server already sends, and passes them to the browser without
decoding them; the browser decodes them with WebCodecs on a worker thread.

guacd decodes the server's video and re-encodes it as image tiles, which is
what makes 1080p60 expensive. Nothing is re-encoded here, so the cost on the
server is close to nothing.

It is a separate protocol rather than an option on the RDP tab, so upstream's
remote-desktop plugin is untouched and keeps its own path.

## Requirements

- The `termix-rdp-bridge` container, reachable from the backend.
- HTTPS: WebCodecs and AudioWorklet need a secure context.
