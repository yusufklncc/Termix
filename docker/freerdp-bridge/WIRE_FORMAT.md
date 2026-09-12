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
| `CURS` | aşağıya bak                                                  | İmleç şekli                                 |
| `CURD` | boş                                                          | Varsayılan imlece dön                       |
| `CLIP` | UTF-8 metin                                                  | Pano — **çift yönlü**                       |
| `RECT` | aşağıya bak                                                  | Decode edilmiş ham bölge (H.264 olmayan)    |
| `WARN` | ASCII kod                                                    | Oturumu öldürmeyen uyarı                    |
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

### `CURS` payload'ı

```
u16 width
u16 height
u16 hotspotX
u16 hotspotY
BGRA piksel verisi   (width * height * 4 bayt)
```

`width` ve `height` sıfırsa imleç gizlenir; piksel verisi gelmez.

Uzak imleç videonun içine gömülmüyor, ayrı bir güncelleme olarak geliyor.
Çizilmezse masaüstünün "burada ne yapılabilir" bilgisini veren bütün şekiller
kaybolur: pencere kenarındaki boyutlandırma oku, metin I-beam'i, bekleme
imleci. Tıklamalar doğru yere gitmeye devam ettiği için bu, pencere
kenarlarının çalışmadığı izlenimi yaratır.

Tarayıcı bunu canvas'a sprite olarak değil **CSS `cursor`** olarak uyguluyor:
böylece imleç akışın değil farenin hızında hareket eder, kare hızı ne olursa
olsun tepkisel kalır.

## Neden `FACK`

RDP sunucusu GFX karelerini onaylanmasını bekler. Onay göndermezsek sunucu
akışı yavaşlatır. Tarayıcı decode ettiği kareyi onayladığında Termix bunu
köprüye geçirir, köprü de RDP sunucusuna `RDPGFX_FRAME_ACKNOWLEDGE` yollar.
Bu aynı zamanda doğal bir geri basınç mekanizması: tarayıcı yetişemezse
onaylar gecikir ve sunucu kendiliğinden yavaşlar.

## `CLIP` — pano

Tek mesaj, iki yön. Payload düz **UTF-8 metin**, sonlandırıcı yok.

- **Köprü → tarayıcı:** uzak tarafta bir şey kopyalandı.
- **Tarayıcı → köprü:** yerel panodaki metin. Köprü bunu saklar ve sunucuya
  yalnızca "metnim var" duyurusu yapar.

RDP pano içeriğini itmez. Kopyalayan taraf hangi formatlara sahip olduğunu
duyurur, karşı taraf **bir şey yapıştırıldığında** baytları ister. Yani her
yön iki tur:

```
uzakta kopyala   → ServerFormatList        → CF_UNICODETEXT iste
                 → ServerFormatDataResponse → CLIP (tarayıcıya)

tarayıcıda kopyala → CLIP (köprüye)         → CF_UNICODETEXT duyur
                   → ServerFormatDataRequest → metni yanıtla
```

`CF_UNICODETEXT` UTF-16'dır; dönüşüm köprüde yapılır, tarayıcı hep UTF-8 görür.

Üst sınır 2 MB. Dosya ve görsel **kapsam dışı** — onlar CLIPRDR'ın file
contents protokolünü gerektiriyor, daha büyük bir tampon değil.

Tarayıcı tarafında bir kısıt var: bir sayfa panoyu yalnızca odaktayken ve izinle
okuyabilir, ve "kullanıcı kopyaladı" diyen bir olay yok. Bu yüzden yerel pano
oturuma **tıklandığında** okunur — yapıştırmadan hemen önceki an. Firefox'ta
okuma atlanır; izin modeli sormak yerine hata veriyor. Mevcut guacd yolu da
aynı şeyi yapıyor.

## `RECT` — H.264 göndermeyen sunucular için

```
u16 surfaceId
u16 left, u16 top
u16 width, u16 height
RGBA piksel verisi   (width * height * 4 bayt)
```

## `PRNJ` — uzak masaüstünde yazdırılan belge

```
u32 jobId
u32 flag              0 = başlangıç, 1 = veri, 2 = bitiş
payload               başlangıçta dosya adı (UTF-8), veride PDF baytları,
                      bitişte boş
```

