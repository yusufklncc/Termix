# Desktop Stream

Opens a desktop someone else is already publishing -- Selkies, neko -- as a
Termix host.

Two ways, per host:

- **Embed** renders the publisher's own page in an iframe. Termix stores where
  it lives and nothing else.
- **WebRTC** relays only the signaling. The video and input go straight
  between the browser and the publisher, or through a TURN server; they never
  pass through Termix, so the cost on this server is close to nothing.
