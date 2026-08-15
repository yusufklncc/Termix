# WebRTC stream yolu — kurulum ve ölçüm

Faz 2'nin çıktısı olan FPS ve gecikme rakamları gerçek bir tarayıcı gerektiriyor.
Bu belge test hedefini ayağa kaldırmayı ve rakamları almayı anlatır.

## Test hedefi: neko

```bash
docker run -d --name neko --shm-size=1gb \
  -p 8080:8080 -p 52000-52100:52000-52100/udp \
  -e NEKO_DESKTOP_SCREEN=1920x1080@60 \
  -e NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=admin \
  -e NEKO_MEMBER_MULTIUSER_USER_PASSWORD=neko \
  -e NEKO_WEBRTC_EPR=52000-52100 \
  -e NEKO_WEBRTC_NAT1TO1=<bu-makinenin-LAN-IP'si> \
  ghcr.io/m1k1o/neko/firefox:latest
```

`NEKO_WEBRTC_NAT1TO1` önemli: tarayıcı ile neko arasındaki medya doğrudan aktığı için
neko'nun ICE adaylarında ulaşılabilir bir adres göstermesi gerekir. Aynı makinede test
ediyorsan `127.0.0.1` yeterli; LAN'dan bağlanacaksan makinenin LAN IP'sini yaz.

60 FPS hedefliyorsan `NEKO_DESKTOP_SCREEN` içindeki `@60` kısmı şart — varsayılan 30.

## Termix host'u

Host editöründe:

| Alan                | Değer                     |
| ------------------- | ------------------------- |
| Protokol            | Stream açık               |
| Render Mode         | **WebRTC**                |
| Publisher           | **neko**                  |
| Base URL            | `http://<neko-host>:8080` |
| Auth Method         | Direct                    |
| Username / Password | `admin` / `admin`         |

Kimlik bilgileri backend'de kalır; tarayıcıya hiç gitmez.

## Selkies kullanacaksan

Selkies varsayılan olarak düz WebSocket + WebCodecs ile akıtıyor. Bu yol onun
**opt-in WebRTC transport'una** yazıldı, dolayısıyla Selkies tarafında WebRTC'yi
açman gerekiyor. Açmadan Publisher olarak Selkies seçersen signaling el sıkışması
başlamaz.

## Ölçüm

Tarayıcıda stream sekmesini aç, sonra:

### FPS ve çözünürlük

`chrome://webrtc-internals` → ilgili peer connection → `inbound-rtp (video)`:

- `framesPerSecond` — anlık FPS
- `frameWidth` / `frameHeight` — gerçekte gelen çözünürlük
- `framesDropped` — düşen kare varsa decode ya da ağ darboğazı

### Uçtan uca gecikme

Aynı panelde `inbound-rtp` altında:

- `jitterBufferDelay` / `jitterBufferEmittedCount` → ortalama jitter buffer gecikmesi
- `totalDecodeTime` / `framesDecoded` → kare başına decode süresi

Fiziksel gecikme için: hedef masaüstünde milisaniye gösteren bir kronometre aç,
ekranı telefonla çek, kronometrenin gerçek değeri ile ekrandaki değer farkı
uçtan uca gecikmedir. `webrtc-internals` rakamları ağ + decode'u verir, ekran
yakalama ve encode gecikmesini vermez.

### Sunucu CPU'su

Faz 2'nin iddiası "medya Termix'ten geçmiyor". Doğrulaması:

```bash
# Termix backend sürecinin PID'i
pidstat -p $(pgrep -f "backend/starter.js") 1 30
```

Akış sürerken bu rakam boştaki değerin üstüne çıkmamalı. Karşılaştırma için aynı
ölçümü bir Guacamole RDP oturumu açıkken tekrarla — guacd konteynerinin CPU'su ile
arasındaki fark bu fazın bütün gerekçesi.

### Bant genişliği

`webrtc-internals` → `inbound-rtp` → `bytesReceived` eğimi. Termix sunucusunun
ağ trafiğini ayrıca ölç (`nload`, `iftop`); WebRTC yolunda Termix'te yalnızca
signaling trafiği görünmeli (kilobayt mertebesinde), medya değil.

## Ölçüm sonuçları (16 Ağustos 2026)

### Ortam

|               |                                                                      |
| ------------- | -------------------------------------------------------------------- |
| Termix + neko | WSL2 (12 CPU), Ryzen 5 5600                                          |
| Tarayıcı      | Windows ana makine, Vivaldi                                          |
| GPU           | Intel Arc B580 — **kullanılmadı**, `/dev/dri` WSL2'de boş            |
| Ağ yolu       | WSL2 ↔ Windows host (loopback). **Gerçek LAN değil, WAN hiç değil.** |

