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

| Hedef ayarı                | Köprü FPS   | Tarayıcı FPS    | Codec dağılımı  |
| -------------------------- | ----------- | --------------- | --------------- |
| Varsayılan                 | 26.0 – 27.5 | ölçülmedi       | `avc444v2` %100 |
| `DWMFRAMEINTERVAL=15`      | 45.9 – 47.2 | 46.2            | `avc444v2` %100 |
| + `BRIDGE_RDP_NETWORK=lan` | 46.9 – 47.0 | ölçülmedi       | `avc444v2` %100 |
| **`DWMFRAMEINTERVAL=10`**  | 35.2 – 36.4 | **60.1 – 60.7** | `avc444v2` %100 |

`DWMFRAMEINTERVAL=10` ile hedefteki TestUFO `61 fps / 62 Hz` gösteriyor ve
tarayıcı 60.1 – 60.7 çiziyor; arada 42 – 49'a düşüyor. **60 FPS hedefine
ulaşıldı.**

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

**47 ↔ 60 farkı dört turda çözüldü.** Üç tahmin ölçümle elendi, dördüncüsü
tuttu. Sırayla:

İlk tahmin — yazılım H.264 encode'unun CPU tavanı — **desteklenmedi**: CPU %6,
GPU %14, video motorları boşta. Sunucu kaynak sıkışmasında değil.

Toplam CPU'nun %6 olması tek çekirdek doygunluğunu elemiyor (16 thread'de bir
çekirdeğin tamamı ≈ %6), bu yüzden çekirdek bazında bakılması gerekiyor.

İkinci tahmin — hedefin Wi-Fi'da yalnızca ~2.5 Mbps göndermesi, yani encoder'ın
bit hızı sınırında olması — de **desteklenmedi**. RDP'de istemcinin bit hızı
söyleme yolu yok ama "ne kadar ağım var" diyebildiği bir alan var
(`ConnectionType`). `lan` ipucuyla ölçüm **46.9 – 47.0** çıktı, yani
ipucusuzken alınan 45.9 – 47.2 ile aynı. Ağ ipucu bu kurulumda bir kaldıraç
değil.

Üçüncü tahmin — kare onaylarının hızı sınırlaması — de **desteklenmedi**.
Varsayılanda her kare ayrı ayrı onaylanıyor, yani sunucu her karede onayın
dönmesini bekliyor; 47 fps = kare başına 21.3 ms, bir Wi-Fi RTT'siyle çok
uyumlu bir sayı. `FreeRDP_GfxSuspendFrameAck` ile onaylar askıya alındığında
(`suspendack=yes` loglandı, ayar uygulandı) ölçüm **47.0** çıktı — hiç
değişmedi. Onaylar aynı zamanda geri basınç olduğu için varsayılan kapalı
bırakıldı; hiçbir şey kazandırmadan bir güvenlik ağını feda etmenin anlamı yok.

Bu tahmin, karşılaştırma ölçümündeki bir gözlemden doğmuştu: aynı hedef guacd
ile 28, köprüyle 47 fps üretiyordu, yani 47 hedefin sabit tavanı değil. Onaylar
elenince o gözlemin daha basit bir açıklaması kalıyor — guacd %85.9 CPU ile
kendi sınırındaydı, yani 28'i belirleyen guacd'nin kendisiydi.

**Cevap: `DWMFRAMEINTERVAL` tavanıydı.** Değer 15'ten 10'a indirilince ölçüm
47'den **60**'a çıktı, tarayıcı da 60.1 – 60.7 çizdi. Yani 47 bir kaynak
sınırı değil, hedefin kendine koyduğu bir tavandı — CPU'nun %6, GPU'nun %14'te
boşta durması da bununla tutarlıydı: sunucu yavaş değil, bekliyordu.

### Değerin anlamı — Microsoft ne diyor, ölçüm ne diyor