Parçalı, çünkü bir belge çoğu zaman tek bir wire çerçevesinden büyük. Tarayıcı
parçaları birleştiriyor ve yalnızca iş kapandığında kullanıcıya sunuyor: yarım
bir PDF daha küçük bir PDF değil, çapraz referans tablosu sonda olduğu için
hiçbir işe yaramaz.

FreeRDP yazdırmayı bir sürücü eklentisiyle yönlendiriyor ve kendi gönderdiği
eklenti işi CUPS'a veriyor — yani istemciyi çalıştıran makinedeki bir kuyruğa,
kâğıda bağlı. Bu bağlantının yanlış ucu: yazdır'a basan kişi bir tarayıcıda ve
geri istediği şey bir dosya. `libprinter-client-termix.so` tek bir yazıcı
duyuruyor ve işi kuyruğa değil köprüye veriyor.

Gelen şey **PostScript**, çünkü yazıcı Windows'a bir PostScript sürücüsünün
adıyla ("MS Publisher Imagesetter") duyuruluyor ve Windows konuştuğunu
sandığı şeye göre render ediyor. Aynı numarayı FreeRDP'nin kendi CUPS
backend'i de, ondan önce Guacamole da kullanıyor. Alternatifi XPS olurdu ve
onu bu tarafta okumak .NET gerektirirdi.

PostScript'i tarayıcıda açabilecek bir şey olmadığı için köprü işi toplayıp
kapanışta ghostscript'e veriyor. Toplayarak, çünkü dönüşümün ihtiyacı bu: PDF
sondan başa yazılıyor, yani iş bitmeden gönderilecek bir şey yok. ghostscript
ayrı bir süreç olarak çalıştırılıyor — kendi lisansı olan büyük bir program ve
oradaki bir çökme oturuma değil yalnızca o yazdırma işine mal olmalı.

Yazdırma `BRIDGE_PRINTER=1` ile açılıyor, varsayılan kapalı. Bu çekingenlik
değil: yazdırma `rdpdr` üzerinden gidiyor ve rdpdr bir oturum için isteğe bağlı
değil. Cihazı yüklenemezse FreeRDP post-connect'te düşüyor ve **tüm bağlantı**
onunla gidiyor — yani çalışmayan bir yazıcının bedeli yazıcı değil, kimsenin
ulaşamadığı bir masaüstü. Birden fazla Windows sürümünde doğrulanana kadar bu
risk her oturumun önünde değil bir anahtarın arkasında duruyor.

## `SNDA` — uzak ses

```
u32 sampleRate
u16 channels
u16 bitsPerSample     (her zaman 16)
PCM verisi            (imzalı little-endian)
```

Format her parçanın önünde. Sekiz bayta mal oluyor, karşılığında iki şey
veriyor: kaçırılabilecek ayrı bir duyuru olmadan kendini yapılandırabilen bir
tarayıcı, ve yıllar sonra hâlâ sesini nasıl çalacağını bilen bir kayıt.

FreeRDP uzak sesi bir cihaz eklentisiyle veriyor — alsa, pulse, oss — ve
hepsi bir ses kartı açıyor. Köprünün ses kartı yok ve olmasını da istemiyoruz:
ses birkaç sıçrama ötedeki tarayıcıya ait. O yüzden
`librdpsnd-client-termix.so` bir cihazın yaptığı her şeyi yapıyor, son adım
hariç — örnekleri donanıma değil köprüye veriyor.

Yalnızca 16 bit lineer PCM kabul ediliyor. FreeRDP'nin DSP'si ffmpeg ile
derlendiği için sunucunun AAC veya ADPCM önerdiği durumda dönüşüm zaten
girişte yapılıyor; sıkıştırılmış formatı anlıyormuş gibi yapmak, tarayıcıya
hiç haberdar edilmediği bir formatı çözdürmek olurdu.

`BRIDGE_AUDIO=0` kanalı hiç istemez.

## `RECW` — WebP'ye encode edilmiş `RECT`

Başlık `RECT` ile birebir aynı; farkı, başlığın ardındaki baytların bir WebP
dosyası olması. Tarayıcı onu `createImageBitmap` ile kendi çözüyor — bu yolun
tamamında piksel başına tek bir JavaScript işi kalmıyor, çözme de worker
thread'inin dışında oluyor.

