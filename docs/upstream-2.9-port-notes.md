# Upstream 2.9.x: ne değişti, bu fork nereye oturdu

## Upstream'in yaptığı

2.9.x backend'i **eklentilere** böldü. Her işlevsel alan artık kendi
paketi: `plugins/<ad>/` içinde `manifest.json`, kendi tabloları
(`migrations/snapshot.json`), kendi rotaları, kendi yerelleştirmesi ve
kendi testleri. 34 eklenti var — SSH terminali, dosya yöneticisi, docker,
host metrikleri, uzak masaüstü dahil.

İki sonuç bu fork için belirleyiciydi:

1. **Protokole özgü host kolonları `ssh_data`'dan kaldırıldı.** `rdpUser`,
   `vncPassword`, `enableRdp`, portlar — hepsi eklentilerin kendi host
   ayarlarına (`readHostSettings`) taşındı ve protokoller
   `contributes.protocols` ile bildiriliyor.

2. **Bağlantı kurma tek yere toplandı.** `openSshTransport()` artık port
   knock → atlama zinciri → vekil → DNS sırasını tek yerde yapıyor. Ve adı
   **yalnızca bağlantı doğrudanken** çözüyor:

   ```js
   if (via === "direct" && options.resolveDns !== false) {
     await resolveSshConnectConfigHost(config);
   }
   ```

   Bu fork mesh adı hatasını ayrı ayrı düzeltirken aynı sonuca varmıştı;
   upstream'de artık yapısal olarak var.

## Bu fork ne yaptı

VPN **çekirdek yaması olarak** taşındı. Eski yapıda 17 dosyaya dağılmış 56
kanca vardı, çünkü her yol kendi bağlantısını kuruyordu. Yeni yapıda tek
kanca yetiyor: taşıma katmanı çözücüye "bu host nereden çıkmalı?" diye
soruyor, VPN profili ile host'un kendi vekili aynı cevap olarak dönüyor.

**Direct RDP ve stream protokolü dışarıda bırakıldı** — silinmedi. İkisi de
taşınan protokol kolonlarının üzerine kuruluydu; çekirdek yaması yapmak,
upstream'in bilerek sildiğini geri koyup sonra sökmek olurdu. Eklenti
olarak geri gelecekler (`plugins/rdp-direct`, `plugins/stream`). Kaynakları
`backup/pre-2.9.2-merge` dalında duruyor.

## Kanca denetimi

`type-check` temiz olması **hiçbir şey kanıtlamıyordu**: fork'un dosyaları
kendi başlarına derleniyordu ama hiçbiri çağrılmıyordu. İlk denetim 15
kancanın **hepsinin** eksik olduğunu gösterdi. Bu yüzden entegrasyon
adı adına denetlenerek bitirildi:

| nerede                                          | ne                                                   |
| ----------------------------------------------- | ---------------------------------------------------- |
| `schema.ts` (+pg, +mysql)                       | `vpn_profiles` tablosu, `ssh_data.vpn_profile_id`    |
| `db/index.ts`                                   | tablo kurulumu + `addColumnIfNotExists` ile kolonlar |
| `database.ts`                                   | `app.use("/vpn", vpnRoutes)`                         |
| `factory.ts`                                    | `createCurrentVpnProfileRepository`                  |
| `field-crypto.ts`                               | `vpn_profiles` sırları                               |
| `connect/transport.ts`                          | `resolveHostGateway` — **tek kanca**                 |
| `connect/types.ts`                              | `vpnProfileId`                                       |
| `routes/host.ts`                                | alanın borusu + `vpnProfileAssignmentError`          |
| `host-normalizers.ts`                           | yanıt şekli, alıcı listesi, içe alma                 |
| `types/index.ts`, `ui-types.ts`                 | `vpnProfileId`                                       |
| `nginx.conf`, `nginx-https.conf`                | `location ~ ^/vpn`                                   |
| `rail-items.ts`, `AppShell.tsx`                 | VPNs paneli                                          |
| `HostEditorData.ts`, `HostEditorGeneralTab.tsx` | seçici                                               |
| `main-axios.ts`                                 | VPN API'si                                           |
| `locales/en.json`                               | 55 anahtar + `nav.networks`                          |

## Bir ayrıntı: `tailscale` adı

Upstream'de **`tailscale` adında bir eklenti var** ama farklı bir iş
yapıyor: tailnet'i API üzerinden geziyor ve Tailscale SSH oturum
kontrolünü hallediyor, yani Termix makinesinin zaten tailnet'te olduğunu
varsayıyor. Bu fork'unki bir **taşıma yolu**: yönetici konteynerinde
userspace `tailscaled` kaldırıp Termix tailnet'e katılmadan içindeki
host'a erişiyor. İşlevsel çakışma yok.

Ama `scripts/check-core-plugin-ids.cjs` çekirdeğin bir eklenti kimliğini
elle yazmasını yasaklıyor. Sağlayıcı listesi tek bir diziye toplandı ve o
satıra betiğin kendi kaçış işareti konuldu (`plugin-id-ok:`), upstream'in
`totp` için yaptığının aynısı.

## Doğrulama

- `npm run type-check`: 0 hata
- `npx vitest run`: 447 dosya, **3889 test geçti**
- `npm run lint`: 0 hata (130 uyarı upstream'den)
- `npm run schema:check`: üç lehçe tutarlı
- İmajın içi: nginx şablonlarında `^/vpn`, backend'de VPN deposu,
  arayüzde "VPNs" ve sağlayıcı adları, 34 eklenti hem backend hem
  frontend tarafında

Gerçek donanımda VPN denemesi **yapılmadı** — o adım kullanıcıda.
