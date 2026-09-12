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
- [x] Conventional commit'ler, küçük parçalar hâlinde

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
- [x] Medya Termix üzerinden geçmiyor — Termix backend'i %0.30 CPU ölçüldü

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
- [x] Jump host tüneli — `src/backend/hosts/rdp-direct/jump-tunnel.ts`.
      guacd yolunun mekanizması yeniden kullanıldı (`createJumpHostChain`,
      `resolveJumpTunnelEndpoint`). **Gerçek bir jump host'la denenmedi.**
- [x] Gerçek RDP sunucusuna bağlanıyor — kimlik doğrulama, GFX kanalı ve
      `ResetGraphics` çalışıyor; oturum ayakta kalıyor
- [x] **H.264 akıyor ve ekrana çiziliyor** — Windows 11 hedefinde oturumun
      %100'ü pass-through üzerinden geçiyor. Teşhis süreci:
      [`docs/phase3-handoff.md`](docs/phase3-handoff.md)
- [x] `update->DesktopResize` kaydı — GDI assert edip süreci `abort()` ediyordu
- [x] AVC420 dışı codec'te oturum ölmüyor; codec histogramı loglanıyor
- [x] **10.x capset reklamı** — "sadece AVC420" istemek 8.0'a düşürüyordu ve
      8.0'da H.264 yok. Şimdi 10.7 onaylanıyor
- [x] AVC444 luma pass-through (`LC=2` atlanıyor) — 4:2:0'a düşüş, decode yok

### Frontend