Format seçimi ölçümle yapıldı. Gerçek bir oturumun bir dakikası, 993 MB bölge:

| Yöntem            | Oran | Süre (bölge başına) |
| ----------------- | ---- | ------------------- |
| deflate level 1   | 2.5x | 0.75 ms             |
| deflate level 6   | 2.7x | 2.06 ms             |
| PNG               | 3.2x | 4.32 ms             |
| WebP lossless m=0 | 4.3x | 0.63 ms             |

WebP lossless bir takas değil: hepsinden iyi sıkıştırıyor ve yerini aldığı
deflate'ten daha ucuz. Sebebi, kestiricilerinin resim için tasarlanmış olması;
deflate ise metin olmayan bir veride tekrar eden bayt dizileri arıyor.

Kayıplı/kayıpsız kararı bölge bazında ve içeriğe bakarak veriliyor. Metni lossy
encode etmek, bir uzak masaüstünü uzak masaüstü gibi gösteren şeyin ta kendisi —
ama masaüstünün çoğu metin değil, ve baytlar da metinde değil. Duvar kağıdı, bir
fotoğraf, sunucunun encode etmemeye karar verdiği bir video karesi: megabaytlar
oraya gidiyor ve lossy'nin kimsenin göremeyeceği tek yer de orası.

Ayırt edici sinyal, bir örneklemin kaç ayrı renk taşıdığı. Bir pencere, bir menü,
bir sayfa metin: birkaç düz dolgu artı kenarlarının yumuşatıldığı tonlar, yani
piksellerin küçük bir kısmı ayrı. Bir fotoğraf: neredeyse hepsi. Eşik bilerek
güvenli tarafa uzak — bir resme arayüz demek yalnızca bayta mal olur, metne resim
demek bu yolun taşımak için var olduğu şeye.

`BRIDGE_RECT_QUALITY` her bölgeyi zorla lossy yapar; `BRIDGE_RECT_LOSSLESS=1`
kararı tamamen kapatır.

WebP'nin reddettiği bölge, ham olarak `RECT` ile gidiyor. Yani iki magic'i de
beklemek gerekiyor.

Kanal sırası `CURS`'ten farklı ve bilerek öyle: `RECT` doğrudan bir `ImageData`
olarak sarılıyor, kopyalanmadan. Kanalları tarayıcıda çevirmek tam ekran bir
güncellemede dört milyon yazma demekti — hem de boyamayı da yapan worker'da.
Dönüşümü köprü, FreeRDP'nin optimize edilmiş dönüştürücüsüyle yapıyor.

Bir Windows host'u H.264'ü ancak "Prioritize H.264/AVC 444" politikası açıkken
sunuyor. Açık değilse masaüstünün tamamı ClearCodec ve progressive ile
çiziliyor; yalnızca H.264 taşıyan bir pass-through böyle bir oturumda **siyah
ekran** gösterir — üstelik bağlantı, girdi ve pano çalışıyorken.

Bu yüzden H.264 olmayan komutlar GDI'ye decode ettirilip decode edilmiş bölge
ham piksel olarak gönderiliyor. **Pahalı yol budur** — H.264 rotası tam da
bundan kaçınmak için var — dolayısıyla bir yedek, tasarım değil. H.264 GDI'ye
hiç uğramıyor.

Ham gönderiliyor, yeniden encode edilmiyor: sıkıştırmak guacd'nin tasarımı ve
guacd'nin maliyeti olurdu. Bunun yerine arayüz kullanıcıya politikayı açmasını
öneren kapatılabilir bir bildirim gösteriyor.

## `WARN` — ölümcül olmayan uyarı

Payload sabit bir ASCII kod. Arayüz bunu kullanıcının dilinde bir açıklamaya
çeviriyor ve kapatılabilir bir bildirim olarak gösteriyor; oturum çalışmaya
devam eder.

| Kod       | Anlamı                                            |
| --------- | ------------------------------------------------- |
| `no-h264` | Sunucu H.264 göndermiyor, `RECT` yedeğine düşüldü |
