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
