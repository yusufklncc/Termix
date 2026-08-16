# Termix — yüksek FPS remote desktop render motoru

Çalışma planı ve ilerleme takibi. Detaylı mimari notlar: [`docs/rdp-architecture-notes.md`](docs/rdp-architecture-notes.md)

## Temel karar

Guacamole/guacd yolu **kaldırılmıyor**. Yanına ikinci bir render yolu ekleniyor.
Seçim **host bazlı bir bayrağa** bağlı, varsayılan her zaman Guacamole.

İki farklı "yan yana" şekli kullanılıyor:

- **Ayrı protokol tipi** (`stream`) — mevcut RDP koduna hiç dokunmaz. → Faz 1
- **Aynı `rdp` tipi + render motoru seçimi** — aynı tab, aynı RBAC, farklı render component'i. → Faz 3

---

## Faz 0 — Keşif ✅

- [x] Backend modül kaydı ve yükleme sırası
- [x] RDP akışının uçtan uca zinciri (dosya + satır)
- [x] `connectionDefaultSettings` ve override zinciri
- [x] Protokol tipi tanımları + yeni tip için dosya listesi
- [x] Host şeması ve field-level encryption katmanı
- [x] Yetkilendirme (REST + WS asimetrisi)
- [x] Session sharing mekanizması (guacd `join` bağımlılığı)
- [x] Frontend render katmanı ve tab seçimi
- [x] Test altyapısı
- [x] `docs/rdp-architecture-notes.md` yazıldı
- [x] Risk listesi verildi

---

## Faz 1 — Yeni protokol tipi: `stream` (embed)

Harici bir WebRTC masaüstü yayınını (Selkies, neko vb.) Termix host'u olarak kaydetme.
Kapsam dışı: signaling, medya, transcode.

### Şema (üç DB)

- [x] `src/backend/database/db/schema.ts` — `hosts` tablosuna `stream` kolonları
- [x] `src/backend/database/db/index.ts` — `sshDataMigrations` dizisine ALTER satırları
- [x] `src/backend/utils/field-crypto.ts` — `streamPassword` → `ssh_data` şifreli alan Set'i
- [x] `npm run schema:generate` → `schema.pg.ts`, `schema.mysql.ts`
- [x] `npm run schema:migrations` → `drizzle/postgres/`, `drizzle/mysql/`
- [ ] `npm run verify:dialect` — **çalıştırılamadı**, gerçek bir Postgres/MySQL `DATABASE_URL` istiyor.
      Migration SQL'leri üretildi ve gözden geçirildi; canlı DB'de doğrulama bekliyor.

### Backend

- [x] `src/backend/database/routes/host.ts` — create / update / get alan geçişleri
- [x] `src/backend/database/routes/host-normalizers.ts` — normalize + `enableX` fallback
- [x] `src/backend/database/routes/host-bulk-routes.ts` — import / export
- [x] Paylaşılan host credential akışı — **bilinçli kapsam kararı:** `stream` credential'ları
      sahibe özel. Alıcı `streamUrl`/`streamPath` görür, credential görmez. Faz 1'de credential
      zaten iframe'e enjekte edilmiyor, dolayısıyla işlevsel kayıp yok. Faz 2'de signaling
      credential'a ihtiyaç duyarsa `shared-host-secrets-*` akışına eklenecek.
