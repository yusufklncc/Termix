# Faz 10 — İkinci sağlayıcı: Tailscale

**Durum: tasarım. Kod yazılmadı, onay bekliyor.**

Amaç: dışarı hiç açılmayan, yalnızca bir mesh ağından (Tailscale/Headscale)
erişilebilen makinelere Termix'ten bağlanabilmek — sunucunun tamamını o ağa
sokmadan, yalnızca o profildeki host'lar için. Faz 8'deki gerekçenin aynısı.

---

## Neden Fortinet'ten kolay

`tailscaled` iki şeyi hazır veriyor (doğrulandı, `--help` çıktısı):

- `--tun=userspace-networking` — çekirdek TUN aygıtına hiç dokunmaz, kendi
  kullanıcı-alanı ağ yığınını kurar.
- `--socks5-server=<adres>` — o yığının önüne doğrudan bir SOCKS5 kapısı koyar.

Yani bizim microsocks'la elle kurduğumuz kapı gömülü geliyor. Sonuçları:

1. **Ağ isim alanı gerekmiyor.** Çekirdek yönlendirmesi değişmediği için iki
   farklı tailnet birbirine karışamaz — her biri kendi yığınında.
2. **`/dev/net/tun` gerekmiyor**, `NET_ADMIN`/`SYS_ADMIN` de gerekmiyor
   (yalnızca bu sağlayıcı için).
3. **İnteraktif kimlik doğrulama yok**: bir auth key yeter.

---

## Sağlayıcı sözleşmesinin değişmesi

Bugün `buildProviderCommand` şunu döndürüyor: `{ command, args, iface, stdin }`
ve `raiseTunnel` sabit bir sıra uyguluyor — isim alanı aç, süreci başlat,
`iface` belirene kadar bekle, sıkı kuralları uygula, microsocks başlat, kapının
cevap vermesini bekle.

Tailscale bu sıraya oturmuyor: beklenecek bir arayüz yok ve kapıyı kendisi
açıyor. Sözleşmeyi sağlayıcının kendi adımlarını tarif edebileceği hâle
getirmek gerekiyor:

```
{
  needsNamespace: boolean,      // Tailscale: false, Fortinet: true
  command, args, stdin,
  ready(),                      // "hazır mı" sorusunun sağlayıcıya özgü cevabı
  upstream: { host, port },     // kapının bağlanacağı yer
  strictRoutes: boolean,        // isim alanı yoksa anlamsız
}
```

`raiseTunnel` bu adımları çağıran hâline gelir. Fortinet'in bugünkü davranışı
birebir korunur — bu bir soyutlama alıştırması değil, ikinci sağlayıcıyı
eklemenin bedeli.

### Tailscale'in adımları

```
tailscaled --tun=userspace-networking \
           --socks5-server=127.0.0.1:<30000+id> \
           --state=mem: \
           --socket=/run/tailscale-<id>.sock
tailscale --socket=... up --authkey=<key> --hostname=termix-<id> [--login-server=<url>]
```

- **`ready()`**: `tailscale status` "Running" diyene kadar bekle.
- **`upstream`**: `127.0.0.1:<30000+id>` — tailscaled'in kendi SOCKS'u.
- **`--state=mem:`**: düğüm kalıcı değil. Talep üzerine kalkıp indiği için her
  kalkışta yeni bir düğüm olur; **ephemeral auth key** ile eşleşir, Tailscale
  çevrimdışı düğümü kendisi temizler. Kalıcı state tutmak, inip kalkan bir
  düğümün tailnet'te birikmesi demek olurdu.

---

## Veri modeli

Yeni sütun yok. Mevcut alanlar sağlayıcıya göre anlam kazanır:

| alan                 | Fortinet                 | Tailscale                          |
| -------------------- | ------------------------ | ---------------------------------- |
| `provider`           | `fortinet`               | `tailscale`                        |
| `serverHost`         | geçidin adresi (zorunlu) | Headscale login server (opsiyonel) |
| `serverPort`         | 443                      | kullanılmaz                        |
| `authUsername`       | VPN hesabı (zorunlu)     | kullanılmaz                        |
| `authPassword`       | parola (şifreli)         | **auth key** (şifreli)             |
| `trustedFingerprint` | sertifika pini           | kullanılmaz                        |

Doğrulama bugün Fortinet'e göre yazılmış — `serverHost` ve `authUsername`
zorunlu. Bu **sağlayıcıya göre** ayrılmalı, yoksa Tailscale profili
kaydedilemez.

---

## Arayüz

Form sağlayıcıya göre değişir:

- **Fortinet:** geçit adresi, port, kullanıcı, parola, pin.
- **Tailscale:** auth key, opsiyonel login server, opsiyonel hostname.