Microsoft'un [KB 2885213](https://learn.microsoft.com/en-us/troubleshoot/windows-server/remote/frame-rate-limited-to-30-fps)
belgesinde **yalnızca `15` değeri** tanımlı ve şöyle:

> The registry entry ... sets the maximum frame rate limit that the remote
> display protocol can deliver to the remote session client **to 60 FPS**.
> This setting **does not set the actual frame rate** for the remote session
> client. The actual frame rate ... depends on other factors such as
> application and computer hardware resources.

Yani belgelenen tek şey: `15` → tavan 60 FPS, ve bunun gerçek kare hızını
belirlemediği. **Milisaniye olduğu, `1000 / değer` formülü, ya da 15 dışında
herhangi bir değerin ne yaptığı Microsoft tarafından belgelenmiyor.**

Bu dokümanda daha önce `1000 / değer` üzerinden yapılan çıkarım
(15 → ~66 fps, 10 → ~100 fps) **kaynaksızdı ve ölçümle de tutmadı**:

| Değer | Belgelenen    | Ölçülen |
| ----- | ------------- | ------- |
| 15    | tavan 60      | 47      |
| 10    | belgelenmemiş | 60      |

Burada çözülmemiş bir çelişki var: `15` tavanı 60 yapıyorsa, 47 zaten tavanın
altındaydı ve değeri düşürmenin bir etkisi olmaması gerekirdi. Oldu. Bu, değerin
basit bir üst sınır olmadığını gösteriyor ama nasıl çalıştığını **bilmiyoruz**.
Üçüncü bir teori uydurulmuyor.

**Pratik sonuç:** bu makinede `10` ölçülerek `15`'ten iyi çıktı. Aradaki
değerler (14, 12 …) denenmedi ve sonucu tahmin edilemez.

### 60 sabit değil