- [x] Session sharing: `stream` bilinçli olarak **desteklenmiyor** (whitelist'e eklenmiyor)

### Frontend

- [x] `src/types/index.ts` — `ConnectionType`, `SSHHost` alanları
- [x] `src/types/ui-types.ts` — `TabType`, `Host` alanları
- [x] `src/ui/lib/host-connection-tabs.ts` — `stream` case'leri
- [x] `src/ui/shell/tabUtils.tsx` — `tabIcon` + `renderTabContent` + lazy component
- [x] **Yeni:** `src/ui/features/stream/StreamApp.tsx` — iframe render
- [x] `src/ui/sidebar/SidebarTree.tsx` — protokol rozeti + açma butonları
- [x] `src/ui/sidebar/HostEditor*.tsx` — host formu alanları (base URL, path, credential)
- [x] `src/ui/sidebar/HostManagerData.ts`, `HostManagerTabs.tsx`, `HostsPanel.tsx`
- [x] `src/ui/AppShell.tsx` — tab restore filtresi, default host objeleri
- [x] `src/ui/shell/CommandPalette.tsx`, homepage widget'ları
- [x] `src/ui/lib/connection-origin.ts` — `stream` için origin kararı
- [x] `src/ui/locales/en.json` — i18n anahtarları (hard-code string yok)

### Uyumluluk doğrulaması

- [x] RBAC — paylaşılan host'ta `stream` açılıyor / yetkisizde 403
- [x] Klasör, tag, favori (pin) sistemleri
- [x] Split-screen ve tab restore — split içerik `renderTabContent` portal'ıyla geliyor
      (protokolden bağımsız), `open-tabs.ts` tab tipini whitelist'siz geçiriyor
- [ ] Electron standalone modu — kod yolu incelendi (stream URL'i doğrudan renderer yüklüyor,
      backend devrede değil, `connection-origin` uygulanmıyor) ama **Electron ile çalıştırılmadı**

### Test / kalite

- [x] Backend testi — normalizer / repository
- [x] Frontend testi — `stream-url.ts` (saf yardımcı) + `HostEditorData` stream payload'ı.
      `StreamApp` component'inin kendisi için test yok — repo deseni saf fonksiyonları test ediyor
- [x] `npm run lint` (exit 0) · `npm test` (203 dosya / 1470 test) · `npm run build` temiz
- [x] `tsc --build` hata sayısı baseline ile karşılaştırıldı: 317 → 318
      (+1 = `StreamApp.tsx`'te `@/types` importu, GuacamoleApp/tabUtils ile aynı mevcut desen)
- [x] Biome + Prettier temiz
- [ ] Conventional commit'ler, küçük parçalar hâlinde — commit atılmadı, onay bekliyor

**Çıktı:** çalışan demo + ne test edildiğinin özeti → **DUR, onay bekle**

---

## Faz 2 — WebRTC signaling gateway

Termix medyaya hiç dokunmaz, sadece signaling'i proxy'ler. Yayıncı-başına adapter.

### Protokol bulguları (kaynak koddan doğrulandı)

**neko** (`m1k1o/neko`) — tam WebRTC:

- Zarf: `{"event": "<ad>", "payload": {...}}` (`server/pkg/types/websocket.go`)
- Auth: cookie · `Authorization: Bearer <token>` · `?token=` (`server/internal/session/auth.go:59-81`)
- Token `POST /api/login` ile alınıyor (`server/internal/api/router.go:41`)
- Akış: istemci `signal/request` `{video,audio}` → sunucu `signal/provide` `{sdp, iceservers, video, audio}`
  (teklif sunucudan geliyor) → istemci `signal/answer` `{sdp}` → iki yönlü `signal/candidate`
- `signal/restart` mevcut → **ICE restart bedava geliyor**
- `iceservers` sunucudan geliyor → TURN'ü neko kendi veriyor, Termix'in ayrıca yapılandırması gerekmiyor

**Selkies** (`selkies-project/selkies`) — WebRTC artık **opt-in**:

- README: _"streams over plain WebSockets by default, with WebRTC available as an opt-in transport"_
- WebRTC modunda gstwebrtc tarzı metin protokolü (`src/selkies/webrtc_signaling.py`):
  `HELLO <peer_type> {"server_token":...}` → `HELLO` → `SESSION_START <peer_id>` →
  sonrası `<peer_id> {"sdp":{"type","sdp"}}` / `<peer_id> {"ice":{"candidate","sdpMLineIndex"}}`
- Auth: WS handshake'te HTTP Basic Auth **veya** HELLO metadata'sında `server_token`

**Açık karar:** Selkies'in varsayılan modu (WebSocket + WebCodecs, STUN/TURN yok) mimari olarak
CLAUDE.md'nin **Faz 3** tarifine denk düşüyor. Selkies adapter'ı hangi moda yazılacak, kullanıcıya soruldu.

### Backend

- [x] `src/backend/hosts/webrtc/` modülü — `guacamole-server.ts` pattern'ı, kendi portu
- [x] `starter.ts`'e koşullu import (guacamole bloğu deseni, hata yutulur)
- [x] `docker/Dockerfile` EXPOSE + `nginx.conf` / `nginx-https.conf` WS location bloğu
- [x] **JWT doğrulaması `terminal/index.ts:270-347` deseniyle** (guac'ın token-only modeli değil)
- [x] `PermissionManager.canAccessHost(userId, hostId, "connect")` kontrolü
- [x] `SignalingAdapter` arayüzü — `src/backend/hosts/webrtc/signaling-adapter.ts`
- [x] neko adapter — `src/backend/hosts/webrtc/neko-adapter.ts`
- [x] Selkies adapter — `src/backend/hosts/webrtc/selkies-adapter.ts` (**WebRTC opt-in modu** seçildi)
- [x] Credential'lar backend'de kalır — tarayıcı yayıncının parolasını hiç görmez
- [ ] Medya Termix üzerinden geçmiyor — Node CPU maliyeti ~sıfır (ölçülecek)

### Şema

- [x] `streamMode` kolonu: `"embed"` (Faz 1, varsayılan) | `"webrtc"` (Faz 2)
- [x] `streamPublisher` kolonu: `"selkies"` | `"neko"`
- [x] Üç DB için migration + `field-crypto` gözden geçirmesi
- [x] Varsayılan `embed` — mevcut Faz 1 host'ları etkilenmez

### Frontend

- [x] `RTCPeerConnection` + `<video>`, `guacamole-common-js` bu yolda yüklenmiyor
      (Faz 1'de ayrı chunk zaten doğrulandı)
- [x] Input (klavye/fare) — **neko tamam**: `keysym.ts` (X11 keysym eşlemesi),
      `stream-input.ts` (pointer/klavye/tekerlek, koordinat ölçekleme, takılı tuş temizliği),
      `control/request` ile kontrol alma. 16 test.
- [x] Input — **Selkies tamam**: girdi data channel'da CSV metin (`binaryType` sadece
      sunucudan gelen veri için). Format `input_handler.py` `_dispatch_message`'tan çıkarıldı:
      `kd,<keysym>` · `ku,<keysym>` · `kr` · `m,<x>,<y>,<mask>,<magnitude>`, fare bit maskesi
      ve pulse'lu scroll bitleri dahil.
- [x] `StreamApp` içinde mod dallanması: `embed` → iframe, `webrtc` → peer connection
- [x] Bağlantı kopması, yeniden bağlanma, ICE restart (neko'da `signal/restart`)
- [x] TURN — neko `signal/provide` içinde kendi `iceservers`'ını gönderiyor ve gateway bunu
      tarayıcıya aktarıyor; ayrı host bazlı TURN alanına gerek kalmadı
- [x] Session sharing bu yolda yok → paylaş butonu kapalı (Faz 1'de `SHAREABLE_TAB_TYPES` ile çözüldü)

### Ölçüm

> Signaling ve input canlı neko'ya (Docker) karşı uçtan uca doğrulandı — aşağıya bak.
> FPS/gecikme rakamları gerçek bir tarayıcı gerektiriyor; adımlar `docs/` altında.

- [x] FPS — **1080p'de ~60** (`NEKO_MAX_FPS=60` ile; neko varsayılanı 25'te sabitliyor)
- [ ] Uçtan uca gecikme — jitter buffer ~60–70 ms + decode ~4–5 ms ölçüldü;
      **fiziksel gecikme ölçülmedi**. LAN/WAN yok, her şey tek makinede loopback.
- [x] Sunucu CPU — **Termix backend %0.30**, akış sürerken (neko aynı anda ~%240).
      Medyanın Termix'ten geçmediği hem CPU'yla hem ICE candidate pair'le doğrulandı.
- [ ] Guacamole yolu ile karşılaştırma — **yapılmadı**. Bu fazın kazancını rakamla
      söyleyebilmek için şart; Faz 4'e kaldı.

**Çıktı:** ölçüldü → [`docs/stream-webrtc-measurement.md`](docs/stream-webrtc-measurement.md)
Kod tarafı bitti. Açık kalanlar: fiziksel gecikme, gerçek LAN/WAN, Guacamole karşılaştırması,
ve FPS ile birlikte artan jitter buffer gecikmesinin sebebi.

**DUR, onay bekle**

---

## Faz 3 — FreeRDP 3 + WebCodecs (deneysel)

guacd olmadan gerçek RDP, 60fps hedefi. Riskli.

### Faz başı — tamamlandı

- [x] Referans implementasyon araştırıldı: [`qxsch/freerdp-web`](https://github.com/qxsch/freerdp-web)
      (Apache-2.0, aktif). Native FreeRDP3 + tipli binary wire format + WebCodecs
      `VideoDecoder` + OffscreenCanvas worker + AudioWorklet ring buffer — CLAUDE.md'nin
      tarif ettiği mimarinin birebir karşılığı.
- [x] **Eksik kalacak özellik listesi** → [`docs/phase3-direct-rdp-gaps.md`](docs/phase3-direct-rdp-gaps.md)

### Faz başı bulguları

- **AVC444 tuzağı doğrulandı.** Referans sunucuda FFmpeg ile 4:2:0'a transcode ediyor,
  yani CLAUDE.md'nin "CPU maliyeti geri gelir" dediği yolu seçmiş. Biz AVC420 zorlayacağız.
- **FreeRDP3 kaynaktan derlenmeli** (`-DWITH_FFMPEG=ON`). Dağıtım paketlerinde H.264 yok.
- **COOP/COEP çakışması.** `SharedArrayBuffer` cross-origin isolation ister; `COEP: require-corp`
  Faz 1'in iframe embed modunu kırar. Ses ve progressive codec ilk prototipte kapsam dışı
  bırakılırsa gerekmiyor.

### Kararlar (verildi)

- [x] Yardımcı process: **bağımsız C executable**. Python bağımlılığı yok, native addon yok,
      Node onu spawn eder ve binary wire format'ı soket üzerinden konuşur.
- [x] Dağıtım: **ayrı sidecar konteyner**, guacd'nin bugünkü konumu gibi. Ana Termix imajı büyümez.

### Pass-through doğrulandı

- [x] FreeRDP 3 kaynağından teyit edildi: `RdpgfxClientContext.SurfaceCommand` callback'i
      AVC420'de ham H.264 bitstream'ini `cmd->extra` ile veriyor, decode etmeden.
      Detay ve tuzaklar → `docs/phase3-direct-rdp-gaps.md` §5

### Backend

- [x] FreeRDP3 yardımcı process (native addon değil — çökme izolasyonu için)
- [x] AVC420 zorla, H.264 NAL'ları **decode etmeden** geçir
- [x] Binary wire format (magic header deseni)
- [x] Yeni WS modülü, JWT + `canAccessHost` (Faz 2 gateway'i örnek)
- [ ] Jump host tüneli — mevcut mekanizma yeniden kullanılacak (**yapılmadı**)
- [ ] **Gerçek bir RDP sunucusuna karşı hiç denenmedi** — köprü ayakta ve protokol
      çerçeveleme iki yönde doğrulandı, ama H.264 karesi henüz akmadı

### Frontend

- [x] WebCodecs `VideoDecoder` + `OffscreenCanvas` worker'da (ana thread'de çizim yok)
- [x] RDP **scan code** eşlemesi (Faz 2'deki X11 keysym tablosu burada işe yaramıyor)
- [x] Fare + tekerlek
- [x] Host formunda render motoru seçimi, **varsayılan Guacamole**

### Sonraya

- [ ] WebTransport (HTTP/3 datagram) — WebSocket HOL blocking için
- [ ] Ses, clipboard, RDPDR — COOP/COEP kararı ile birlikte

**Çıktı:** eksik özellik listesi verildi (`docs/phase3-direct-rdp-gaps.md`),
prototip yazıldı ve derleniyor. **Ölçüm yok — gerçek bir RDP host'una bağlanmadı.**

**DUR, onay bekle**

---

## Faz 4 — Ölçüm ve sertleştirme

- [ ] Üç yol karşılaştırması: FPS, gecikme, sunucu CPU, bant genişliği
- [ ] Yeni yol başarısız olursa Guacamole'e otomatik geri düşme
- [ ] Belgeleme: kurulum, gereksinimler, hangi host tipinde hangi yol
- [ ] Upstream PR hazırlığı (`CONTRIBUTING.md`)

---

## Hedef makine tarafı (kodla ilgisi yok)

Faz 2 veya 3'e geçmeden önce durumu sorulacak:

- [ ] Windows `DWMFRAMEINTERVAL` DWORD = 15 (60 FPS tavanı)
- [ ] GPO: H.264/AVC 444 önceliği, donanım encode, UDP+TCP (port 3391)
- [ ] Headless makinede sanal ekran (IddSampleDriver/VDD, dummy Xorg, headless Wayland)

---

## Değişmez kurallar (her fazda geçerli)

1. Mevcut guacd yolu bozulmayacak — silme, refactor, "temizleme" yok
2. Her yeni yol feature flag / host bazlı seçim arkasında, varsayılan Guacamole
3. Repo'nun mevcut kod stiline uy, yeni mimari icat etme
4. Şema değişikliği → üç DB için de migration
5. Electron standalone modu unutulmayacak
6. Yeni UI metni i18n anahtarı olarak, hard-code string yok
7. Conventional commit, küçük parçalar
8. Emin olunmayan yerde tahmin yok — sor
