# Changelog

## 1.1.3

### Fixed

- Stale windows, blocks and darkened colours on Windows hosts with
  "Prioritize H.264/AVC 444" on. An AVC444 update is two views of one H.264
  sequence and the bridge dropped the chroma one, so later pictures decoded
  against references the browser never had. The bridge now sends it as AVCX
  and the decoder takes it without painting it. Needs the matching bridge
  image.

## 1.1.2

### Fixed

- Switching to another tab and back started the session over. The shell
  re-renders a tab when it is shown again, the tab hands the app a fresh
  connection callback each render, and the effect that opens the session
  depended on it.

## 1.1.1

### Fixed

- The host editor showed nothing under Direct RDP. Since Termix 26.11 core
  draws a plugin's manifest host fields on a host only when the plugin has
  no editor section of its own, and the login section made this one such a
  plugin, so the port and printing switch went with it. Everything Direct
  RDP asks of a host is now one section named after the protocol, the way
  upstream's RDP does it: port, printing, and the Windows login while RDP
  is off.

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
- A host that could not be reached took the plugin's whole process down:
  core's socket fails as a stream error since 26.11, and nothing heard it.

## 1.0.0

### Added

- First release: Direct RDP moved out of this fork's core patches into a
  plugin of its own, with its own protocol and tab.
