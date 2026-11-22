# Changelog

## 1.1.0

### Changed

- Runs in its own process on Termix 26.11.2 and later.
  It asks for network:sockets, since the signaling connection to the
  streamer is a socket of its own.

### Fixed

- A session marked its host online and never let go, so the host read
  online for good after the first connection and was never asked again.

## 1.0.0

### Added

- First release: moved out of this fork's core patches into a plugin, with
  its own protocol and tab.
