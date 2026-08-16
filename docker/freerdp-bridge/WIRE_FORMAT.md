# Termix RDP bridge — wire format

Köprü ile Termix backend'i arasındaki ikili protokol. Termix bu çerçeveleri
çözmeden tarayıcıya aktarır; yani aynı format tarayıcıya kadar gider.

Bütün sayısal alanlar **little-endian**.

## Çerçeve

```
+--------+--------+-------------------+
| magic  | length | payload           |
| 4 byte | u32    | <length> byte     |
+--------+--------+-------------------+
```

`magic` 4 baytlık ASCII. `length` yalnızca payload'ı sayar, başlığı saymaz.

## Köprü → Termix → tarayıcı

| Magic  | Payload                                                      | Açıklama                                    |
| ------ | ------------------------------------------------------------ | ------------------------------------------- |
| `HELO` | `u32 width`, `u32 height`                                    | Oturum açıldı, masaüstü boyutu              |
| `SURF` | `u16 surfaceId`, `u16 width`, `u16 height`, `u8 pixelFormat` | Yüzey oluşturuldu                           |
| `DELS` | `u16 surfaceId`                                              | Yüzey silindi                               |
| `SMAP` | `u16 surfaceId`, `u32 originX`, `u32 originY`                | Yüzey çıktıya bağlandı                      |
| `FBEG` | `u32 frameId`                                                | Kare başlangıcı                             |
| `FEND` | `u32 frameId`                                                | Kare sonu — tarayıcı burada `FACK` gönderir |
| `AVCF` | aşağıya bak                                                  | **AVC420 H.264 karesi**                     |
| `ERRR` | UTF-8 metin                                                  | Hata                                        |
| `BYE ` | `u32 reason`                                                 | Oturum kapandı                              |

### `AVCF` payload'ı

```
u16 surfaceId
u16 left, u16 top, u16 right, u16 bottom     -- hedef bölge
u16 numRects
numRects × { u16 left, u16 top, u16 right, u16 bottom }   -- bu karenin güncellediği bölgeler
<kalan bayt>  -- dokunulmamış H.264 (AVC420) bitstream
```

H.264 verisi FreeRDP'nin `RDPGFX_AVC420_BITMAP_STREAM.data` alanından olduğu gibi
kopyalanır. Köprüde decode veya yeniden encode **yoktur** — Faz 3'ün bütün amacı bu.

## Tarayıcı → Termix → köprü

| Magic  | Payload                       | Açıklama                                                   |
| ------ | ----------------------------- | ---------------------------------------------------------- |
| `CONN` | UTF-8 JSON                    | Bağlantı isteği (yalnızca Termix gönderir, tarayıcı değil) |
| `KEYE` | `u16 flags`, `u16 code`       | Klavye — RDP scan code                                     |
| `UNIC` | `u16 flags`, `u16 code`       | Unicode klavye olayı                                       |
| `MOUS` | `u16 flags`, `u16 x`, `u16 y` | Fare                                                       |
| `EMOU` | `u16 flags`, `u16 x`, `u16 y` | Genişletilmiş fare (yan tuşlar)                            |
| `FACK` | `u32 frameId`                 | Kare onayı — akış kontrolü                                 |

### `CONN` JSON'u

```json
{
  "host": "10.0.0.5",
  "port": 3389,
  "username": "Administrator",
  "password": "...",
  "domain": "",
  "width": 1920,
  "height": 1080,
  "ignoreCert": true,
  "security": "any"
}
```

Kimlik bilgileri yalnızca Termix backend'inden köprüye gider; tarayıcı bunları
hiç görmez.

## Neden `FACK`

RDP sunucusu GFX karelerini onaylanmasını bekler. Onay göndermezsek sunucu
akışı yavaşlatır. Tarayıcı decode ettiği kareyi onayladığında Termix bunu
köprüye geçirir, köprü de RDP sunucusuna `RDPGFX_FRAME_ACKNOWLEDGE` yollar.
Bu aynı zamanda doğal bir geri basınç mekanizması: tarayıcı yetişemezse
onaylar gecikir ve sunucu kendiliğinden yavaşlar.