Sonraki bir oturumda aynı ayarla 35 fps ölçüldü — üstelik çözünürlük daha
düşükken (1174x962, 60 fps ölçümü 1716x962'deydi). Yani daha az piksel, daha
az kare. Bu, sınırın piksel sayısında olmadığını gösteriyor ve Microsoft'un
"gerçek kare hızı uygulamaya ve donanıma bağlıdır" uyarısını doğruluyor:
hedefin o anki durumu (güç profili, termal, oturumda çalışan diğer şeyler)
sonucu belirliyor.

Bu yol hedefin ürettiğini taşıyor; hedef 60 üretirse 60, 35 üretirse 35.

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
  DWMFRAMEINTERVAL  (DWORD)  = 10 (ondalık)
```

Yeniden başlatma gerekiyor. Bu yalnızca tavanı belirler; gerçek hız hedefin
donanımına ve içeriğe bağlı kalır.

Microsoft yalnızca `15`'i belgeliyor (tavan 60 FPS). Bu makinede `15` → 47,
`10` → 60 ölçüldü, o yüzden **10** öneriliyor — ama `10` belgelenmemiş bir
değer ve etkisi ölçüme dayanıyor, garantiye değil.

## Kalite / FPS / bitrate ne kadar ayarlanabilir

RDP GFX'te istemcinin bit hızı ya da hedef kare hızı söyleyeceği bir alan
**yok**. Encoder sunucuda ve parametrelerini Windows seçiyor — pass-through
mimarisinin doğrudan sonucu. Dolaylı kaldıraçlar, etkisi ölçülmüş hâliyle:

| Kaldıraç                   | Nerede                   | Ölçülen etki                |
| -------------------------- | ------------------------ | --------------------------- |
| Çözünürlük                 | Sekme boyutu             | Ölçülmedi, en büyük aday    |
| `ConnectionType`           | `BRIDGE_RDP_NETWORK`     | **Yok** — 47 fps değişmedi  |
| Kare onayı askıya alma     | `BRIDGE_GFX_SUSPEND_ACK` | **Yok** — 47 fps değişmedi  |
| `DWMFRAMEINTERVAL`         | Hedef registry           | 27 → 47 → **60 fps**        |
| `Prioritize H.264/AVC 444` | Hedef GPO                | H.264'ü hiç yoktan var etti |

FreeRDP varsayılanları ölçüm sırasında loglandı: `connection=7`
(`CONNECTION_TYPE_AUTODETECT`), `autodetect=on`, `suspendack=no`.

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
- 60 fps'teki ara düşüşlerin (42 – 49) sebebi

---

## Piksel yolunun bant genişliği (H.264 politikası kapalı)

Windows "Prioritize H.264/AVC 444" olmadan karma çalışıyor: ekranın video
benzeri kısmını H.264 ile, geri kalanını ClearCodec ve progressive ile
çiziyor. İkincisini köprü decode ediyor ve piksel olarak gönderiyor — bu
yolun pahalı yarısı. Ölçümler aynı host'ta (Toshiba, 850x1338), her biri
yaklaşık bir dakikalık gerçek kullanım.

| Aşama                               |      Oran | Gönderilen |
| ----------------------------------- | --------: | ---------: |
| Ham RGBA (başlangıç)                |      1.0x |    ~580 MB |
| deflate level 1                     |      2.3x |    ~252 MB |
| WebP lossless                       |      4.1x |    ~141 MB |
| WebP, içeriğe göre kayıplı/kayıpsız | **14.2x** |  **41 MB** |

Son satırda 6618 bölgenin yalnızca **586'sı** (%8.9) resim sayılıp kayıplı
gitti — ama baytların ezici çoğunluğunu onlar taşıyordu. Metinde gözle görülür
bir bozulma raporlanmadı.

Sıkıştırma seçimi tahminle değil, gerçek bir oturumun 993 MB'lık bölge
dökümüyle yapıldı (`BRIDGE_DUMP_RECT`):

| Yöntem            | Oran  | Süre (bölge başına) |
| ----------------- | ----- | ------------------- |
| deflate level 1   | 2.5x  | 0.75 ms             |
| deflate level 6   | 2.7x  | 2.06 ms             |
| PNG               | 3.2x  | 4.32 ms             |
| WebP lossless m=0 | 4.3x  | 0.63 ms             |
| WebP lossy q=90   | 15.6x | 0.72 ms             |
| WebP lossy q=75   | 23.7x | 0.55 ms             |

WebP lossless bir takas değil: deflate'ten hem iyi sıkıştırıyor hem ucuz.
Sebebi kestiricilerinin resim için tasarlanmış olması; deflate metin olmayan
bir veride tekrar eden bayt dizileri arıyor.

### Kapanan soru: kodekleri tarayıcıda decode etmek

Fikir, ClearCodec ve progressive bitstream'lerini hiç açmadan tarayıcıya
geçirmek ve orada FreeRDP'nin decoder'larını WASM olarak çalıştırmaktı.
Kazancın üst sınırı, bu bitstream'lerin decode edilmeden önceki ağırlığı —
`codec mix` satırı artık onu da yazıyor.

Aynı oturumda:

```
clearcodec   2686 komut →  6.3 MB
progressive   892 komut → 26.5 MB
                          ────────
                           32.8 MB   bitstream
                           40.9 MB   şu an gönderdiğimiz piksel
```

Yani **1.25x.** WebP'den önce ölçüldüğünde 4.2x çıkıyordu ve o zaman bile
sınırdaydı; içeriğe göre kalite devreye girince kazanç ölçüm hatası
seviyesine indi.

FreeRDP'nin codec modülünü ve winpr'ın bir alt kümesini emscripten ile
derlemek, üstüne GFX yüzey modelini (cache slotları, SolidFill,
SurfaceToSurface, CacheToSurface) tarayıcıda yeniden kurmak ve bunu kalıcı
olarak bakmak — %25 için. **Yapılmayacak.** Ucuz olan çözüm pahalı olanı
gereksiz kıldı.
