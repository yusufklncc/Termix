# Faz 9 — Yönetilen ağlar (arayüzden VPN)

**Durum: tasarım. Kod yazılmadı, onay bekliyor.**

Kullanıcı kararı: "Yol 3" — ayrı bir ağ yöneticisi yardımcı konteyner.

---

## Sorun

Bugün (Faz 8 A2) her ağ için compose'a bir servis ekleniyor. Yeni müşteri =
dosya düzenle, `docker compose up`. Çok müşterili kullanımda bu bir yönetim
yükü, ve VPN parolası compose dosyasında **düz metin** duruyor.

## Çözümün şekli

Compose'a **bir kez** bir servis eklenir: `termix-netmgr`. Sonra bir daha
dokunulmaz. Kullanıcı arayüzden profil ekler, yönetici o profil için bir ağ
isim alanı açar, içinde VPN istemcisini ve kapıyı çalıştırır.

Bu şekil forka yabancı değil: Termix zaten `termix-rdp-bridge` ile ağ üzerinden
konuşup ayrıcalıklı/native işi ona yaptırıyor. Yönetici aynı konumda durur.

### Neden Termix'in kendisinde değil

Termix konteyneri HTTPS servis ediyor ve dışarı açık. Ona `NET_ADMIN` +
`SYS_ADMIN` + `/dev/net/tun` vermek, bir web açığını ağ yöneticisi yetkisine
çevirir. Docker soketi vermek daha da kötü: o, host üzerinde root demek.
Ayrıcalık, dışarıya hiç açılmayan bir konteynerde kalmalı.

---

## Bağlantı yolunda hiçbir şey değişmiyor

Belirleyici tasarım kararı bu. Yönetilen bir profil de sonunda **bir adres**
üretir: yöneticinin IP'si ve o profile ayrılmış bir port. Yani
`gatewayHost`/`gatewayPort` alanları, kullanıcının elle yazması yerine
yönetici tarafından doldurulur.

Bunun sonucu: `resolveHostGateway`, tüneller, sahiplik kontrolü, kapalı düşme,
geçit yoklaması — **hepsi olduğu gibi kalır.** Faz 8'de kurulan tesisatın
tamamı yönetilen profiller için de çalışır. Eklenen tek şey "adresi kim
yazar" sorusunun cevabı.

## Veri modeli

`vpn_profiles.kind` zaten var ve `"declared"` varsayılanıyla duruyor; bu iş
için ayrılmıştı. Yönetilen profiller `kind = "managed"` olur ve şu sütunlar
eklenir (üç veritabanı için de migration):

| sütun                          | anlamı                                             |
| ------------------------------ | -------------------------------------------------- |
| `provider`                     | `fortinet` \| `wireguard` \| `openvpn` \| …        |
| `serverHost`, `serverPort`     | VPN geçidinin adresi                               |
| `authUsername`, `authPassword` | şifreli, mevcut alan şifreleme katmanından         |
| `trustedFingerprint`           | sabitlenen sertifika/anahtar özeti                 |
| `extraConfig`                  | sağlayıcıya özgü, şifreli (WireGuard anahtarı vb.) |
| `lastState`, `lastError`       | yöneticiden gelen son durum                        |

`declared` profiller hiç değişmez: `gatewayHost`/`gatewayPort` kullanıcının
yazdığı gibi kalır.

### Port ayırma

Yönetilen profilin kapısı `20000 + profileId`. Rastgele ayırıp Termix'e
bildirmek yerine hesaplanabilir olması, yönetici yeniden başladığında
eşitleme gerektirmemesi demek.

## Yöneticinin içi

Profil başına:

```
ip netns add tx-<id>
veth çifti: ana isim alanında tx<id>a, isim alanında tx<id>b
isim alanı içinde: VPN istemcisi (openconnect/wg/openvpn) + microsocks
ana isim alanında: 0.0.0.0:<20000+id> -> <netns-ip>:1080 iletici
```

Ayrı isim alanı şart, çünkü çakışan müşteri alt ağları bu işin baştan beri
belirleyici kısıtı. Faz 8'de sidecar başına bir konteynerle çözülmüştü; burada
konteyner başına bir isim alanıyla çözülür. Özellik korunur.

