# Changelog

## 1.1.0

### Changed

- Runs in its own process on Termix 26.11.2 and later.
  It asks for network:sockets, since the signaling connection to the
  streamer is a socket of its own.

## 1.0.0

### Added

- First release: moved out of this fork's core patches into a plugin, with
  its own protocol and tab.
