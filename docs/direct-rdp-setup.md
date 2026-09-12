# Direct H.264 RDP — kurulum ve gereksinimler

Bu yol, RDP'nin H.264 akışını **sunucuda çözmeden** tarayıcıya geçirir. Guacamole
yolunun yerini almaz, yanında durur ve host bazında seçilir. Varsayılan her zaman
Guacamole.

Ölçülen fark (aynı hedef, aynı iş yükü):
[`phase4-comparison.md`](phase4-comparison.md) — **23× daha az sunucu CPU'su,
8.9× daha az bant genişliği, 1.6× kare hızı.**

---

## Hangi yolu seçmeli

| Durum                                                       | Yol           |
| ----------------------------------------------------------- | ------------- |
| Pano, ses, dosya aktarımı, oturum kaydı/paylaşımı gerekiyor | **Guacamole** |
| Yüksek kare hızı ve düşük sunucu maliyeti isteniyor         | **Direct**    |
| Hedef makinede ayar yapma imkânı yok                        | **Guacamole** |

Direct yolda **olanlar:** görüntü, klavye, fare, uzak imleç, sabit çözünürlük,
pano (metin, çift yönlü), ayrılmış tarayıcı kısayolları (Chromium'da).

Direct yolda **olmayanlar:** ses, dosya aktarımı (RDPDR), yazıcı, RemoteApp,
çoklu monitör, oturum kaydı, oturum paylaşımı. Ayrıntı ve
gerekçeler: [`phase3-direct-rdp-gaps.md`](phase3-direct-rdp-gaps.md).

---

## 1. Köprü konteyneri

Ubuntu'nun FreeRDP3 paketi H.264 **olmadan** derlenmiş, bu yüzden köprü imajı
FreeRDP'yi kaynaktan `-DWITH_FFMPEG=ON` ile derler. Yalnızca bu yolu kullanan
kurulumlar bu derleme maliyetini öder — guacd'nin bugün opsiyonel olması gibi.

```bash
docker build -t termix-rdp-bridge:dev docker/freerdp-bridge
docker run -d --name rdp-bridge -p 3390:3390 termix-rdp-bridge:dev
```

Termix köprüyü nasıl bulur, sırayla:

1. `rdp_bridge_url` ayarı (admin ayarları / `settings` tablosu)
2. `RDP_BRIDGE_URL` ortam değişkeni
3. Varsayılan `localhost:3390`

Ayrıntı: `src/backend/utils/rdp-bridge-config.ts`.

### Köprü ortam değişkenleri

Hiçbiri zorunlu değil; hepsi teşhis ve A/B içindir.

| Değişken                 | Varsayılan | Ne işe yarar                                                                                                 |
| ------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------ |
| `BRIDGE_PORT`            | `3390`     | Dinlenen port                                                                                                |
| `BRIDGE_GFX_AVC444`      | açık       | 10.x capset'lerini reklam eder. **Kapatma** — kapalıyken Windows 8.0 capset'ine düşer ve H.264 hiç göndermez |
| `BRIDGE_RDP_NETWORK`     | ayarlanmaz | `lan` / `broadband` / `wan` / `modem` / `auto`. Ölçümde kare hızını değiştirmedi                             |
| `BRIDGE_GFX_SUSPEND_ACK` | kapalı     | Kare onaylarını askıya alır. Ölçümde etkisi olmadı, geri basıncı kaybettirir                                 |
| `BRIDGE_GFX_MODE=gdi`    | kapalı     | FreeRDP'nin kendi pipeline'ı. Yalnızca hata ayıklama                                                         |
| `BRIDGE_DUMP_AVC`        | kapalı     | İletilen bitstream'i dosyaya yazar. Tarayıcı bir akışı reddettiğinde `ffprobe`'a sormak için                 |

---

## 2. Hedef makine (Windows)

Bu adımlar olmadan oturum **açılır ve görüntü gelir**, ama yolun var olma
sebebi ortadan kalkar: H.264 pass-through devre dışı kalır, decode köprüde
yapılır.

### Şart değil ama asıl mesele bu: H.264'ü aç

`gpedit.msc` → Computer Configuration → Administrative Templates → Windows
Components → Remote Desktop Services → Remote Desktop Session Host →
**Remote Session Environment**

- `Prioritize H.264/AVC 444 graphics mode` → **Enabled**

Bu olmadan Windows masaüstü ClearCodec ve progressive ile çizer. Oturum kurulur,
girdi çalışır, pano kanalı bağlanır — ama H.264 gelmez. Termix bu durumu fark
eder, köprüde decode edip ham piksel gönderir ve arayüzde kapatılabilir bir
bildirim çıkarır.

Fark ölçülebilir:

|                | Politika açık   | Politika kapalı         |
| -------------- | --------------- | ----------------------- |
| Taşınan veri   | H.264 bitstream | Ham piksel bölgeleri    |
| Sunucu CPU     | ~%4             | Belirgin şekilde yüksek |
| Bant genişliği | ~3 Mbps         | ~10 kat fazla           |
| Gecikme        | Düşük           | Gözle görülür           |

### Dokunma: donanım encode

- `Configure H.264/AVC hardware encoding` → **Not Configured** bırak

Test makinelerinden birinde açıldığında oturum "Please wait" ekranında siyah
kaldı ve **mstsc bile bağlanamadı.** Sunucu tarafı bir ayar olduğu için bütün
istemcileri etkiler. Denemek isterseniz makinenin fiziksel başındayken deneyin.

### Kare hızı tavanı

```
HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations
  DWMFRAMEINTERVAL  (DWORD)  = 10  (ondalık)
```

Yeniden başlatma gerekir. Microsoft yalnızca `15` değerini belgeliyor ve onun
için 60 FPS diyor; ölçümde `15` → 47 fps, `10` → 60 fps çıktı. Değerin
semantiği belgelenmemiş, `1000 / değer` formülü sonucu **öngörmüyor**.
Ayrıntı: [`phase3-measurements.md`](phase3-measurements.md).

---

## 3. Host ayarları

Host editörü → **RDP** sekmesi:

- **Render Engine** → `Direct H.264`
- **Display Settings → Width / Height** — sabit çözünürlük. Boş bırakılırsa
  sekmenin o anki boyutu kullanılır. Ölçüm alacaksanız sabitleyin: aksi hâlde
  iki ölçüm farklı çözünürlükte çalışır ve kıyaslanamaz.

Bu alanlar guacd yolunun da kullandığı alanlardır — bir host'un tek
çözünürlüğü vardır, hangi motorla açılırsa açılsın.

---

## 4. Tarayıcı

- **Chromium tabanlı** gerekir (Chrome, Edge). WebCodecs `VideoDecoder` şart.
- **Ayrılmış kısayollar** (`Ctrl+W`, `Alt+Tab`) yalnızca tam ekranda ve
  Keyboard Lock API'sini veren tarayıcıda yakalanır. Chrome verir; **Vivaldi
  API'yi gösterir ama kilidi reddeder**; Firefox ve Safari'de API yoktur.
  Yakalanamadığında arayüz bunu söyleyen kapatılabilir bir bildirim gösterir.
- **Pano** yerel panoyu okumak için odak ve izin gerektirir, ve "kullanıcı
  kopyaladı" diyen bir olay yoktur; bu yüzden oturuma tıklandığında okunur.
  Firefox'ta bu okuma atlanır (mevcut guacd yolu da öyle yapar).

### Decoder geri düşüşleri

Tarayıcı decoder'ı bir akışı sessizce reddedebilir — kareleri kabul edip boş
resim üretir. Termix bunu kareyi yüzey boyutuyla karşılaştırarak fark eder ve
sırayla:

1. Donanım decoder
2. Yazılım decoder (`prefer-software`)
3. Köprüde decode, ham piksel olarak gönderim

Her adım bir öncekinin başarısızlığı ölçüldükten sonra devreye girer; çalışan
bir oturumda hiçbiri çalışmaz. Üçüncü adım bildirimle duyurulur.

---

## Sorun giderme

Her şeyden önce köprü logu:

```bash
docker logs rdp-bridge 2>&1 | grep termix-rdp-bridge | tail -30
```

| Belirti                    | Logda                                             | Sebep                                                        |
| -------------------------- | ------------------------------------------------- | ------------------------------------------------------------ |
| Siyah ekran, oturum sağlam | `codec mix: clearcodec=… progressive=…`           | GPO açık değil                                               |
| Siyah ekran                | `caps confirmed: … avc420=no`                     | Capset 8.0'a düşmüş; `BRIDGE_GFX_AVC444` kapatılmış olabilir |
| Yeşil/bozuk görüntü        | Tarayıcı konsolunda `hardware decoder returned …` | Decoder akışı reddediyor, yazılıma geçilir                   |
| Yavaş ama doğru görüntü    | `browser cannot decode; decoding on this side`    | Köprüde decode ediliyor                                      |
| Oturum hiç açılmıyor       | `freerdp_connect failed: …`                       | Kimlik, ağ veya sertifika                                    |

Tarayıcı tarafı ölçüm: DevTools konsolunda `painted` ile filtreleyin.
`drops=` alanı karelerin neden çizilmediğini söyler.

---

## Bilinen sınırlar

- **Tek bir kurulumda doğrulandı sayılmaz.** İki Windows hedefinde test edildi
  ve ikincisi, birincisinde görünmeyen altı ayrı varsayımı açığa çıkardı. Üçüncü
  bir hedef muhtemelen yenilerini çıkaracaktır.
- Uçtan uca gecikme **ölçülmedi** — fiziksel ölçüm gerekiyor.
- Jump host tüneli yazıldı ama **gerçek bir jump host'la denenmedi**.
- Electron standalone modunda çalıştırılmadı.