### Rakamlar

| Ölçüm                    | neko varsayılanı | `NEKO_MAX_FPS=60`  |
| ------------------------ | ---------------- | ------------------ |
| framesPerSecond          | ~25              | **~60**            |
| Çözünürlük               | 1920×1080        | 1920×1080          |
| Kareler arası gecikme    | ~40 ms           | **~16 ms**         |
| Bit hızı                 | ~6 Mbps          | ~20 Mbps           |
| Decode / kare            | ~6 ms            | ~4–5 ms            |
| jitterBufferDelay / kare | ~25–30 ms        | ~60–70 ms          |
| packetsLost (kümülatif)  | ~500             | ~800               |
| freezeCount              | 0                | 0                  |
| **neko CPU**             | ~128 %           | ~230–250 %         |
| **Termix backend CPU**   | —                | **%0.30 ortalama** |

### Faz 2'nin iddiası doğrulandı

1080p60 akış sürerken Termix backend'i **%0.30 CPU** kullanıyor. Aynı anda neko
~%240 yakıyor. ICE candidate pair de medyanın `127.0.0.1:52064`'e — neko'nun
`NEKO_WEBRTC_EPR` aralığına — gittiğini, gateway'in portuna (30013) hiç
uğramadığını gösteriyor. Medya Termix üzerinden geçmiyor.

### Üç bulgu

**1. 25 FPS tavanı neko'nun varsayılanıydı, encode kapasitesi değil.**
`server/internal/config/capture.go` içindeki varsayılan pipeline `Fps: "25"` ile
sabit. Ekran 60 Hz olsa da fark etmiyor. 1080p ve 720p'de aynı 25 çıkması bunun
kanıtıydı — piksel yükü yarıya inince FPS değişmedi. `NEKO_MAX_FPS=60` tavanı
kaldırıyor (v2 API, deprecated uyarısı veriyor ama çalışıyor).

**2. GPU encode bu kurulumda mümkün değil ve gerekmedi.**
WSL2'de `/dev/dri` boş, dolayısıyla Arc B580'e VAAPI erişimi yok. Yine de
Ryzen 5 5600 yazılımsal VP8 ile 1080p60'ı ~2.5 çekirdekle çıkarıyor (12 CPU'nun
~%21'i).

**3. FPS arttıkça gecikme de arttı.**
jitterBufferDelay 25–30 ms'ten 60–70 ms'e çıktı, packetsLost/nackCount yükseldi.
20 Mbps'i WSL2'nin sanal ağından geçirirken bir yerde tampon taşıyor. "Yüksek FPS

- düşük gecikme" hedefinin ikinci yarısıyla çelişiyor; sebebi araştırılmadı.

### Ölçülmeyenler

- **Fiziksel uçtan uca gecikme** — kronometre/fotoğraf yöntemi uygulanmadı
- **Gerçek LAN ve WAN** — her şey tek makinede, loopback üzerinden
- **Guacamole karşılaştırması** — bu fazın kazancını rakamla söyleyebilmek için şart,
  Faz 4'e kaldı
- **H.264** — `NEKO_WEBRTC_VIDEO_CODEC=h264` denenmedi; alıcıda
  `powerEfficientDecoder=false` olduğu için donanım decode kazancı ölçülebilir

## Şu ana kadar doğrulanmış olanlar

Canlı neko konteynerine karşı test edildi:

- Gateway neko'ya login oluyor, token alıyor, WS'i açıyor
- `signal/request` → neko `signal/provide` ile gerçek SDP teklifi dönüyor
  (VP8 video + Opus ses + data channel), ICE sunucuları aktarılıyor
- ICE adayları iki yönde akıyor
- `control/request` ile kontrol alınıyor (`control/host` → `has_host: true`)
- `control/move` · `keydown` · `keyup` · `buttondown` · `buttonup` · `scroll`
  sunucu tarafında hatasız kabul ediliyor

Ölçülmemiş olan: gerçek medya akışı, FPS, gecikme. Bunlar tarayıcı gerektiriyor.

## Not: neko VP8 ile pazarlık ediyor

Yukarıdaki testte neko'nun teklifi VP8 içeriyordu, H.264 değil. 60 FPS hedefinde
codec seçimi belirleyici olabilir — neko'nun `NEKO_WEBRTC_VIDEO_CODEC` ayarı ile
H.264'e zorlamayı deneyip iki codec'i karşılaştırmak Faz 4 ölçümlerine girmeli.
