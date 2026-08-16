# Faz 3 — direct RDP ölçümleri

Guacamole karşılaştırması Faz 4'te. Buradaki rakamlar direct H.264 yolunun
kendi davranışını belgeliyor.

## Ortam

|                    |                                                               |
| ------------------ | ------------------------------------------------------------- |
| Hedef              | Windows 11 laptop, `10.10.30.104:3389`, panel 1920x1200 60 Hz |
| Oturum çözünürlüğü | 1682x962 (tarayıcı sekmesinin boyutu)                         |
| Köprü              | `termix-rdp-bridge:dev`, FreeRDP 3.17.1, WSL2 içinde Docker   |
| Tarayıcı           | Ana makine (Ryzen 5 5600 + Arc B580), WSL2'ye ağ üzerinden    |
| İş yükü            | TestUFO (sürekli hareket — en kötü durum)                     |

Donanım H.264 encode **kapalı** (`Configure H.264/AVC hardware encoding` =
Not Configured). Yani sunucu yazılımla encode ediyor.

## Sonuçlar

| Hedef ayarı                | Köprü FPS   | Tarayıcı FPS | Codec dağılımı  |
| -------------------------- | ----------- | ------------ | --------------- |
| Varsayılan                 | 26.0 – 27.5 | ölçülmedi    | `avc444v2` %100 |
| `DWMFRAMEINTERVAL=15`      | 45.9 – 47.2 | 46.2         | `avc444v2` %100 |
| + `BRIDGE_RDP_NETWORK=lan` | 46.9 – 47.0 | ölçülmedi    | `avc444v2` %100 |

2428 karelik ölçümde `chroma-only skipped=0`.

Hedef makinede, oturum akarken (Görev Yöneticisi):

|                     |                                                    |
| ------------------- | -------------------------------------------------- |
| CPU                 | %6 @ 3.36 GHz                                      |
| GPU (Intel Iris Xe) | %14 — 3D %14, Video Decode %0, Video Processing %0 |
| Ağ                  | **Wi-Fi**, gönderim ~2.5 Mbps                      |

### Okunuşu

**Pass-through oturumun tamamını taşıyor.** Tek bir ClearCodec / progressive /
uncompressed komutu yok — 10.7 capset'i onaylandıktan sonra sunucu her şeyi
H.264 olarak gönderiyor. Yani "H.264 yolu + yanında resim yolu" gibi bir hibrit
gerekmedi.

**Kalite kaybı ölçülmedi ama atlanan kare yok.** `LC=2` (salt chroma) hiç
gelmedi, dolayısıyla her karede tam bir 4:2:0 resim geçiyor. Attığımız tek şey
AVC444'ün ek chroma düzlemi — yani kayıp 4:4:4 → 4:2:0 farkı kadar, kare kaybı
değil.

**27 fps tavanı hedefteydi, bizde değil.** Sayının kararlılığı (26.0–27.5)
kaynak sıkışması değil tavan davranışı. Windows'un varsayılan RDP kare aralığı
30 FPS'e sabitliyor; `DWMFRAMEINTERVAL` DWORD = 15 ile tavan 60'a çıkınca
ölçüm 47'ye taşındı.

**Tarayıcı yetişiyor.** Köprü 47 gönderirken tarayıcı 46.2 çiziyor — decoder
geride kalmıyor, kare düşmüyor. WebCodecs + OffscreenCanvas tarafı bu hızda
darboğaz değil. (Sonraki 34.5 fps okumaları hedefte Görev Yöneticisi açıkken
ve pencere yeniden boyutlanırken alındı; uzak oturumun kendisi de o an 33
gösteriyordu, yani sunucu daha az üretiyordu. Temiz ölçüm değiller.)

**47 ↔ 60 farkının sebebi hâlâ bilinmiyor.** İlk tahmin — yazılım H.264
encode'unun CPU tavanı — ölçümle **desteklenmedi**: CPU %6, GPU %14, video
motorları boşta. Sunucu kaynak sıkışmasında değil.

Toplam CPU'nun %6 olması tek çekirdek doygunluğunu elemiyor (16 thread'de bir
çekirdeğin tamamı ≈ %6), bu yüzden çekirdek bazında bakılması gerekiyor.

İkinci tahmin — hedefin Wi-Fi'da yalnızca ~2.5 Mbps göndermesi, yani encoder'ın
bit hızı sınırında olması — de **desteklenmedi**. RDP'de istemcinin bit hızı
söyleme yolu yok ama "ne kadar ağım var" diyebildiği bir alan var
(`ConnectionType`). `lan` ipucuyla ölçüm **46.9 – 47.0** çıktı, yani
ipucusuzken alınan 45.9 – 47.2 ile aynı. Ağ ipucu bu kurulumda bir kaldıraç
değil.