Sağlayıcı seçimi yalnızca **oluştururken** yapılır; tip gibi, sonradan
değişmez — alanları ve tüneli tutan şey farklı.

---

## Talep üzerine kaldırmayla ilişkisi

Değişmiyor. Kapı kayıtlı olduğu sürece dinler, ilk bağlantı `tailscaled`'i
başlatır, son oturumdan sonra iner. Reddedilen kimlik bilgisi kuralı da aynen
geçerli: geçersiz bir auth key her bağlantıda tekrar denenmemeli.

Bir farkla: Tailscale'in kalkması Fortinet'ten yavaş olabilir (düğüm kaydı,
DERP seçimi). Ölçüp yazacağım; gerekirse o sağlayıcı için boşta bekleme süresi
daha uzun tutulur.

---

## Doğrulanacaklar (iddia etmiyorum, ölçeceğim)

1. **Tailscale SOCKS'u tailnet dışına çıkar mı?** Çıkmıyorsa "tünel dışına
   çıkanı düşür" kuralı bu sağlayıcıda bedavaya gelir. Çıkıyorsa kural için
   ayrı bir cevap gerekir.
2. **İsim çözümlemesi.** SOCKS'un MagicDNS adlarını çözdüğünü umuyorum — öyleyse
   Tailscale profillerinde host'a IP yerine ad yazılabilir, ki Fortinet'te
   yazamıyoruz.
3. **Kalkış süresi.**
4. **Ephemeral düğümlerin gerçekten temizlendiği.**

---

## Riskler

1. **Sözleşme değişikliği Fortinet'i bozabilir.** Bugün çalışan tek sağlayıcı
   o. Değişiklikten sonra gerçek geçide karşı yeniden doğrulanmalı.
2. **Auth key sızması.** Şifreli saklanıyor ve yöneticiye mühürlü gidiyor, ama
   yöneticinin belleğinde açık duruyor — parolada olduğu gibi.
3. **`--state=mem:` her kalkışta yeni düğüm.** Ephemeral olmayan bir anahtarla
   kullanılırsa tailnet'te ölü düğüm birikir. Arayüzde bunu söylemek gerekir.
4. **Netbird bu tasarıma dahil değil.** Onun userspace/SOCKS karşılığı yok;
   Fortinet kalıbıyla (isim alanı + microsocks) ayrıca eklenir.

---

## Sıra

1. Sağlayıcı sözleşmesini genişlet, **Fortinet'i birebir koru**, gerçek geçide
   karşı doğrula.
2. Tailscale sağlayıcısını ekle; yukarıdaki dört şeyi ölç.
3. Doğrulamayı sağlayıcıya göre ayır; API ve arayüz alanları.
4. Gerçek bir tailnet'e karşı uçtan uca deneme — bu adım sende.

---

## Ölçülenler

Kimlik doğrulama gerektirmeyen ne varsa ölçüldü; gerisi gerçek bir tailnet
anahtarı istiyor.

| Ne                  | Sonuç                                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ayrıcalıksız kalkış | `NET_ADMIN`, `SYS_ADMIN` ve `/dev/net/tun` olmadan kaydoldu: `{ ok: true, state: 'idle', port: 20003 }`. Tasarımın dayandığı iddia bu, doğrulandı. |
| Geçersiz anahtar    | İlk bağlantı `refused`, ikinci bağlantı **1 ms**'de — kontrol sunucusuna hiç gidilmiyor. Fortinet için ölçülen davranışın aynısı.                  |
| Anahtarın sızmaması | Hata metni `--authkey=***` diyor; anahtar veritabanına da ekrana da geçmiyor.                                                                      |
| Fortinet gerilemesi | Sözleşme değişikliğinden sonra gerçek geçide karşı yeniden ölçüldü: kayıt `idle`, ilk bağlantı 4374 ms, yanlış parola `refused`.                   |

Gerçek anahtar isteyen, açık kalan dört şey:

1. **SOCKS tailnet dışına çıkıyor mu** — yani bir exit node olmadan genel
   internete. Çıkmıyorsa bu bir kusur değil; o host'lar VPN'siz kalır.
2. **MagicDNS adları çözülüyor mu** — host formuna `vds-1` yazılabilir mi,
   yoksa `100.x.y.z` mi gerekir.
3. **Kalkış süresi** — Fortinet'in 4,4 saniyesiyle karşılaştırmak için.
4. **Ephemeral düğümler temizleniyor mu** — `--state=mem:` her kalkışta yeni
   düğüm demek; ephemeral olmayan anahtarla tailnet'te ölü düğüm birikir.
