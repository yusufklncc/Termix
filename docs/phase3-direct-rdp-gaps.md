# Faz 3 — Direct H.264 RDP yolunda eksik kalacaklar

CLAUDE.md bu listeyi faz başında istiyor: guacd'nin bugün bedava verdiği ve
guacd'siz yolda **yeniden yazılması ya da kaybedilmesi** gereken şeyler.

Referans implementasyon: [`qxsch/freerdp-web`](https://github.com/qxsch/freerdp-web)
(Apache-2.0, Ağustos 2026'da aktif). Mimarisi CLAUDE.md'nin tarif ettiğiyle birebir
örtüşüyor: native FreeRDP3 + tipli başlıklı binary wire format + WebCodecs
`VideoDecoder` + OffscreenCanvas worker + AudioWorklet/SharedArrayBuffer ring buffer.

---

## 1. Referans implementasyonda da yok

| Özellik                          | Durum                                                                               |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| **Clipboard (kopyala/yapıştır)** | `qxsch/freerdp-web`'de "Todo" olarak işaretli. Sıfırdan yazılacak (CLIPRDR kanalı). |

---

## 2. Yeniden yazılması gerekenler

Bunların hepsi bugün guacd tarafından hallediliyor; yeni yolda karşılığı yok.

| Özellik                        | Bugün nasıl                                              | Yeni yolda ne gerekir                                                                                                                                                     |
| ------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Klavye scan code çevirimi**  | guacd, Guacamole keysym'lerini RDP scan code'a çeviriyor | Tarayıcı `KeyboardEvent` → RDP scan code. Faz 2'de X11 keysym eşlemesi yazdık ama RDP **scan code** istiyor, farklı bir tablo. Klavye düzeni (`serverLayout`) da devrede. |
| **RDPDR (sürücü yönlendirme)** | `enable-drive`, `drive-path`, upload/download            | Kanal + dosya sistemi köprüsü. Termix'in dosya yöneticisiyle entegrasyonu ayrı iş.                                                                                        |
| **Ses (RDPSND)**               | `disable-audio`, `audio: ["audio/L16"]`                  | Referansta var: RDPSND plugin → Opus (64 kbps) → WebCodecs `AudioDecoder` + AudioWorklet. Uyarlanabilir ama **SharedArrayBuffer gerektiriyor** (aşağıya bak).             |
| **Mikrofon (audio input)**     | `enable-audio-input`                                     | Ters yön, referansta yok.                                                                                                                                                 |
| **Çoklu monitör**              | guacd tek surface veriyor; Termix zaten kullanmıyor      | GFX çoklu surface yönetimi. Referans surface yönetimi yapıyor ama çoklu monitör senaryosu belgelenmemiş.                                                                  |
| **Reconnect**                  | guacd oturumu tutuyor, Termix yeniden token alıyor       | Yardımcı process'te oturum ömrü + tarayıcı tarafında yeniden bağlanma. Referansta `reconnectDelay` var.                                                                   |
| **Yazıcı yönlendirme**         | `enable-printing`, `printer-name`                        | Yok.                                                                                                                                                                      |
| **RemoteApp**                  | `remote-app`, `remote-app-dir`, `remote-app-args`        | Yok.                                                                                                                                                                      |
| **RD Gateway**                 | `gateway-hostname/port/username/password/domain`         | FreeRDP destekliyor ama köprüde açılması gerekir.                                                                                                                         |

---

## 3. Termix'e özel kayıplar

Referans implementasyonun bilemeyeceği, bize özgü olanlar.

| Özellik                        | Neden kaybolur                                                                                                                                                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Session recording**          | Termix bugün RDP oturumlarını guacd'nin `.guac` formatında kaydediyor ve `session_recordings` tablosuna yazıyor. guacd yoksa bu format da yok. Kayıt istenirse yeni bir format ve yeni bir oynatıcı gerekir.                                                              |
| **Session sharing**            | Faz 0'da tespit edildi: RDP paylaşımı tamamen guacd'nin `join` özelliğine dayanıyor. Bu yolda yok. Faz 1'de `SHAREABLE_TAB_TYPES` ile paylaş butonunu kapatma mekanizması hazır.                                                                                          |
| **Jump host tüneli**           | Termix tarafında çözülmüş (`routes.ts` geçici SSH tüneli açıp guacd'ye tünel portunu veriyor). Yeni yolda yardımcı process'e aynı şeyin yapılması gerekir — mekanizma yeniden kullanılabilir.                                                                             |
| **`guacamoleConfig` ayarları** | Host formundaki ~40 ayar (wallpaper, theming, font smoothing, bitmap caching, glyph caching, color depth, resize method...) doğrudan guacd parametreleri. Yeni yolda karşılıkları FreeRDP komut satırı seçeneklerine tek tek eşlenmeli; birebir karşılığı olmayanlar var. |

---

## 4. Yeni gelen kısıtlar

Bunlar "eksik özellik" değil, bu mimarinin getirdiği yeni yükler.

### FreeRDP3'ün özel derlenmesi şart

> "Ubuntu's FreeRDP3 package is compiled _without_ H.264 support. The Docker build
> compiles FreeRDP3 from source with `-DWITH_FFMPEG=ON`."

Yani dağıtım paketleri işe yaramıyor. Termix'in Docker imajına kaynaktan FreeRDP3
derlemesi girecek — imaj boyutu ve build süresi ciddi şekilde artar.

### AVC444 tuzağı doğrulandı

CLAUDE.md'nin uyardığı tuzak gerçek: tarayıcı decoder'ları AVC444 (4:4:4) kabul
etmiyor. Referans implementasyon **sunucuda FFmpeg ile 4:2:0'a transcode ediyor** —
yani CLAUDE.md'nin "CPU maliyeti geri gelir" dediği yolu seçmiş.

CLAUDE.md **AVC420 ile başlamayı** söylüyor, ki pass-through'u temiz tutar. Bu
noktada referanstan bilinçli olarak ayrılıyoruz: AVC420 zorlanacak, transcode
yapılmayacak. Kalite biraz düşer, sunucu CPU'su sıfıra yakın kalır.

### COOP/COEP başlıkları — Faz 1 ile çakışıyor

Referansın progressive codec WASM decoder'ı ve AudioWorklet ring buffer'ı
`SharedArrayBuffer` kullanıyor, bu da sayfanın **cross-origin isolated** olmasını
gerektiriyor (`Cross-Origin-Opener-Policy: same-origin` +
`Cross-Origin-Embedder-Policy: require-corp`).

**Sorun:** `COEP: require-corp` sayfaya gömülen üçüncü taraf kaynaklarını, uygun
CORP başlığı göndermedikleri sürece bloklar. Faz 1'in `embed` modu tam olarak bunu
yapıyor — harici bir masaüstü sayfasını iframe'e gömüyor. Bu başlıklar Termix'in
tamamına açılırsa **Faz 1'in embed modu kırılır.**

Kaçış yolu var: video için `SharedArrayBuffer` gerekmiyor. Yalnızca

- progressive/ClearCodec WASM decoder'ı (AVC420 zorlarsak gerekmez)
- AudioWorklet ring buffer (sesi ilk sürümde kapsam dışı bırakırsak gerekmez)

Yani **ilk prototipte ses ve progressive codec kapsam dışı bırakılırsa COOP/COEP
hiç gerekmez** ve Faz 1 ile çakışma oluşmaz. Ses eklendiğinde bu karar yeniden
ele alınmalı.

### WebSocket head-of-line blocking

CLAUDE.md'nin notu: WebSocket TCP olduğu için bir paket kaybı arkasındaki bütün
kareleri bekletir. Önce WebSocket ile çalıştırılacak, WebTransport (HTTP/3 datagram)
sonra değerlendirilecek. Referans da WebSocket kullanıyor.

---

## 5. Pass-through hook'u — FreeRDP 3 kaynağından doğrulandı

Bu fazın en riskli varsayımı "H.264 NAL'larını decode etmeden alabilir miyiz"
sorusuydu. Cevap **evet** ve hook noktası net.

`channels/rdpgfx/client/rdpgfx_codec.c`, `rdpgfx_decode_AVC420()`:

```c
UINT error = rdpgfx_read_h264_metablock(gfx, s, &(h264.meta));  // sadece metablock
h264.data   = Stream_Pointer(s);                                 // kalan = ham H.264
h264.length = (UINT32)Stream_GetRemainingLength(s);
cmd->extra  = (void*)&h264;
error = logSurfaceCommand(gfx, cmd);                             // → context->SurfaceCommand
free_h264_metablock(&h264.meta);
```

Ve `rdpgfx_main.c`, `logSurfaceCommand()`:

```c
const UINT error = IFCALLRESULT(CHANNEL_RC_OK, context->SurfaceCommand, context, cmd);
```

Yani FreeRDP yalnızca **metablock'u** (bölge dikdörtgenleri + quant/quality) parse
ediyor; H.264 bitstream'ine dokunmuyor ve olduğu gibi callback'e veriyor. Decode
işi daha sonra, GDI'nin `gdi_SurfaceCommand_AVC420` → `avc420_decompress`
implementasyonunda oluyor — ki biz tam olarak onu değiştireceğiz.

**Hook:** `RdpgfxClientContext`'in `SurfaceCommand` alanına kendi callback'imizi
yazmak. `codecId == RDPGFX_CODECID_AVC420` olduğunda:

| Elimize gelen                                                   | Ne işe yarar                          |
| --------------------------------------------------------------- | ------------------------------------- |
| `cmd->surfaceId`                                                | Hangi yüzey                           |
| `cmd->left/top/right/bottom`, `width/height`                    | Hedef bölge                           |
| `((RDPGFX_AVC420_BITMAP_STREAM*)cmd->extra)->data` / `->length` | **Dokunulmamış H.264 bitstream**      |
| `->meta.numRegionRects`, `->meta.regionRects`                   | Bu karenin güncellediği dikdörtgenler |

**Tuzak:** `free_h264_metablock(&h264.meta)` callback döner dönmez çalışıyor.
Rect'ler callback içinde kopyalanmalı, referans tutulamaz.

Sunucu tarafında decode/encode adımı yok — CLAUDE.md'nin "bütün mesele bu" dediği
şart sağlanıyor.

---

## 6. İlk prototipin kapsamı (öneri)

Yukarıdakiler ışığında, "çalışan prototip" için en dar ve en dürüst kapsam:

**İçinde:**

- FreeRDP3 yardımcı process, AVC420 zorlanmış, H.264 NAL pass-through
- Binary wire format (referansın magic header deseni)
- WebCodecs `VideoDecoder` + OffscreenCanvas worker
- Klavye + fare (RDP scan code eşlemesi)
- Uzak imleç şekli (`CURS` → CSS `cursor`)
- Host formunda render motoru seçimi, varsayılan Guacamole

**Dışında (bilinçli):**

- Ses, clipboard, RDPDR, yazıcı, RemoteApp, çoklu monitör
- Session recording, session sharing
- Progressive/ClearCodec (AVC420 zorlandığı için gerekmiyor)

### Canlı testte ortaya çıkan, bu listede olmayan eksikler

İlk gerçek oturumda görülenler, üçü de giderildi:

- **Uzak imleç şekli.** Köprü imleç güncellemelerini hiç işlemiyordu; kullanıcı
  yalnızca kendi yerel okunu görüyordu. Tıklamalar doğru yere gittiği hâlde
  pencere kenarlarındaki boyutlandırma tutamağı, metin I-beam'i ve bekleme
  imleci görünmüyordu — yani "kenarlar çalışmıyor" izlenimi. Eklendi.
- **Sunucunun codec karışımı.** AVC420 dışı komutlar oturumu öldürüyordu.
  Ölçüldüğünde 10.7 capset'iyle oturumun %100'ü H.264 çıktı, ama bu sunucuya
  göre değişebilir; artık ölümcül değil, sayılıyor.
- **Tarayıcı kısayolları.** `Ctrl+W` gibi ayrılmış kombinasyonlar
  `preventDefault()` ile engellenemiyor ve Termix sekmesini kapatıyordu.
  Keyboard Lock API ile çözüldü (`src/ui/lib/keyboard-lock.ts`). API yalnızca
  tam ekranda geçerli olduğu için modül kendi düğmesini sunmuyor,
  `fullscreenchange` olayını dinliyor ve uygulamanın mevcut tam ekran
  anahtarıyla çalışıyor.

  Escape dahil **her tuş** kilitleniyor, çünkü uzak masaüstünün Escape'e
  ihtiyacı var; tarayıcı bu durumda tam ekrandan çıkmak için basılı tutmayı
  şart koşuyor ve bunu kendisi bildiriyor.

  Chromium dışında API yok, orada sessizce devre dışı kalıyor ve ayrılmış
  kısayollar tarayıcı anlamını koruyor.

  **Tarayıcı desteği ölçüldü.** Termix'ten bağımsız, tek sayfalık bir test ile
  (tam ekran + `navigator.keyboard.lock()`):

  | Tarayıcı | `navigator.keyboard` | `lock()`                                                     |
  | -------- | -------------------- | ------------------------------------------------------------ |
  | Chrome   | var                  | **alınıyor** — `Ctrl+W` ve `Alt+Tab` yakalanıyor             |
  | Vivaldi  | var                  | `InvalidStateError: lock() request could not be registered.` |

  Vivaldi API'yi gösteriyor ama kaydı reddediyor. Muhtemel sebep, sekmeleri
  kendi arayüzünün içinde guest view olarak barındırması: Keyboard Lock en dış
  ana çerçeveden istenmek zorunda. Bu bir Termix hatası değil — aynı test
  sayfası Termix hiç devrede değilken de aynı sonucu veriyor.

  Vivaldi'de `Ctrl+W` hâlâ sekmeyi kapatmaya çalışıyor, ama sessizce oturum
  kaybettirmiyor: `AppShell` aktif bağlantı varken `beforeunload` uyarısı
  çıkarıyor (`AppShell.tsx:1358`), kullanıcı onaylamadan kapanmıyor.

  Modül paylaşılan `lib/` altında, çünkü **Guacamole yolunda da aynı sorun
  var** (repoda başka `navigator.keyboard` kullanımı yok). O yol henüz
  bağlanmadı — mevcut davranışı değiştirmemek için bilinçli olarak.

Bu kapsam COOP/COEP gerektirmez, dolayısıyla Faz 1'i bozmaz.

---

## İkinci hedefin öğrettikleri

Faz 3 tek bir Windows makinesinde "çalışıyor" durumuna geldi. İkinci bir makine
(farklı üretici, farklı GPU) **altı ayrı varsayımı** birden açığa çıkardı. Hepsi
ilk hedefte sessizce doğru çıkmıştı; hiçbiri test edilmiş değildi.

| Varsayım                                        | Neden ilk hedefte görünmedi                                                             |
| ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| Codec dizesi Baseline'dır (`avc1.42E01E` sabit) | O encoder toleranslıydı; ikincisi Main üretiyor                                         |
| Yapılandırma öncesi gelen kare atılabilir       | Akış sürekliydi, IDR kısa sürede tekrar geliyordu                                       |
| Decoder resmi hemen verir                       | Main profile yeniden sıralamaya izin veriyor; boş masaüstünde sonraki kare hiç gelmiyor |
| `flush()` zararsızdır                           | Flush hiç gerekmemişti; sonrasında anahtar kare şart oluyor                             |
| Kodlanan boyut = yüzey boyutu                   | İkisi denk gelmişti                                                                     |
| Decoder başarısızlığı hata verir                | Donanım decoder kareleri kabul edip uydurduğu boyutta boş resim üretiyor, hata vermiyor |

Sonuncusu en sinsisi: bitstream `ffmpeg` ile kusursuz çözülüyordu (56 kare,
1152x1136, Main) ama tarayıcı 1280x720 raporlayıp yeşil boyuyordu. Bunu ancak
bitstream'i dosyaya döküp kendini açıklayan bir decoder'a sorarak anladık —
`BRIDGE_DUMP_AVC` o yüzden duruyor.

### Buradan çıkan kalıcı değişiklikler

- Codec dizesi akışın SPS'inden okunuyor, sabit değil
- Anahtar kare saklanıyor; decoder her yeniden kurulduğunda ona veriliyor
- Kare boyutu yüzeyle karşılaştırılıyor; uyuşmazsa decoder değiştiriliyor
- Donanım → yazılım → köprüde decode sırası, her adım ölçülmüş başarısızlıktan sonra
- Bu kararların hepsi `rdp-decode-policy.ts`'te ve testli

### Okunuşu

**"Çalışıyor" ifadesi, kaç farklı hedefte çalıştığıyla birlikte anlamlı.** Üçüncü
bir makine muhtemelen yeni varsayımlar çıkaracaktır — özellikle farklı bir GPU
üreticisi veya Windows Server sürümü.