Geriye kalanlar, hiçbiri ölçülmedi:

- `DWMFRAMEINTERVAL=15` ondalık 15 → tavan ~66 fps. Daha küçük bir değer
  (ör. 10) tavanı yükseltir; 47'nin bu tavana mı yoksa DWM'in gerçek
  kompozisyon hızına mı dayandığı bilinmiyor.
- Hedefin kendi render hızı: TestUFO uzak oturumda `Refresh Rate 47 Hz`
  gösteriyor, yani Windows oturumu 47 Hz'de dönüyor ve biz onun ürettiği her
  kareyi taşıyoruz. Sınır oturumun kendisinde.
- Tek çekirdek doygunluğu (yukarıdaki uyarı).

## Ölçüm nasıl alınır

Köprü tarafı, 5 saniyede bir:

```bash
docker logs rdp-bridge 2>&1 | grep termix-rdp-bridge | tail -20
# [termix-rdp-bridge] 47.0 fps (235 frames in 5004ms)
# [termix-rdp-bridge] codec mix: avc444v2=1017 (chroma-only skipped=0)
```

Tarayıcı tarafı — DevTools konsolunda `📊 STATS` satırları
(`RdpDirectApp` → `onStats` → `statsLogger`). Köprü **sunucunun ürettiğini**,
tarayıcı **çizileni** sayar; ikisinin arası decoder'ın geride kalmasıdır.

## Hedef makine ayarları

İkisi de `gpedit.msc` → Computer Configuration → Administrative Templates →
Windows Components → Remote Desktop Services → Remote Desktop Session Host →
Remote Session Environment.

- `Prioritize H.264/AVC 444 graphics mode` → **Enabled**. Bu olmadan sunucu
  H.264'ü hiç kullanmıyor; 10.7 capset'i onaylansa bile ClearCodec ve
  progressive gönderiyordu.
- `Configure H.264/AVC hardware encoding` → **Not Configured**. Bu test
  makinesinde açıldığında oturum "Please wait" ekranında siyah kaldı ve
  **mstsc bile bağlanamadı**. Sunucu tarafı bir ayar olduğu için tüm
  istemcileri etkiliyor.

Kare hızı tavanı için registry:

```
HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations
  DWMFRAMEINTERVAL  (DWORD)  = 15 (ondalık)
```

Yeniden başlatma gerekiyor. Bu yalnızca tavanı belirler.

## Kalite / FPS / bitrate ne kadar ayarlanabilir

RDP GFX'te istemcinin bit hızı ya da hedef kare hızı söyleyeceği bir alan
**yok**. Encoder sunucuda ve parametrelerini Windows seçiyor — pass-through
mimarisinin doğrudan sonucu. Dolaylı kaldıraçlar, etkisi ölçülmüş hâliyle:

| Kaldıraç                   | Nerede               | Ölçülen etki                |
| -------------------------- | -------------------- | --------------------------- |
| Çözünürlük                 | Sekme boyutu         | Ölçülmedi, en büyük aday    |
| `ConnectionType`           | `BRIDGE_RDP_NETWORK` | **Yok** — 47 fps değişmedi  |
| `DWMFRAMEINTERVAL`         | Hedef registry       | 27 → 47 fps                 |
| `Prioritize H.264/AVC 444` | Hedef GPO            | H.264'ü hiç yoktan var etti |

Yani bugüne kadar işe yarayan iki ayarın **ikisi de hedef makinede**.

## 47 → 60 için sıradaki adımlar

Sırayla, çünkü her biri bir sonrakini gereksiz kılabilir:

1. **Çekirdek bazında CPU** — Görev Yöneticisi → CPU grafiğine sağ tık →
   _Change graph to_ → Logical processors. Tek çekirdek %100'de mi?
2. **Çözünürlüğü düşür** — sekmeyi küçültüp aynı ölçümü al. FPS yükseliyorsa
   sınır encode tarafında ve çözünürlükle ölçekleniyor demektir.
3. **`DWMFRAMEINTERVAL`'i 10 yap** — tavanı ~100 fps'e çıkarır. 47 tavana
   dayanıyorsa yükselir, dayanmıyorsa değişmez ve tavan elenir.

Ölçüm alırken hedefte Görev Yöneticisi kapalı olmalı: kendisi de encode edilen
içerik üretiyor ve rakamı düşürüyor.

## Eksikler

- Uçtan uca gecikme (fiziksel ölçüm)
- Sunucu ve köprü CPU kullanımı
- Bant genişliği
- LAN / WAN ayrımı
- Guacamole ile karşılaştırma → Faz 4
- 47 ↔ 60 farkının sebebi