- [x] WebCodecs `VideoDecoder` + `OffscreenCanvas` worker'da (ana thread'de çizim yok)
- [x] RDP **scan code** eşlemesi (Faz 2'deki X11 keysym tablosu burada işe yaramıyor)
- [x] Fare + tekerlek
- [x] Host formunda render motoru seçimi, **varsayılan Guacamole**

### Sonraya

- [ ] WebTransport (HTTP/3 datagram) — WebSocket HOL blocking için
- [x] Pano (metin) — `CLIP`, çift yönlü. `SharedArrayBuffer` gerektirmediği için
      COOP/COEP kararına girmedi
- [ ] Ses, RDPDR — COOP/COEP kararı ile birlikte

### Ölçüm

- [x] Köprü tarafı FPS + codec dağılımı (5 sn'de bir)
- [x] Tarayıcı tarafı çizilen FPS (`onStats` → `statsLogger`)
- [x] İlk rakamlar → [`docs/phase3-measurements.md`](docs/phase3-measurements.md)
- [x] Sunucu CPU / bant genişliği → Faz 4 karşılaştırması
- [x] Guacamole karşılaştırması → [`docs/phase4-comparison.md`](docs/phase4-comparison.md)
- [x] Sabit çözünürlük — ölçümü tekrarlanabilir kılmak için
- [ ] Uçtan uca gecikme (fiziksel ölçüm gerekiyor)

### Canlı doğrulananlar

- [x] Rect konumlandırma — tıklanan yere gidiyor, yazılan harf doğru yerde
- [x] Klavye / fare uçtan uca — `Ctrl+A`, `Ctrl+C`, ok tuşları, tekerlek
- [x] Uzak imleç şekli (boyutlandırma oku, I-beam)
- [x] Ayrılmış kısayollar (Keyboard Lock, Chrome'da)

**Çıktı:** eksik özellik listesi (`docs/phase3-direct-rdp-gaps.md`), çalışan
prototip ve ilk ölçümler (`docs/phase3-measurements.md`). Faz 3'ün ana sorusu
— guacd'siz, sunucuda decode/re-encode olmadan RDP — **cevaplandı.**

**DUR, onay bekle**

---

## Faz 4 — Ölçüm ve sertleştirme

- [x] Guacamole yolunda FPS ölçümü (`client.onsync`, pasif)
- [x] Guacamole ↔ direct karşılaştırması: FPS, sunucu CPU, bant genişliği
      → [`docs/phase4-comparison.md`](docs/phase4-comparison.md)
- [ ] Uçtan uca gecikme (fiziksel ölçüm gerekiyor)
- [x] `stream` yolu aynı hedefe bağlanamadığı için üç yollu tablo mümkün değil;
      kendi ölçümü Faz 2'de alındı
- [x] ~~Yeni yol başarısız olursa Guacamole'e otomatik geri düşme~~ —
      **yapılmayacak, kullanıcı kararı.** Direct yol çalışmıyorsa hata
      gösterilecek. Gerekçe: sessiz geri düşme "neden yavaş" sorusunu görünmez
      kılar ve host bazlı seçimin anlamını ortadan kaldırır. Faz 3'ün teşhis
      süreci (capset pazarlığı, AVC444, imleç) sessiz bir geri düşme olsaydı
      hiç fark edilmezdi. Kullanıcı hangi yolu istediğini host formunda zaten
      açıkça seçiyor.
- [x] Belgeleme: kurulum, gereksinimler, hangi host tipinde hangi yol
      → [`docs/direct-rdp-setup.md`](docs/direct-rdp-setup.md)
- [x] ~~Upstream PR hazırlığı~~ — **yapılmayacak, kullanıcı kararı.** Bu iş
      upstream'e sunulmayacak; çalışma bu depoda kalıyor.

---

## Faz 5 — Optimizasyon ve eksik özellikler

Faz 4 onaylandıktan sonra, kullanıcı isteğiyle.

### Piksel yolunun bant genişliği (H.264 politikası kapalı)

Windows politika kapalıyken karma çalışıyor: ekranın video benzeri kısmını
H.264, geri kalanını ClearCodec ve progressive ile çiziyor. İkincisi köprüde
decode edilip piksel olarak gidiyor — 580 MB/dk'dan 41 MB/dk'ya indi.

- [x] Uyarlanabilir flush — küçük güncellemeler saati beklemiyor
- [x] WebP encode, tarayıcıda `createImageBitmap` ile native decode (4.1x)
- [x] İçeriğe göre kayıplı/kayıpsız seçimi (**14.2x**), metin kayıpsız kalıyor
- [x] Ölçüm ve gerekçe → [`docs/phase3-measurements.md`](docs/phase3-measurements.md)
- [x] ~~ClearCodec/progressive'i WASM ile tarayıcıda decode etmek~~ —
      **ölçüldü ve kapatıldı.** Kazanç WebP öncesi 4.2x, sonrası **1.25x**.
      FreeRDP codec modülünü emscripten ile derlemek + GFX yüzey modelini
      tarayıcıda yeniden kurmak, %25 için değmez. Ucuz çözüm pahalı olanı
      gereksiz kıldı.

### Eksik özellikler

- [x] Oturum kaydı — köprünün kendi wire akışı diske yazılıyor, oynatma aynı
      decoder'a geri veriyor. Tam ekran düğmesi dahil
- [x] Ses — `librdpsnd-client-termix.so` cihaz eklentisi, AudioWorklet ile
      sınırlı kuyruk. Kayıtlar da sesli
- [x] Yazdırma — `libprinter-client-termix.so` PostScript alıyor, ghostscript
      PDF'e çeviriyor, tarayıcı indiriyor. Host bazlı toggle, varsayılan kapalı
- [x] ~~Sürücü yönlendirme~~ — **yapılmayacak, kullanıcı kararı.** guacd'nin
      yaptığı da konteyner içi bir klasör; Termix'in dosya yöneticisi bu
      host'lara zaten erişiyor
- [ ] Sesli bir oturumu kaydedip oynatmak — denenmedi
- [ ] Yazıcının birden fazla Windows sürümünde denenmesi. Yazdırma rdpdr
      üzerinden gidiyor ve rdpdr isteğe bağlı değil: yüklenemeyen bir cihaz
      **tüm bağlantıyı** düşürüyor. Varsayılanın kapalı olma sebebi bu

### Bulunan, düzeltilmeyen

- [ ] `--bg-base`, `--bg-elevated`, `--foreground-secondary` bu projede hiçbir
      yerde tanımlı değil, ama `GuacamoleApp`, `FullScreenAppWrapper`,
      `SimpleLoader` ve `GuacamoleDisplay` bunları kullanıyor. Direct yolun
      bildirim kutusunda okunmazlığa sebep oldu ve orada gerçek token'larla
      düzeltildi; diğerleri koyu zemin üstünde fark edilmiyor. Ayrı iş

---

## Hedef makine tarafı (kodla ilgisi yok)

Faz 2 veya 3'e geçmeden önce durumu sorulacak:

- [x] Windows `DWMFRAMEINTERVAL` — `15` → 47 fps, **`10` → 60 fps** ölçüldü.
      Microsoft yalnızca `15`'i belgeliyor; ayrıntı ve uyarılar
      [`docs/phase3-measurements.md`](docs/phase3-measurements.md)
- [x] GPO: `Prioritize H.264/AVC 444` **Enabled** — bu olmadan sunucu H.264'ü
      hiç kullanmıyor. Donanım encode **Not Configured** kalmalı: açıldığında
      bu makinede mstsc bile bağlanamadı
- [ ] GPO: RDP transport UDP+TCP (port 3391) — denenmedi
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
