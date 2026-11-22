# Changelog

## 1.1.0

### Changed

- Runs in its own process on Termix 26.11.2 and later. The bridge address is
  read from the RDP_BRIDGE_* variables the manifest now lists, since a plugin
  process sees only those.
- Recordings are written to the plugin's own folder and handed to
  session-recording through a reader, because neither plugin can open the
  other's files any more.

### Fixed

- A session marked its host online and never let go, so the host read
  online for good after the first connection and was never asked again.

## 1.0.0

### Added

- First release: Direct RDP moved out of this fork's core patches into a
  plugin of its own, with its own protocol and tab.