Tünel dışına çıkanı düşüren kural (Faz 8'de eklendi) her isim alanı içinde
ayrı ayrı uygulanır.

## Kontrol protokolü

`rdp-bridge` ile aynı çerçeveleme: 4 bayt ASCII sihirli sözcük, u32 LE
uzunluk, JSON gövde. Yönetici `RDP_BRIDGE_URL` ile aynı şekilde adreslenir
(`NET_MANAGER_URL`, ayar tablosunda da bir karşılığı).

| mesaj  | yön               | anlam                                      |
| ------ | ----------------- | ------------------------------------------ |
| `NUP ` | Termix → yönetici | profili ayağa kaldır (kimlik bilgileriyle) |
| `NDWN` | Termix → yönetici | profili indir                              |
| `NSTA` | Termix → yönetici | durum sor                                  |
| `NEVT` | yönetici → Termix | durum değişti (bağlandı/koptu/hata)        |

**Kimlik doğrulama ve gizlilik:** köprüden farklı olarak bu kanaldan
**parolalar geçiyor**. Paylaşılan bir sır (`NET_MANAGER_TOKEN`) zorunlu olmalı
ve token yoksa yönetici başlamamalı — Faz 8'deki `SOCKS_USER`/`SOCKS_PASSWORD`
kuralının aynısı: yarım yapılandırma, açık dinlemekten iyidir diye sessizce
geçilmemeli.

Token yalnızca kimlik doğrulama için değil, **gizlilik için de** kullanılır:
`NUP ` mesajındaki kimlik bilgisi alanları, token'dan HKDF ile türetilen bir
anahtarla AES-GCM ile mühürlenir. Böylece parola Docker ağında açık dolaşmaz.
Docker köprü ağı konteynerleri birbirinden ayırır ama aynı ağdaki `NET_RAW`
yetkili bir konteyner dinleyebilir; bu onu kapatır ve TLS sertifikası
yönetmekten ucuzdur.

**Diskte durmaz.** Yönetici kimlik bilgilerini yalnızca bellekte tutar, VPN
istemcisine standart girdiden verir, dosyaya yazmaz. Yeniden başlarsa Termix
`NUP ` ile tekrar gönderir — zaten yeniden eşitleme akışı bunu gerektiriyor.

**Neden hash değil:** bu parola Termix'in _doğrulayacağı_ bir şey değil,
geçide _sunacağı_ bir şey. Kullanıcı giriş parolaları bcrypt ile hashleniyor
çünkü orada soru "yazdığın doğru mu"; burada soru "FortiGate'e ne söyleyeyim".
Hash geri döndürülemez, dolayısıyla bu iş için kullanılamaz. Yapılabilecek olan
— ve yapılan — şifrelemek: kullanıcının anahtarı altında, mevcut alan şifreleme
katmanıyla.

## Yaşam döngüsü

- **Profil oluşturma/güncelleme:** Termix `NUP ` yollar, yönetici bağlanır,
  sonucu döner. Bağlanamazsa profil kaydedilir ama **hata durumuyla**; host'lar
  ona atanabilir, bağlanmaya çalışınca mevcut kapalı düşme devreye girer.
- **Profil silme:** `NDWN`. Kullanımdaki profilin silinmesi zaten reddediliyor.
- **Yönetici yeniden başlarsa:** Termix açılışta ve periyodik olarak `NSTA`
  sorar, eksikleri `NUP ` ile geri kurar.
- **Tünel koparsa:** yönetici yeniden bağlanmayı dener, `NEVT` ile bildirir.
  Bu sırada o profildeki oturumlar kopar — Faz 8'de de öyleydi.
- **Arayüz:** profil listesinde durum rozeti (bağlı / bağlanıyor / hata +
  sebep). Bugün böyle bir gösterge hiç yok.

## Kapsam dışı (bu fazda yapılmayacak)

- **İnteraktif kimlik doğrulama** (OTP, SAML). Bağlantı ortasında kullanıcıya
  soru sormayı gerektirir; ayrı bir faz. Tasarımın önünü kapatmıyor ama şimdi
  yapılmıyor. Sende Fortinet'te zorlama yok, o yüzden bugün gerekmiyor.
- **Profil paylaşımı.** Profiller kullanıcıya ait kalır.
- **Yöneticinin çoklu makineye dağıtılması.**

## Riskler

1. **Ayrıcalıklı konteyner.** Yönetici `NET_ADMIN`, `SYS_ADMIN`, `/dev/net/tun`
   ister. Dışarı açılmaz ama host çekirdeğine dokunur. LXC altında çalışacaksa
   Faz 8'de yaşadığımız cihaz geçirme meselesi burada da geçerli.
2. **Kimlik bilgileri tel üzerinde.** Termix'te şifreli duruyorlar ve
   yöneticiye token'dan türetilen anahtarla mühürlenerek gidiyorlar. Kalan
   risk: yönetici konteynerinin belleği. Orada açık olmak zorundalar, çünkü
   VPN istemcisine verilecekler.
3. **Kaynak.** Her profil bir süreç çifti ve bir isim alanı. On müşteri = on
   tünel, sürekli açık. Bugünkü sidecar modelinde de böyleydi, ama arayüzden
   eklemek kolaylaştığı için sayı artar.
4. **Sağlayıcı çeşitliliği.** Her VPN istemcisinin kendi arızası var
   (Fortinet'te sertifika zinciri, WireGuard'da anahtar formatı). Birden fazla
   sağlayıcıyı aynı anda doğru yapmak, bir tanesini yapmaktan çok daha fazla iş.
5. **Faz 8 bozulmamalı.** `declared` profiller ve sidecar yolu aynen çalışmaya
   devam etmeli; yönetilen yol yanına eklenir.

## Önerilen sıra

1. **Yönetici imajı + kontrol protokolü**, tek sağlayıcıyla: Fortinet
   (`openconnect`), çünkü gerçek donanımda doğrulanabilir tek sağlayıcı o.
2. **Şema + API + arayüz**: profil tipi seçimi, sağlayıcı alanları, durum rozeti.
3. **Yaşam döngüsü ve yeniden eşitleme.**
4. **İkinci sağlayıcı** (WireGuard), birincisi gerçek kullanımda oturduktan sonra.

Her adımın sonunda durulur ve onay beklenir.

## Cevaplanması gereken sorular

1. Yönetici konteynerine ayrıcalık vermek kabul mü? (Alternatifi yok; Yol 1 ve
   Yol 2 daha kötü yerlere koyuyor.)
2. İlk sağlayıcı Fortinet olsun mu, yoksa WireGuard mı? Önerim Fortinet,
   çünkü doğrulayabildiğimiz tek gerçek geçit o.
3. Mevcut `declared` profilin yönetilene dönüştürülmesi gerekiyor mu, yoksa
   yan yana yaşasınlar mı? Önerim yan yana.

### Cevaplar (2026-09-27)

Üçüne de evet: ayrıcalıklı yönetici kabul, ilk sağlayıcı Fortinet, mevcut
`declared` profil yerinde kalır.
