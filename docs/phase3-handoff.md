# Faz 3 — devir notu

Bu dosya, konuşma bağlamı sıkıştırıldıktan sonra kaldığımız yerden devam etmek
için yazıldı. Faz 0–2 tamamlandı; ayrıntıları `todo.md` ve diğer `docs/`
dosyalarında.

---

## Nerede kaldık

Direct RDP yolu (guacd'siz, FreeRDP + WebCodecs) yazıldı ve **bağlantı kuruluyor**.
Takıldığımız nokta: sunucu grafik göndermeye başlamıyor.

Son köprü logu:

```
connecting to 10.10.30.104:3389 as 'yusuf' domain '' 2194x1250
post_connect sent HELO 2194x1250
connected to 10.10.30.104
graphics pipeline attached (gdi bookkeeping + avc420 passthrough)
reset graphics 2194x1250
```

**Eksik olan tek satır:** `first surface command: codecId=...`

`session loop ended` satırı artık **yok** — yani oturum ayakta kalıyor, transport
ölmüyor. Bu, bir önceki hatanın (aşağıya bak) çözüldüğünü gösteriyor.

---

## Çözülmüş hatalar (tekrar aramaya gerek yok)

| Hata                                               | Sebep                                                                                                                                                                     | Commit    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| Sekme açınca tüm Termix arayüzü kararıyordu        | Bir canvas worker'a yalnızca bir kez aktarılabilir; React aynı elemanı geri veriyor, StrictMode efekti iki kez çalıştırıyor → `InvalidStateError` React ağacını söküyordu | `d48a17f` |
| Her oturum `ERRCONNECT_PRE_CONNECT_FAILED`         | `PubSub_Subscribe*` `int` döner ve başarısızlığı **negatif** değerle bildirir; boolean gibi test etmek başarıyı hata sayıyordu                                            | `8e6d1a7` |
| `ERRCONNECT_CONNECT_TRANSPORT_FAILED`, ~2 sn sonra | **Kendi gfx callback setimi kurmak.** GDI'nin yaptığı bookkeeping'e kanal bağımlı                                                                                         | `51151fb` |

### Son düzeltmenin mimarisi (önemli)

`gdi_graphics_pipeline_init` kanalı kurar, biz **yalnızca `SurfaceCommand`'ı**
geri alırız. `DeactivateClientDecoding=TRUE` zaten GDI'nin `SurfaceCommand`'ını
NULL bıraktığı için çakışma yok ve kütüphane hiçbir şeyi decode etmiyor.
Kare callback'leri **zincirleniyor**: bizimki wire mesajını yollar, sonra
GDI'nınkine devreder. `gfx->custom` GDI'nin, biz `g_session` dosya statiğini
kullanıyoruz (süreç başına tek oturum, güvenli).

---

## Yapılmış ama sonuç vermemiş tahminler (TEKRARLAMA)

Bunlar denendi ve **sorunu çözmedi**. Kodda kalanları zararsız/doğru oldukları
için bırakıldı:

1. **`gdi_init` + `DeactivateClientDecoding` eklemek** — doğru ve gerekli, ama
   transport ölümünü çözen bu değildi. Kodda kalmalı.
2. **Masaüstü boyutunu çift sayıya yuvarlamak** — RDP çift boyut ister, doğru bir
   savunma, ama sebep bu değildi. Kodda kalmalı.
3. **Olay döngüsünü değiştirmek** — FreeRDP'nin kendi örneğiyle zaten aynıydı.
4. **Codec pazarlaması (caps 8/8.1, AVC420-only)** — beklendiği gibi çalışıyor.

**Ders:** dört tur boyunca kaynak kodu okumadan tahmin yürüttüm. Sorunu çözen şey
`BRIDGE_GFX_MODE=gdi` A/B deneyi oldu — hangi yarıda olduğumuzu kesin söyledi.
Sıradaki adımda da önce deney/log, sonra teori.

---

## Sıradaki adım

Sunucu `ResetGraphics` gönderiyor ama sonrasında `CreateSurface` /
`SurfaceCommand` gelmiyor. Bakılacak yerler, bu sırayla:

1. **Köprünün ne kadar hayatta kaldığını doğrula.** `idle 5s, frames=0` satırları
   akıyor mu? Akıyorsa oturum sağlam, sunucu sessiz. Akmıyorsa süreç ölüyor.
2. **FreeRDP verbose logu aç:** konteyneri `-e WLOG_LEVEL=DEBUG` ile başlat,
   `com.freerdp.channels.rdpgfx` satırlarına bak. Sunucudan gelen PDU'lar
   görünecek.
3. **`BRIDGE_GFX_MODE=gdi` ile karşılaştır.** O modda `gdi_CreateSurface`
   çağrılıyor mu? Çağrılıyorsa fark hâlâ bizim tarafta; çağrılmıyorsa sunucu
   gerçekten göndermiyor demektir ve sebep Windows tarafında (GPO, GFX ayarı).
4. Sunucu gerçekten göndermiyorsa: Windows'ta **"Prioritize H.264/AVC 444"**
   GPO'su ve donanım encode ayarı kontrol edilmeli. Hedef makinede
   `DWMFRAMEINTERVAL` ve GPO'nun yapıldığı söylendi ama AVC420-only istediğimiz
   için sunucunun bizim caps'imize ne cevap verdiğine bakmak gerekiyor.

---

## Test ortamı

```bash
# Köprü (WSL2'de Docker)
docker build -t termix-rdp-bridge:dev docker/freerdp-bridge
docker run -d --name rdp-bridge -p 3390:3390 termix-rdp-bridge:dev
docker logs rdp-bridge 2>&1 | grep termix-rdp-bridge | tail -20

# A/B modu (GDI kendi pipeline'ını kullanır, ekran siyah kalır)
docker run -d --name rdp-bridge -p 3390:3390 -e BRIDGE_GFX_MODE=gdi termix-rdp-bridge:dev

# Termix
npm run dev:backend      # API 30001, direct RDP gateway 30014
npm run dev              # http://localhost:5173
```

- **Hedef:** `10.10.30.104:3389`, kullanıcı `yusuf`, Windows laptop, ekran 1920x1200 60 Hz
- **Host adı Termix'te:** "HUAWEI RDP", host id 2
- Host editöründe **RDP sekmesi → Render Engine → Direct H.264** seçili olmalı
- Kimlik bilgileri host'un RDP sekmesinde (General'daki `root` kullanıcı adı değil)

