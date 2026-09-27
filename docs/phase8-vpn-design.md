# Faz 8 — Host bazlı VPN (tasarım önerisi)

**Durum: onay bekliyor. Kod yazılmadı.**

Amaç: Termix sunucusunun tamamını bir VPN'e sokmadan, host (ve pratikte host
grubu) bazında VPN üzerinden bağlanabilmek. Farklı kurumlar, farklı VPN'ler,
aynı Termix.

---

## Neden sunucuyu VPN'e sokmuyoruz

Tek bir ağ isim alanında birden fazla kurumsal VPN yaşayamaz:

- Her biri varsayılan rota dayatır (full tunnel).
- **Alt ağlar çakışır.** İki müşteri de `192.168.1.0/24` kullanıyorsa hiçbir
  yönlendirme kuralı bunu çözmez. Bu, tasarımın belirleyici kısıtıdır.

Dolayısıyla her VPN **kendi ağ isim alanında** çalışmak zorunda.

---

## İki model

### A2 — Bildirilen tüneller (operatör kurar)

Operatör compose'da VPN başına bir sidecar tanımlar: içinde WireGuard/OpenVPN
istemcisi ve bir SOCKS5 kapısı. Termix yalnızca "hangi host hangi tünelden"
bilgisini tutar.

- Termix **hiçbir ayrıcalık istemez**. Tünel ayrı konteynerde.
- Kimlik bilgileri Termix'te durmaz; sidecar'ın kendi yapılandırmasındadır.
- Kullanıcı arayüzü: "Ağ profili" seç. Kimlik bilgisi girilmez.

### A1 — Yönetilen tüneller (Termix kurar)

Kullanıcı host formunda "Use VPN" der, sağlayıcı seçer, bilgilerini girer;
Termix tüneli kendisi kurar.

- Termix'e `NET_ADMIN`, `SYS_ADMIN` ve `/dev/net/tun` gerekir. Bugün konteyner
  **hiçbir ayrıcalık istemiyor**; bu, dağıtım sözleşmesinin değişmesi demek.
- Profil başına ağ isim alanı, içinde VPN istemci süreci ve bir kapı süreci.
- Kimlik bilgileri Termix'te şifreli saklanır.

### Öneri: önce A2, sonra A1

A2'nin tesisatı A1'in **alt kümesi**: profil tablosu, host ataması, bağlantı
anında çözümleme, kapalı düşme, RDP kapsaması. A1 bunun üstüne yalnızca
"tüneli kim kurar" sorusunu ekler.

Böylece değer erken gelir, ayrıcalık gerektiren kısım ayrı bir karara kalır ve
A1 başarısız olsa bile A2 elde kalır.

---

## Veri modeli

`vault_profiles` tablosu birebir emsal: kullanıcıya ait, adı olan, klasör ve
etiket taşıyan bir profil tablosu; host'ta ona referans (`vaultProfileId`).

```
vpn_profiles
  id, userId, name, description, folder, tags
  kind            "declared" | "wireguard" | "openvpn"   (A1'de genişler)
  endpoint        A2: kapı adresi (host:port)
  config          A1: wg conf / ovpn dosyası (şifreli)
  username        A1 (şifreli değil)
  password        A1 (şifreli)
  createdAt, updatedAt

ssh_data
  vpnProfileId    → vpn_profiles.id, ON DELETE SET NULL
```

Şifreli alanlar `field-crypto.ts`'teki tablo bazlı Set'e eklenir — `socks5Password`
ve `streamPassword` orada nasıl duruyorsa öyle.

Üç lehçe için migration, `schema:generate` + `schema:migrations` ile.

### Grup ataması: klasör kalıtımı **yok**

Klasörler `ssh_data.folder` içinde **metin yolu**; satır değil, yeniden
adlandırılabiliyor. Buna kalıtım bağlamak, klasör adı değişince host'ların
sessizce VPN'siz kalması demek olurdu.

Onun yerine: profil host'ta açıkça durur (`vaultProfileId` gibi), arayüzde
**"bu klasördeki tüm host'lara uygula"** toplu işlemi olur. Grup hissi verir,
sessiz kırılma riski taşımaz.

---

## Bağlantı anında çözümleme

Bugün SSH yolları `createSocks5Connection` çağırıp `config.sock` atıyor —
9 dosyada 21 nokta. VPN **yeni bir enjeksiyon noktası eklemez**, aynı yerden
geçer.

Tek bir çözümleyici: host verilir, geriye ya bir soket ya da "doğrudan bağlan"
döner. Proxy ve VPN önceliği burada tek yerde kararlaştırılır.

Fork açısından önemli: temas yüzeyi ne kadar azsa, her upstream sürümünde
birleştirme maliyeti o kadar az. `isFirefoxBrowser` olayı bunun küçük örneğiydi.

