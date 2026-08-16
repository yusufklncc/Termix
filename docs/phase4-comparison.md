# Faz 4 — Guacamole ile direct H.264 karşılaştırması

Aynı hedef, aynı iş yükü, aynı tarayıcı, arka arkaya iki oturum.

## Kurulum

|         |                                                                         |
| ------- | ----------------------------------------------------------------------- |
| Hedef   | Windows 11 laptop, `10.10.30.104:3389`, Wi-Fi                           |
| İş yükü | TestUFO (sürekli hareket — en kötü durum)                               |
| guacd   | `guacamole/guacd:1.6.0`, Docker, `localhost:4822`                       |
| Köprü   | `termix-rdp-bridge:dev`, FreeRDP 3.17.1, Docker                         |
| Ölçüm   | Tarayıcı: `📊 STATS` satırları · Konteyner: `docker stats`, 2 sn aralık |

İki konteyner de ölçümden hemen önce yeniden başlatıldı, yani ağ sayaçları
sıfırdan. Her konteyner yalnızca kendi oturumunda çalıştı.

## Sonuçlar

|                      | Guacamole (guacd)    | Direct H.264        | Fark     |
| -------------------- | -------------------- | ------------------- | -------- |
| **Kare hızı**        | 26.0 – 29.9 fps      | **46.8 – 47.2 fps** | 1.6×     |
| Kararlılık           | ±2 fps               | ±0.4 fps            | —        |
| **Sunucu CPU**       | %85.9 (75.6 – 105.5) | **%3.74**           | **23×**  |
| **Tarayıcıya giden** | 26.9 Mbps            | **3.03 Mbps**       | **8.9×** |
| Kare başına          | 123 KB               | **8.2 KB**          | 15×      |
| Hedeften gelen       | 3.16 Mbps            | 3.08 Mbps           | ~aynı    |

### Okunuşu

**Girdi aynı, çıktı değil.** İki yol da hedeften neredeyse birebir aynı veriyi
alıyor (3.16 vs 3.08 Mbps). Yani fark hedefte değil, gelen veriyle ne
yapıldığında. guacd onu çözüp resim karoları olarak yeniden encode ediyor ve
tarayıcıya **9 katı** veri gönderiyor; köprü aynı bitstream'i olduğu gibi
geçiriyor.

**CPU farkı 23×** ve sebebi doğrudan bu. guacd bir çekirdeği neredeyse tamamen
dolduruyor (tepe %105.5, yani tek çekirdeği aşıyor); köprü %3.74'te kalıyor ve
o da çoğunlukla bellek kopyalama. CLAUDE.md'nin "1080p60 bu mimaride CPU'da
patlıyor" teşhisi ölçümle doğrulandı — ve bu daha 1682x962 @ 47fps.

**Kare hızı farkının sebebi de CPU.** guacd aynı girdiden daha az kare
üretebiliyor çünkü encode hattı yetişemiyor. Kararlılık farkı da buradan:
resim karosu encode etmenin maliyeti sahnenin karmaşıklığına bağlı, bu yüzden
guacd ±2 fps oynuyor; pass-through sunucunun ürettiğini taşıdığı için ±0.4'te
duruyor.

**guacd beklenenden iyi.** 10–15 fps tahmin edilmişti, 28 veriyor. Tablo
"guacd kullanılamaz" demiyor — "direct belirgin şekilde daha hızlı, çok daha
ucuz ve daha tutarlı" diyor.

## Neden üç yollu değil

CLAUDE.md üç yolun karşılaştırılmasını istiyor. `stream` (WebRTC) yolu bu
tabloya **giremez**: bir Windows RDP host'una bağlanamaz, harici bir WebRTC
yayıncısı (neko, Selkies) gerektirir. Aynı hedefte üç yolu birden ölçmek
mümkün değil.

O yolun kendi ölçümü Faz 2'de alındı ve ayrı duruyor
(`docs/stream-webrtc-measurement.md`): neko'ya karşı 1080p60, Termix
backend'i %0.30 CPU — medya Termix üzerinden hiç geçmediği için.

## Ölçülmeyenler

- **Uçtan uca gecikme.** Fiziksel ölçüm gerekiyor (hedefte ve ekranda aynı anda
  görünen bir sayaç, yüksek hızlı kamera veya foto). Kare hızından türetilemez.
- Tek çalıştırma, tek hedef, tek iş yükü. Tekrar edilmedi.
- guacd tarafında codec ayarları (`guacamoleConfig`'teki ~40 seçenek)
  varsayılanda bırakıldı; kalite/hız takasları denenmedi.
- Görüntü kalitesi karşılaştırılmadı. Direct yol AVC444'ün luma akışını
  taşıdığı için 4:2:0; guacd karo bazlı kayıplı encode kullanıyor. İkisi farklı
  cinsten bozulma üretiyor ve göz kararı kıyaslanmadı.

## Tekrar etmek için

```bash
docker restart guacd rdp-bridge          # sayaçları sıfırla
docker stats --format '{{.Name}} {{.CPUPerc}} {{.NetIO}}' guacd rdp-bridge
```

Aynı pencere boyutunda önce bir host'u, sonra diğerini aç. Pencere boyutu
değişirse çözünürlük değişir ve karşılaştırma bozulur. Tarayıcı konsolunu
`painted` ile filtrele.

İlk ~13 saniye her iki yolda da ısınma; ortalamaya katılmadı.