### Kendi başına test etmek için (kimlik gerekmez)

`/tmp/.../scratchpad/bridge-probe.mjs` köprüye `CONN` çerçevesi yollar. Sahte
kimlikle `ERRCONNECT_LOGON_FAILURE` dönmesi, TCP+TLS+NLA yolunun sağlam
olduğunu doğrular.

---

## Kod haritası

| Ne                    | Nerede                                                                            |
| --------------------- | --------------------------------------------------------------------------------- |
| C köprüsü             | `docker/freerdp-bridge/bridge.c`                                                  |
| Sidecar imajı         | `docker/freerdp-bridge/Dockerfile` (FreeRDP 3.17.1 kaynaktan, `-DWITH_FFMPEG=ON`) |
| Wire format           | `docker/freerdp-bridge/WIRE_FORMAT.md`                                            |
| Termix gateway        | `src/backend/hosts/rdp-direct/index.ts` (port 30014)                              |
| Köprü adresi çözümü   | `src/backend/utils/rdp-bridge-config.ts` (`RDP_BRIDGE_URL`)                       |
| Tarayıcı istemcisi    | `src/ui/features/rdp-direct/rdp-direct-client.ts`                                 |
| Decoder worker        | `src/ui/features/rdp-direct/rdp-decoder.worker.ts`                                |
| Wire ayrıştırıcı      | `src/ui/features/rdp-direct/rdp-wire.ts` (+ testleri)                             |
| RDP scan code         | `src/ui/features/rdp-direct/rdp-scancode.ts` (+ testleri)                         |
| Bileşen               | `src/ui/features/rdp-direct/RdpDirectApp.tsx`                                     |
| Tab dallanması        | `src/ui/shell/tabUtils.tsx`, `host.rdpRenderEngine === "direct"`                  |
| Şema kolonu           | `rdp_render_engine`, null/`"guacamole"` = mevcut davranış                         |
| Eksik özellik listesi | `docs/phase3-direct-rdp-gaps.md`                                                  |

---

## Hâlâ doğrulanmamış olanlar

Bağlantı kurulduğu için artık test edilebilir hale gelecek olanlar — ama **hiçbiri
henüz gerçek veriyle sınanmadı**:

- AVC420'nin gerçekten pazarlık edildiği (`codecId=3` görülmedi)
- Decode yolu (WebCodecs `avc1.42E01E` profil dizesi doğru mu)
- Rect'lerin picture içindeki konum yorumu — kısmi güncellemelerde yanlış yere
  çizebilir
- Klavye/fare (scan code tablosu birim testli ama uçtan uca denenmedi)
- Ölçüm: FPS, gecikme, sunucu CPU — hiçbiri alınmadı

Jump host tüneli bu yola bağlanmadı.

---

## Kalite durumu

`npm run lint` exit 0 · 209 test dosyası / 1535 test geçiyor · prettier + biome
temiz · `tsc --build` baseline 317, şu an +2 (ikisi de repoda mevcut desenler:
`@/types` importu ve `import.meta.env`).

Tüm iş `feat/stream-protocol` dalında, conventional commit'ler hâlinde.
Push yapılmadı.