### Kapalı düşme

Profil atanmış bir host, tünel kurulamıyorsa **bağlanmaz**. Bu oturumda
düzeltilen `createSocks5Connection` kusurunun aynısının tekrarlanmaması için
çözümleyici "tünel yok" ile "tünel istenmedi" arasında asla aynı değeri
dönmez.

---

## RDP kapsaması

SSH yolları soket enjeksiyonuyla çözülür; RDP çözülmez, çünkü hedefi guacd ve
bizim köprümüz kendisi arıyor. İki seçenek:

1. **Yerel dinleyici.** `rdp-direct/jump-tunnel.ts`'te jump host için yazdığımız
   numaranın aynısı: Termix tünelin içine açılan yerel bir dinleyici kurar,
   guacd/köprüye `127.0.0.1:port` verir. Kod olarak zaten var, genelleştirilecek.
2. **Şeffaf yönlendirme.** Alt ağlar çakışmıyorsa Termix konteynerine statik
   rota eklenir, hiçbir uygulama değişikliği gerekmez. Çakışma varsa kullanılamaz.

Öneri: (1) — çakışan alt ağlarda da çalışır ve mevcut koda yakın.

---

## Etkileşimli kimlik (2FA / SSO)

A1'de kurumsal VPN'lerin çoğu her bağlantıda kod ya da tarayıcı adımı ister.
Emsal yine Termix'in içinde: Vault OIDC akışı zaten bağlanırken etkileşimli
adım çalıştırıyor.

- Tünel **paylaşılır ve referans sayılır**: aynı profile bağlı ikinci host
  mevcut tüneli kullanır.
- Tünel yoksa, host açılırken kullanıcıdan kod istenir.
- Boşta kalınca kapanır.
- **Gece tünel koparsa gözetimsiz geri gelmez.** Bu arayüzde açıkça yazılmalı,
  gizlenmemeli.

WireGuard bu sınıfta değil: etkileşimli adımı yok, gerçekten sorunsuz çalışır.
Bu yüzden A1'in ilk sağlayıcısı WireGuard olmalı.

---

## Çok kullanıcılı sorular (cevaplanmadan kodlanmamalı)

- Tünel kimin kimliğiyle kuruluyor?
- A kullanıcısının kurduğu tüneli B kullanıcısı kullanabilir mi? RBAC ile nasıl
  kesişiyor?
- Profil paylaşılabilir mi, yoksa kullanıcıya mı ait? (`vault_profiles`
  `userId` taşıyor — aynı yolu izlemek tutarlı olur.)

---

## Sağlayıcı gerçekleri

| Sağlayıcı                  | Linux istemcisi           | Gerçekten sorunsuz mu                                               |
| -------------------------- | ------------------------- | ------------------------------------------------------------------- |
| WireGuard                  | `wg-quick` / wireguard-go | Evet                                                                |
| OpenVPN                    | `openvpn`                 | Çoğunlukla; 2FA varyantları karıştırır                              |
| AnyConnect / GlobalProtect | `openconnect`             | SAML yaygın; duruma bağlı                                           |
| Fortinet SSL-VPN           | `openfortivpn`            | SAML SSO, EMS kaydı veya host posture kontrolü varsa **reddedilir** |

Arayüz bunu sağlayıcı bazında dürüstçe göstermeli; tek tip vaat verilmemeli.

---

## Kapsam dışı (bilinçli)

- Site-to-site VPN kurulumu. Bu bir ağ işi, uygulama işi değil.
- Masaüstü (Electron) modunda tünel yönetimi: orada makine zaten VPN'de olur;
  özellik zarifçe devre dışı kalmalı.
- Sunucunun kendi varsayılan rotasını değiştirmek. Hiçbir koşulda.

---

## Doğrulama planı

- Çözümleyici için birim testleri: profil var/yok, tünel var/yok, kapalı düşme.
- `findProxyConfigError` deseninde kaydetme doğrulaması ve testi.
- Gerçek WireGuard sidecar'ıyla uçtan uca: SSH, SFTP, RDP.
- Çakışan alt ağ senaryosu: iki profil, aynı `192.168.1.0/24`, ikisi de çalışmalı.
- Tünel düşürülüp bağlantının **kurulmadığı** doğrulanmalı.

---

## Cevap bekleyen sorular

1. **A2 ile mi başlayalım, doğrudan A1 mi?** Önerim A2.
2. Müşterilerinin iç ağları birbiriyle çakışıyor mu? Şeffaf yönlendirmenin
   masada kalıp kalmadığını bu belirler.
3. Fortinet tarafında SAML SSO / EMS zorlaması var mı? A1'in o sağlayıcıyı
   destekleyip destekleyemeyeceği buna bağlı.
4. Profil kullanıcıya mı ait olacak, paylaşılabilir mi?
