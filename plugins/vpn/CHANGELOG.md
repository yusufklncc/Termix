# Changelog

## 1.1.0

### Changed

- Runs in its own process on Termix 26.11.2 and later. The network manager
  is configured through the NET_MANAGER_* variables the manifest now lists,
  since a plugin process sees only those.
- Stays up rather than stopping when idle: it re-registers every doorway
  with the network manager each minute, and a manager restart would
  otherwise leave hosts unreachable until something woke the plugin.

## 1.0.0

### Added

- First release.
